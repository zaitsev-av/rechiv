
from __future__ import annotations

import numpy as np

_WINDOW_SEC = 0.03
_NOISE_FACTOR = 3.0
_ABSOLUTE_FLOOR = 0.01
# Страховка от фрагмента из сплошной речи без пауз.
_PEAK_CEILING = 0.35
_SILENCE_HOLD_SEC = 0.35
_PADDING_SEC = 0.2
_MIN_SPEECH_SEC = 0.25
# GigaAM переключается на longform после 25 с.
_MAX_SEGMENT_SEC = 20.0


def _window_levels(samples: np.ndarray, sample_rate: int) -> tuple[np.ndarray, int]:
    window = max(1, int(_WINDOW_SEC * sample_rate))
    usable = len(samples) - (len(samples) % window)
    if usable <= 0:
        return np.zeros(0, dtype=np.float32), window
    frames = samples[:usable].reshape(-1, window)
    return np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=1)), window


def speech_threshold(levels: np.ndarray) -> float:
    """Потолок по пику не даёт принять непрерывную речь за шум и отбросить её."""
    if levels.size == 0:
        return _ABSOLUTE_FLOOR
    noise_floor = float(np.percentile(levels, 20))
    peak = float(np.percentile(levels, 95))
    threshold = max(noise_floor * _NOISE_FACTOR, _ABSOLUTE_FLOOR)
    return min(threshold, max(peak * _PEAK_CEILING, _ABSOLUTE_FLOOR))


def detect_speech_intervals(
    samples: np.ndarray,
    sample_rate: int,
    max_segment_sec: float = _MAX_SEGMENT_SEC,
) -> list[tuple[float, float]]:
    """Интервалы речи в секундах. Пустой список — модель запускать незачем."""
    if sample_rate <= 0 or samples.size == 0:
        return []

    levels, window = _window_levels(samples, sample_rate)
    if levels.size == 0:
        return []

    threshold = speech_threshold(levels)
    window_sec = window / sample_rate
    hold_windows = max(1, int(round(_SILENCE_HOLD_SEC / window_sec)))

    intervals: list[tuple[float, float]] = []
    speech_start: int | None = None
    silence_run = 0

    for index, level in enumerate(levels):
        if level >= threshold:
            if speech_start is None:
                speech_start = index
            silence_run = 0
            continue
        if speech_start is None:
            continue
        silence_run += 1
        if silence_run >= hold_windows:
            intervals.append((speech_start * window_sec, (index - silence_run + 1) * window_sec))
            speech_start = None
            silence_run = 0

    if speech_start is not None:
        intervals.append((speech_start * window_sec, levels.size * window_sec))

    duration = samples.size / sample_rate
    padded = _pad_and_merge(intervals, duration)
    return _limit_length(padded, max_segment_sec)


def _pad_and_merge(
    intervals: list[tuple[float, float]],
    duration: float,
) -> list[tuple[float, float]]:
    merged: list[tuple[float, float]] = []
    for start, end in intervals:
        start = max(0.0, start - _PADDING_SEC)
        end = min(duration, end + _PADDING_SEC)
        if end - start < _MIN_SPEECH_SEC:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            continue
        merged.append((start, end))
    return merged


def _limit_length(
    intervals: list[tuple[float, float]],
    max_segment_sec: float,
) -> list[tuple[float, float]]:
    if max_segment_sec <= 0:
        return intervals
    limited: list[tuple[float, float]] = []
    for start, end in intervals:
        while end - start > max_segment_sec:
            limited.append((start, start + max_segment_sec))
            start += max_segment_sec
        limited.append((start, end))
    return limited
