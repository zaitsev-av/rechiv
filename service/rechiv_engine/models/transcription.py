
from __future__ import annotations

import gc
import logging
import re
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .vad import detect_speech_intervals

logger = logging.getLogger(__name__)

_MIN_TEXT_LEN = 2
_PUNCT_ONLY_RE = re.compile(r'^[\s.,!?\-…:;«»"\'()]+$')
# Соседние интервалы распознаются одним куском: резка по каждой паузе теряет края слов
# и контекст. Предел ниже порога longform GigaAM (25 с).
_MAX_SPAN_SEC = 20.0
# Через долгую тишину контекста нет, а шум перед ней модель склеивает со следующим словом.
_MAX_GAP_SEC = 2.0


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Segment:
    text: str
    start: float
    end: float
    words: list[Word] = field(default_factory=list)


def _is_meaningful(text: str) -> bool:
    stripped = text.strip()
    if len(stripped) < _MIN_TEXT_LEN:
        return False
    return not _PUNCT_ONLY_RE.match(stripped)


def _extract_text(result: object) -> str | None:
    text = getattr(result, "text", result)
    if text is None:
        return None
    return text if isinstance(text, str) else str(text)


def _read_mono_pcm(wav_path: Path) -> tuple[np.ndarray, int, int, int]:
    """Читает 16-bit WAV как mono float32 в диапазоне [-1, 1]."""
    with wave.open(str(wav_path)) as source:
        sample_rate = source.getframerate()
        n_channels = source.getnchannels()
        sampwidth = source.getsampwidth()
        raw = source.readframes(source.getnframes())

    if sampwidth != 2:
        # Нестандартная разрядность: VAD пропускаем, отдаём всё одним куском.
        return np.zeros(0, dtype=np.float32), sample_rate, n_channels, sampwidth

    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if n_channels > 1:
        usable = len(samples) - (len(samples) % n_channels)
        samples = samples[:usable].reshape(-1, n_channels).mean(axis=1)
    return samples, sample_rate, n_channels, sampwidth


def group_intervals(
    intervals: list[tuple[float, float]],
    max_span_sec: float = _MAX_SPAN_SEC,
    max_gap_sec: float = _MAX_GAP_SEC,
) -> list[list[tuple[float, float]]]:
    groups: list[list[tuple[float, float]]] = []
    for interval in intervals:
        if (
            groups
            and interval[1] - groups[-1][0][0] <= max_span_sec
            and interval[0] - groups[-1][-1][1] <= max_gap_sec
        ):
            groups[-1].append(interval)
        else:
            groups.append([interval])
    return groups


def assign_words(
    words: list[Word], intervals: list[tuple[float, float]]
) -> list[list[Word]]:
    """Слово уходит в интервал по своей середине; из паузы — в ближайший."""
    buckets: list[list[Word]] = [[] for _ in intervals]
    for word in words:
        middle = (word.start + word.end) / 2
        index = min(
            range(len(intervals)),
            key=lambda i: max(intervals[i][0] - middle, middle - intervals[i][1], 0.0),
        )
        buckets[index].append(word)
    return buckets


class _SegmentingTranscriber:

    def ensure_model(self) -> object:
        raise NotImplementedError

    def _transcribe_file(self, path: Path) -> str | None:
        raise NotImplementedError

    def _transcribe_words(self, path: Path) -> list[Word] | None:
        """Слова с таймингами от начала файла; None — движок их не умеет."""
        return None

    def transcribe(self, wav_path: Path) -> list[Segment]:
        """Тишина не доходит до модели; неподдерживаемый PCM обрабатывается целиком."""
        samples, sample_rate, _, sampwidth = _read_mono_pcm(wav_path)
        duration = self._get_duration(wav_path)

        try:
            intervals = detect_speech_intervals(samples, sample_rate)
            if not intervals:
                if sampwidth == 2:
                    logger.debug("no speech in %s (%.1fs), skipping", wav_path.name, duration)
                    return []
                intervals = [(0.0, duration)]

            logger.debug(
                "%s: %.1fs → %d speech interval(s)", wav_path.name, duration, len(intervals)
            )
            self.ensure_model()
            return self._transcribe_intervals(wav_path, samples, sample_rate, intervals)
        finally:
            gc.collect()

    def _transcribe_intervals(
        self,
        wav_path: Path,
        samples: np.ndarray,
        sample_rate: int,
        intervals: list[tuple[float, float]],
    ) -> list[Segment]:
        # Без декодированного PCM нельзя нарезать файл на интервалы.
        if len(intervals) == 1 and samples.size == 0:
            return self._transcribe_one(wav_path, intervals[0][0], intervals[0][1])

        segments: list[Segment] = []
        parts: list[Path] = []
        try:
            for index, group in enumerate(group_intervals(intervals)):
                start, end = group[0][0], group[-1][1]
                part_path = wav_path.with_name(f"{wav_path.stem}_seg{index:03d}.wav")
                parts.append(part_path)
                self._write_part(part_path, samples, sample_rate, start, end)
                words = self._transcribe_words(part_path)
                if words is None:
                    segments.extend(self._transcribe_per_interval(
                        wav_path, samples, sample_rate, group, parts))
                    continue
                shifted = [Word(w.text, w.start + start, w.end + start) for w in words]
                for (seg_start, seg_end), bucket in zip(group, assign_words(shifted, group)):
                    text = " ".join(w.text for w in bucket)
                    if bucket and _is_meaningful(text):
                        segments.append(Segment(text=text, start=seg_start, end=seg_end, words=bucket))
        finally:
            for part in parts:
                part.unlink(missing_ok=True)
        return segments

    def _transcribe_per_interval(
        self,
        wav_path: Path,
        samples: np.ndarray,
        sample_rate: int,
        intervals: list[tuple[float, float]],
        parts: list[Path],
    ) -> list[Segment]:
        segments: list[Segment] = []
        for start, end in intervals:
            part_path = wav_path.with_name(f"{wav_path.stem}_part{len(parts):03d}.wav")
            parts.append(part_path)
            self._write_part(part_path, samples, sample_rate, start, end)
            segments.extend(self._transcribe_one(part_path, start, end))
        return segments

    def _transcribe_one(self, path: Path, start: float, end: float) -> list[Segment]:
        text = self._transcribe_file(path)
        if text and _is_meaningful(text):
            return [Segment(text=text.strip(), start=start, end=end)]
        return []

    @staticmethod
    def _write_part(
        path: Path,
        samples: np.ndarray,
        sample_rate: int,
        start: float,
        end: float,
    ) -> None:
        begin = max(0, int(start * sample_rate))
        finish = min(samples.size, int(end * sample_rate))
        chunk = np.clip(samples[begin:finish], -1.0, 1.0)
        with wave.open(str(path), "w") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            output.writeframes((chunk * 32767.0).astype("<i2").tobytes())

    @staticmethod
    def _get_duration(wav_path: Path) -> float:
        """Длительность в секундах; 0 при ошибке чтения."""
        try:
            with wave.open(str(wav_path)) as source:
                return source.getnframes() / source.getframerate()
        except Exception:
            return 0.0
