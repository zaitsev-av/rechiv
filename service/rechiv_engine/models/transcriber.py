import logging
from pathlib import Path
from typing import Protocol, cast

import torch

from .transcription import (
    Segment,
    _extract_text,
    _is_meaningful,
    _read_mono_pcm,
    _SegmentingTranscriber,
)

logger = logging.getLogger(__name__)


class _ASRModel(Protocol):
    def transcribe(self, wav_file: str) -> object: ...


def _resolve_device(device: str) -> str:
    if device != "auto":
        return device
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class Transcriber(_SegmentingTranscriber):
    def __init__(self, model_name: str = "v3_e2e_rnnt", num_threads: int = 2, device: str = "auto"):
        self._model_name = model_name
        self._model: _ASRModel | None = None
        self._num_threads = num_threads
        self._device = _resolve_device(device)

    def ensure_model(self) -> _ASRModel:
        if self._model is None:
            if self._device == "cpu":
                # Ограничиваем потоки PyTorch — иначе забирает все ядра CPU
                torch.set_num_threads(self._num_threads)
                try:
                    torch.set_num_interop_threads(self._num_threads)
                except RuntimeError:
                    # PyTorch запрещает менять inter-op pool после первого parallel op.
                    logger.debug("PyTorch inter-op thread pool is already initialized")
            import gigaam
            loaded_model = gigaam.load_model(self._model_name, device=self._device)
            if not callable(getattr(loaded_model, "transcribe", None)):
                raise TypeError(f"GigaAM model {self._model_name!r} is not an ASR model")
            self._model = cast(_ASRModel, loaded_model)
            logger.info(
                "GigaAM loaded: model=%s, device=%s, torch_threads=%d",
                self._model_name, self._device, torch.get_num_threads(),
            )
        return self._model

    def _transcribe_file(self, path: Path) -> str | None:
        model = self.ensure_model()
        return _extract_text(model.transcribe(str(path)))
