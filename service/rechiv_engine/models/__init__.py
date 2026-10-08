"""Ленивые импорты не загружают torch при выборе ONNX."""

from .transcription import Segment

__all__ = ["OnnxTranscriber", "Segment", "Transcriber"]


def __getattr__(name: str):
    if name == "Transcriber":
        from .transcriber import Transcriber

        return Transcriber
    if name == "OnnxTranscriber":
        from .onnx_transcriber import OnnxTranscriber

        return OnnxTranscriber
    raise AttributeError(name)
