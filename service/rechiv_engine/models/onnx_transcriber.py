"""Torch-free GigaAM CTC inference through NumPy and ONNX Runtime."""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort

from .transcription import Segment, _read_mono_pcm, _SegmentingTranscriber

logger = logging.getLogger(__name__)

_MODEL_NAME = "v3_e2e_ctc"
_LOG_FLOOR = np.float32(1e-9)
_LOG_CEILING = np.float32(1e9)


def _htk_mel_filterbank(sample_rate: int, n_fft: int, n_mels: int) -> np.ndarray:
    """Повторяет torchaudio.functional.melscale_fbanks для HTK/norm=None."""
    n_freqs = n_fft // 2 + 1
    all_freqs = np.linspace(0.0, sample_rate // 2, n_freqs, dtype=np.float32)

    mel_min = 0.0
    mel_max = 2595.0 * math.log10(1.0 + (sample_rate // 2) / 700.0)
    mel_points = np.linspace(mel_min, mel_max, n_mels + 2, dtype=np.float32)
    freq_points = np.float32(700.0) * (
        np.power(np.float32(10.0), mel_points / np.float32(2595.0))
        - np.float32(1.0)
    )

    freq_diff = freq_points[1:] - freq_points[:-1]
    slopes = freq_points[None, :] - all_freqs[:, None]
    down_slopes = -slopes[:, :-2] / freq_diff[:-1]
    up_slopes = slopes[:, 2:] / freq_diff[1:]
    return np.maximum(
        np.float32(0.0), np.minimum(down_slopes, up_slopes)
    ).astype(np.float32, copy=False)


class NumpyFeatureExtractor:
    """Эквивалент GigaAM FeatureExtractor для фиксированного CTC-препроцессора."""

    def __init__(
        self,
        *,
        sample_rate: int,
        features: int,
        n_fft: int,
        win_length: int,
        hop_length: int,
        mel_scale: str,
        mel_norm: str | None,
        center: bool,
    ):
        if sample_rate <= 0 or features <= 0 or n_fft <= 0 or hop_length <= 0:
            raise ValueError("preprocessor sizes must be positive")
        if win_length != n_fft:
            raise ValueError("the NumPy preprocessor requires win_length == n_fft")
        if mel_scale != "htk":
            raise ValueError(f"unsupported mel scale: {mel_scale!r}")
        if mel_norm is not None:
            raise ValueError(f"unsupported mel normalization: {mel_norm!r}")
        if center:
            raise ValueError("the NumPy preprocessor requires center=false")

        self.sample_rate = int(sample_rate)
        self.n_mels = int(features)
        self.n_fft = int(n_fft)
        self.win_length = int(win_length)
        self.hop_length = int(hop_length)

        # torch.hann_window(periodic=True) эквивалентен первым N точкам
        # симметричного окна длины N + 1.
        self._window = np.hanning(self.win_length + 1)[:-1].astype(np.float32)
        self._filterbank = _htk_mel_filterbank(
            self.sample_rate, self.n_fft, self.n_mels
        )

    def __call__(self, samples: np.ndarray) -> tuple[np.ndarray, int]:
        samples = np.ascontiguousarray(samples, dtype=np.float32)
        if samples.ndim != 1:
            raise ValueError(f"expected mono samples, got shape {samples.shape}")
        if samples.size < self.n_fft:
            raise ValueError(
                f"audio is too short for one STFT frame: {samples.size} < {self.n_fft}"
            )

        frames = np.lib.stride_tricks.sliding_window_view(samples, self.n_fft)[
            :: self.hop_length
        ]
        windowed = frames * self._window
        spectrum = np.fft.rfft(windowed, n=self.n_fft, axis=-1).astype(
            np.complex64, copy=False
        )
        magnitude = np.abs(spectrum).astype(np.float32, copy=False)
        power = magnitude * magnitude
        mel = power @ self._filterbank
        np.clip(mel, _LOG_FLOOR, _LOG_CEILING, out=mel)
        np.log(mel, out=mel)

        features = np.ascontiguousarray(mel.T, dtype=np.float32)
        return features, features.shape[1]


def log_mel_spectrogram(
    samples: np.ndarray,
    *,
    sample_rate: int = 16_000,
    features: int = 64,
    n_fft: int = 320,
    win_length: int = 320,
    hop_length: int = 160,
    mel_scale: str = "htk",
    mel_norm: str | None = None,
    center: bool = False,
) -> np.ndarray:
    """Вычисляет log-mel [n_mels, frames] с параметрами GigaAM."""
    extractor = NumpyFeatureExtractor(
        sample_rate=sample_rate,
        features=features,
        n_fft=n_fft,
        win_length=win_length,
        hop_length=hop_length,
        mel_scale=mel_scale,
        mel_norm=mel_norm,
        center=center,
    )
    return extractor(samples)[0]


def _resample_linear(
    samples: np.ndarray, source_rate: int, target_rate: int
) -> np.ndarray:
    if source_rate == target_rate:
        return np.ascontiguousarray(samples, dtype=np.float32)
    if source_rate <= 0 or target_rate <= 0:
        raise ValueError("sample rates must be positive")
    if samples.size == 0:
        return np.zeros(0, dtype=np.float32)

    output_size = max(1, int(round(samples.size * target_rate / source_rate)))
    positions = np.arange(output_size, dtype=np.float64) * source_rate / target_rate
    left = np.minimum(positions.astype(np.int64), samples.size - 1)
    right = np.minimum(left + 1, samples.size - 1)
    fraction = (positions - left).astype(np.float32)
    return np.asarray(
        samples[left] * (np.float32(1.0) - fraction) + samples[right] * fraction,
        dtype=np.float32,
    )


def _decode_ctc(
    log_probs: np.ndarray,
    encoded_lengths: np.ndarray,
    blank_id: int,
    pieces: tuple[str, ...],
) -> list[str]:
    labels = np.asarray(log_probs).argmax(axis=-1)
    if labels.ndim != 2:
        raise ValueError(f"expected [batch, time, classes], got {log_probs.shape}")

    batch, steps = labels.shape
    lengths = np.clip(
        np.asarray(encoded_lengths, dtype=np.int64).reshape(-1), 0, steps
    )
    if lengths.size != batch:
        raise ValueError(f"expected {batch} encoded lengths, got {lengths.size}")

    keep = labels != blank_id
    keep[:, 1:] &= labels[:, 1:] != labels[:, :-1]
    keep &= np.arange(steps, dtype=np.int64)[None, :] < lengths[:, None]

    texts: list[str] = []
    for row, mask in zip(labels, keep):
        token_ids = row[mask]
        if token_ids.size and (
            int(token_ids.min()) < 0 or int(token_ids.max()) >= len(pieces)
        ):
            raise ValueError("CTC output contains a token outside the manifest vocabulary")
        text = "".join(pieces[int(token)] for token in token_ids)
        texts.append(text.replace("▁", " ").lstrip())
    return texts


class OnnxTranscriber(_SegmentingTranscriber):
    def __init__(self, model_dir: str, num_threads: int = 6):
        if num_threads <= 0:
            raise ValueError("num_threads must be positive")
        self._model_dir = Path(model_dir).expanduser()
        self._num_threads = num_threads
        self._session: ort.InferenceSession | None = None
        self._feature_extractor: NumpyFeatureExtractor | None = None
        self._pieces: tuple[str, ...] = ()
        self._blank_id = -1
        self._num_classes = -1

    def ensure_model(self) -> None:
        if self._session is not None:
            return

        manifest_path = self._model_dir / f"{_MODEL_NAME}.json"
        with manifest_path.open(encoding="utf-8") as source:
            manifest: dict[str, Any] = json.load(source)

        if manifest.get("model_name") != _MODEL_NAME:
            raise ValueError(
                f"unexpected model in {manifest_path}: "
                f"{manifest.get('model_name')!r}"
            )

        preprocessor = manifest.get("preprocessor")
        if not isinstance(preprocessor, dict):
            raise ValueError(f"missing preprocessor settings in {manifest_path}")
        self._feature_extractor = NumpyFeatureExtractor(**preprocessor)

        pieces = manifest.get("pieces")
        if not isinstance(pieces, list) or not all(
            isinstance(piece, str) for piece in pieces
        ):
            raise ValueError(f"invalid tokenizer pieces in {manifest_path}")
        self._pieces = tuple(pieces)
        self._blank_id = int(manifest["blank_id"])
        self._num_classes = int(manifest["num_classes"])
        if (
            len(self._pieces) != self._blank_id
            or self._num_classes != self._blank_id + 1
        ):
            raise ValueError("manifest has inconsistent CTC vocabulary metadata")

        onnx_file = manifest.get("onnx_file", f"{_MODEL_NAME}.onnx")
        if not isinstance(onnx_file, str) or Path(onnx_file).name != onnx_file:
            raise ValueError(f"invalid ONNX filename in {manifest_path}")

        options = ort.SessionOptions()
        options.intra_op_num_threads = self._num_threads
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._session = ort.InferenceSession(
            str(self._model_dir / onnx_file),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )

        input_names = {node.name for node in self._session.get_inputs()}
        output_names = {node.name for node in self._session.get_outputs()}
        if input_names != {"features", "feature_lengths"} or output_names != {
            "log_probs",
            "encoded_lengths",
        }:
            self._session = None
            raise ValueError(
                f"unexpected ONNX contract: inputs={input_names}, outputs={output_names}"
            )
        logger.info(
            "GigaAM ONNX loaded: model=%s, provider=CPUExecutionProvider, threads=%d",
            _MODEL_NAME,
            self._num_threads,
        )

    def _transcribe_file(self, path: Path) -> str | None:
        self.ensure_model()
        assert self._session is not None
        assert self._feature_extractor is not None

        samples, sample_rate, _, sampwidth = _read_mono_pcm(path)
        if sampwidth != 2:
            raise ValueError(
                f"only 16-bit PCM WAV is supported, got sample width {sampwidth}"
            )
        samples = _resample_linear(
            samples, sample_rate, self._feature_extractor.sample_rate
        )
        features, feature_length = self._feature_extractor(samples)
        log_probs, encoded_lengths = self._session.run(
            ["log_probs", "encoded_lengths"],
            {
                "features": features[None, :, :],
                "feature_lengths": np.asarray([feature_length], dtype=np.int64),
            },
        )
        if log_probs.shape[-1] != self._num_classes:
            raise ValueError(
                f"ONNX emitted {log_probs.shape[-1]} classes, expected {self._num_classes}"
            )
        return _decode_ctc(
            log_probs, encoded_lengths, self._blank_id, self._pieces
        )[0]


__all__ = [
    "NumpyFeatureExtractor",
    "OnnxTranscriber",
    "Segment",
    "log_mel_spectrogram",
]
