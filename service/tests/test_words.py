import wave
from pathlib import Path

import numpy as np

from rechiv_engine.models.onnx_transcriber import _ctc_words, _decode_ctc
from rechiv_engine.models.transcription import (
    Word,
    _SegmentingTranscriber,
    assign_words,
    group_intervals,
)

SAMPLE_RATE = 16_000
PIECES = ("▁При", "вет", ",", "▁кол", "леги", ".")
BLANK = len(PIECES)


def _log_probs(labels: list[int]) -> np.ndarray:
    probs = np.full((len(labels), BLANK + 1), -10.0, dtype=np.float32)
    probs[np.arange(len(labels)), labels] = 0.0
    return probs


def test_group_intervals_merges_up_to_span_and_gap() -> None:
    intervals = [(0.0, 3.0), (3.5, 8.0), (8.4, 19.0), (19.5, 22.0), (25.0, 26.0)]

    groups = group_intervals(intervals, max_span_sec=20.0, max_gap_sec=2.0)

    assert groups == [[(0.0, 3.0), (3.5, 8.0), (8.4, 19.0)], [(19.5, 22.0)], [(25.0, 26.0)]]


def test_assign_words_by_middle_and_nearest_interval() -> None:
    words = [Word("а", 0.1, 0.3), Word("б", 1.05, 1.25), Word("в", 2.2, 2.4)]

    buckets = assign_words(words, [(0.0, 1.0), (2.0, 3.0)])

    # «б» серединой в паузе 1.0–2.0, ближе к первому интервалу.
    assert [[w.text for w in b] for b in buckets] == [["а", "б"], ["в"]]


def test_ctc_words_match_decoded_text_and_frames() -> None:
    # Кадры по 0.1 с; точка запаздывает и не растягивает слово.
    labels = [0, BLANK, 1, 2, BLANK, BLANK, 3, 4, BLANK, BLANK, BLANK, 5]
    log_probs = _log_probs(labels)

    words = _ctc_words(log_probs, len(labels), BLANK, PIECES, duration=1.2)
    text = _decode_ctc(log_probs[None], np.asarray([len(labels)]), BLANK, PIECES)[0]

    assert " ".join(w.text for w in words) == text == "Привет, коллеги."
    assert [(w.start, w.end) for w in words] == [(0.0, 0.3), (0.6, 0.8)]


class _FakeWordsEngine(_SegmentingTranscriber):
    def __init__(self, words: list[Word] | None) -> None:
        self.words = words
        self.calls: list[float] = []

    def ensure_model(self) -> None:
        return None

    def _transcribe_file(self, path: Path) -> str | None:
        self.calls.append(_duration(path))
        return "кусок"

    def _transcribe_words(self, path: Path) -> list[Word] | None:
        self.calls.append(_duration(path))
        return self.words


def _duration(path: Path) -> float:
    with wave.open(str(path)) as source:
        return source.getnframes() / source.getframerate()


def _dialogue(tmp_path: Path) -> Path:
    t = np.arange(int(SAMPLE_RATE * 1.0)) / SAMPLE_RATE
    speech = (0.3 * np.sin(2 * np.pi * 200 * t)).astype(np.float32)
    silence = np.zeros(SAMPLE_RATE, dtype=np.float32)
    samples = np.concatenate([speech, silence, speech])
    path = tmp_path / "dialogue.wav"
    with wave.open(str(path), "w") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes((samples * 32767).astype("<i2").tobytes())
    return path


def test_transcribe_recognizes_group_once_and_splits_by_intervals(tmp_path: Path) -> None:
    # Слова от начала склеенного куска (он начинается ~0.0 с).
    engine = _FakeWordsEngine([Word("Привет,", 0.2, 0.6), Word("коллеги.", 2.2, 2.7)])

    segments = engine.transcribe(_dialogue(tmp_path))

    assert len(engine.calls) == 1 and engine.calls[0] > 2.5
    assert [s.text for s in segments] == ["Привет,", "коллеги."]
    assert segments[0].end <= segments[1].start
    assert segments[1].words[0].start > segments[1].start - 0.5


def test_transcribe_falls_back_per_interval_without_words(tmp_path: Path) -> None:
    engine = _FakeWordsEngine(None)

    segments = engine.transcribe(_dialogue(tmp_path))

    assert [s.text for s in segments] == ["кусок", "кусок"]
    assert all(s.words == [] for s in segments)
