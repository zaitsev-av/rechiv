from __future__ import annotations

import gc
import json
import wave
from pathlib import Path

import numpy as np
import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = PROJECT_ROOT / "build" / "onnx"
MODEL_PATH = MODEL_DIR / "v3_e2e_ctc.onnx"
MANIFEST_PATH = MODEL_DIR / "v3_e2e_ctc.json"

if not MODEL_PATH.is_file() or not MANIFEST_PATH.is_file():
    pytest.skip(
        "exported GigaAM model is absent; run service/tools/export_onnx.py",
        allow_module_level=True,
    )

import torch
from gigaam.preprocess import FeatureExtractor

from rechiv_engine.models.onnx_transcriber import (
    OnnxTranscriber,
    log_mel_spectrogram,
)
from rechiv_engine.models.transcriber import Transcriber
from rechiv_engine.models.vad import detect_speech_intervals


def _preprocessor_config() -> dict[str, object]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return manifest["preprocessor"]


def _speech_like_signal(duration: float, sample_rate: int = 16_000) -> np.ndarray:
    """Детерминированный широкополосный сигнал с речеподобной огибающей."""
    size = int(duration * sample_rate)
    time = np.arange(size, dtype=np.float64) / sample_rate
    fundamental = 125.0 + 35.0 * np.sin(2.0 * np.pi * 0.7 * time)
    phase = np.cumsum(2.0 * np.pi * fundamental / sample_rate)
    carrier = (
        np.sin(phase)
        + 0.45 * np.sin(2.0 * phase + 0.2)
        + 0.2 * np.sin(3.0 * phase + 0.6)
    )
    envelope = 0.15 + 0.85 * np.square(
        np.maximum(0.0, np.sin(2.0 * np.pi * 3.2 * time))
    )
    noise = np.random.default_rng(20260731).normal(0.0, 0.035, size)
    return np.asarray(0.22 * carrier * envelope + noise, dtype=np.float32)


def _write_wav(path: Path, samples: np.ndarray, sample_rate: int = 16_000) -> None:
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "w") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())


def test_numpy_features_match_gigaam_feature_extractor() -> None:
    config = _preprocessor_config()
    torch_extractor = FeatureExtractor(**config)
    maximum_error = 0.0

    for seed, length in enumerate((320, 479, 480, 1_600, 16_000, 31_999), start=1):
        samples = np.random.default_rng(seed).uniform(-1.0, 1.0, length).astype(np.float32)
        numpy_features = log_mel_spectrogram(samples, **config)
        with torch.inference_mode():
            torch_features, torch_lengths = torch_extractor(
                torch.from_numpy(samples).unsqueeze(0),
                torch.tensor([length], dtype=torch.int64),
            )
        expected = torch_features[0].numpy()

        assert numpy_features.shape == expected.shape
        assert numpy_features.shape[1] == int(torch_lengths[0])
        maximum_error = max(
            maximum_error,
            float(np.max(np.abs(numpy_features - expected))),
        )

    print(f"maximum log-mel absolute error: {maximum_error:.9g}")
    assert maximum_error < 1e-4


def test_onnx_transcriber_text_matches_torch(tmp_path: Path) -> None:
    wav_path = tmp_path / "equivalence.wav"
    samples = np.concatenate(
        [
            np.zeros(4_000, dtype=np.float32),
            _speech_like_signal(3.5),
            np.zeros(8_000, dtype=np.float32),
        ]
    )
    assert detect_speech_intervals(samples, 16_000)
    _write_wav(wav_path, samples)

    torch_transcriber = Transcriber(
        model_name="v3_e2e_ctc", num_threads=6, device="cpu"
    )
    torch_segments = torch_transcriber.transcribe(wav_path)
    assert torch_transcriber._model is not None
    torch_texts = [segment.text for segment in torch_segments]
    del torch_transcriber, torch_segments
    gc.collect()

    onnx_transcriber = OnnxTranscriber(str(MODEL_DIR), num_threads=6)
    onnx_texts = [segment.text for segment in onnx_transcriber.transcribe(wav_path)]
    assert onnx_transcriber._session is not None

    print(f"torch text: {torch_texts!r}")
    print(f"onnx text:  {onnx_texts!r}")
    assert onnx_texts == torch_texts
