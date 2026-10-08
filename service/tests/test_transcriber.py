import struct
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np

from rechiv_engine.models.transcriber import Segment, Transcriber, _is_meaningful
from rechiv_engine.models.vad import detect_speech_intervals, speech_threshold

SAMPLE_RATE = 16_000


def _speech(duration_sec: float, amplitude: float = 0.3) -> np.ndarray:
    """Похожий на речь сигнал: тон 200 Гц с шумом."""
    t = np.linspace(0.0, duration_sec, int(SAMPLE_RATE * duration_sec), endpoint=False)
    rng = np.random.default_rng(42)
    tone = np.sin(2 * np.pi * 200 * t) * amplitude
    return (tone + rng.normal(0.0, amplitude / 10, t.size)).astype(np.float32)


def _silence(duration_sec: float) -> np.ndarray:
    return np.zeros(int(SAMPLE_RATE * duration_sec), dtype=np.float32)


def _write_wav(path: Path, samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> None:
    with wave.open(str(path), "w") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes((np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes())


def _create_silent_wav(path: Path, duration_sec: float = 1.0) -> None:
    frame_count = int(SAMPLE_RATE * duration_sec)
    with wave.open(str(path), "w") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(struct.pack(f"<{frame_count}h", *([0] * frame_count)))


def _transcriber_with_model(text: str = "Привет, коллеги!") -> tuple[Transcriber, MagicMock]:
    model = MagicMock()
    model.transcribe.return_value = SimpleNamespace(text=text)
    transcriber = Transcriber(model_name="test_model")
    transcriber._model = model
    return transcriber, model


def test_segment_dataclass() -> None:
    segment = Segment(text="hello", start=0.0, end=1.5)

    assert segment.text == "hello"
    assert segment.start == 0.0
    assert segment.end == 1.5


def test_transcriber_loads_model_lazily() -> None:
    transcriber = Transcriber(model_name="test_model")

    assert transcriber._model_name == "test_model"
    assert transcriber._model is None


def test_transcribe_returns_meaningful_segment(tmp_path: Path) -> None:
    audio_path = tmp_path / "chunk.wav"
    _write_wav(audio_path, _speech(1.0))
    transcriber, model = _transcriber_with_model()

    segments = transcriber.transcribe(audio_path)

    assert len(segments) == 1
    assert segments[0].text == "Привет, коллеги!"
    model.transcribe.assert_called_once()


def test_transcribe_discards_punctuation_only_result(tmp_path: Path) -> None:
    audio_path = tmp_path / "chunk.wav"
    _write_wav(audio_path, _speech(1.0))
    transcriber, _ = _transcriber_with_model(text="...?!")

    assert transcriber.transcribe(audio_path) == []


def test_transcribe_skips_silence_without_calling_model(tmp_path: Path) -> None:
    """Главный выигрыш VAD: на созвоне молчащие потоки не доходят до GigaAM."""
    audio_path = tmp_path / "silence.wav"
    _create_silent_wav(audio_path, duration_sec=20.0)
    transcriber, model = _transcriber_with_model()

    assert transcriber.transcribe(audio_path) == []
    model.transcribe.assert_not_called()


def test_transcribe_splits_speech_into_timed_segments(tmp_path: Path) -> None:
    """Раньше весь фрагмент получал один таймкод; теперь — по реплике на паузу."""
    audio_path = tmp_path / "dialogue.wav"
    _write_wav(
        audio_path,
        np.concatenate([_speech(1.5), _silence(2.0), _speech(1.5), _silence(1.0)]),
    )
    transcriber, model = _transcriber_with_model()

    segments = transcriber.transcribe(audio_path)

    assert len(segments) == 2
    assert model.transcribe.call_count == 2
    first, second = segments
    assert first.start < first.end <= second.start < second.end
    # Вторая реплика начинается около 3.5 с, а не с нуля.
    assert 3.0 < second.start < 4.0


def test_transcribe_keeps_segments_within_longform_threshold(tmp_path: Path) -> None:
    audio_path = tmp_path / "long.wav"
    _write_wav(audio_path, _speech(46.0))
    transcriber, _ = _transcriber_with_model()

    segments = transcriber.transcribe(audio_path)

    assert len(segments) >= 3
    # GigaAM переключается на longform после 25 с — сегменты должны быть короче.
    assert all(segment.end - segment.start <= 20.0 + 1e-6 for segment in segments)


def test_meaningful_text_filter() -> None:
    assert _is_meaningful("Да")
    assert not _is_meaningful("")
    assert not _is_meaningful("…")


def test_detect_speech_intervals_on_silence() -> None:
    assert detect_speech_intervals(_silence(5.0), SAMPLE_RATE) == []


def test_detect_speech_intervals_finds_two_phrases() -> None:
    samples = np.concatenate([_silence(0.5), _speech(1.0), _silence(1.5), _speech(1.0)])

    intervals = detect_speech_intervals(samples, SAMPLE_RATE)

    assert len(intervals) == 2
    assert intervals[0][0] < intervals[0][1] < intervals[1][0] < intervals[1][1]


def test_detect_speech_intervals_merges_short_pauses() -> None:
    # Пауза 0.2 с внутри фразы не должна её разрывать.
    samples = np.concatenate([_speech(1.0), _silence(0.2), _speech(1.0)])

    assert len(detect_speech_intervals(samples, SAMPLE_RATE)) == 1


def test_detect_speech_intervals_handles_empty_input() -> None:
    assert detect_speech_intervals(np.zeros(0, dtype=np.float32), SAMPLE_RATE) == []
    assert detect_speech_intervals(_speech(1.0), 0) == []


def test_speech_threshold_adapts_to_noise_floor() -> None:
    quiet = speech_threshold(np.full(100, 0.001, dtype=np.float32))
    noisy = speech_threshold(np.full(100, 0.05, dtype=np.float32))

    # На шумном микрофоне порог обязан подняться, иначе шум примут за речь.
    assert noisy > quiet
