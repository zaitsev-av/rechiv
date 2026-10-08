#!/usr/bin/env python3
"""Сравнивает ONNX-движок с эталоном torch на фрагментах сессии.

Сессию записывайте с `task run KEEP_AUDIO=1`, иначе WAV не переживут финализацию.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

_SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVICE_DIR))

from rechiv_engine.models.onnx_transcriber import OnnxTranscriber  # noqa: E402

_DEFAULT_MODEL_DIR = _SERVICE_DIR.parent / "build" / "onnx"


def _sessions_root() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Rechiv" / "sessions"
    return Path.home() / ".rechiv" / "sessions"


def levenshtein(left: str, right: str) -> int:
    if left == right:
        return 0
    previous = list(range(len(right) + 1))
    for i, symbol in enumerate(left, 1):
        current = [i]
        for j, other in enumerate(right, 1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (symbol != other),
                )
            )
        previous = current
    return previous[-1]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--session",
        type=Path,
        help="каталог сессии; по умолчанию самая свежая с сохранённым аудио",
    )
    parser.add_argument("--model-dir", type=Path, default=_DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--reference",
        default="jobs",
        help=(
            "эталон: 'jobs' — текст из метаданных сессии (движок, который её записал), "
            "'torch' — прогнать PyTorch заново, либо путь к каталогу ONNX-модели"
        ),
    )
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument(
        "--show", type=int, default=12, help="сколько расхождений напечатать"
    )
    return parser.parse_args()


def _latest_session_with_audio() -> Path | None:
    candidates = []
    for session in _sessions_root().glob("*/jobs"):
        if any(
            os.path.exists(json.loads(job.read_text(encoding="utf-8")).get("wavPath", ""))
            for job in session.glob("*.json")
        ):
            candidates.append(session.parent)
    return max(candidates, key=lambda p: p.stat().st_mtime, default=None)


def _reference_engine(reference: str, threads: int):
    """Движок для эталона, либо None — тогда эталон берётся из метаданных сессии."""
    if reference == "jobs":
        return None
    if reference == "torch":
        # Импорт здесь: torch нужен только этому режиму и только в разработке.
        from rechiv_engine.models.transcriber import Transcriber

        return Transcriber(model_name="v3_e2e_ctc", num_threads=threads, device="auto")
    return OnnxTranscriber(model_dir=reference, num_threads=threads)


def main() -> int:
    args = _parse_args()
    session = args.session or _latest_session_with_audio()
    if session is None:
        print(
            "Не нашёл сессию с сохранённым аудио. "
            "Запиши созвон командой `task run KEEP_AUDIO=1`.",
            file=sys.stderr,
        )
        return 1

    jobs = sorted((session / "jobs").glob("*.json"))
    engine = OnnxTranscriber(model_dir=str(args.model_dir), num_threads=args.threads)
    load_started = time.monotonic()
    engine.ensure_model()
    reference_engine = _reference_engine(args.reference, args.threads)
    if reference_engine is not None:
        reference_engine.ensure_model()
    print(f"сессия: {session.name}")
    print(f"эталон: {args.reference}")
    print(f"загрузка ONNX-сессии: {time.monotonic() - load_started:.1f} с\n")

    exact = compared = total_chars = total_errors = 0
    total_audio = total_wall = 0.0
    mismatches: list[tuple[str, str, str, int]] = []

    for path in jobs:
        job = json.loads(path.read_text(encoding="utf-8"))
        wav = job.get("wavPath", "")
        if not os.path.exists(wav):
            continue
        if reference_engine is None:
            reference = " ".join(s["text"] for s in (job.get("segments") or [])).strip()
        else:
            reference = " ".join(
                segment.text for segment in reference_engine.transcribe(Path(wav))
            ).strip()

        started = time.monotonic()
        segments = engine.transcribe(Path(wav))
        total_wall += time.monotonic() - started

        produced = " ".join(segment.text for segment in segments).strip()
        total_audio += job.get("duration", 0.0)
        compared += 1
        distance = levenshtein(reference, produced)
        total_chars += len(reference)
        total_errors += distance
        if distance == 0:
            exact += 1
        else:
            mismatches.append((os.path.basename(wav), reference, produced, distance))

    if compared == 0:
        print("В сессии не осталось WAV-файлов для сравнения.", file=sys.stderr)
        return 1

    print(f"сравнено фрагментов: {compared}")
    print(f"совпало посимвольно: {exact} ({100 * exact / compared:.0f}%)")
    print(
        f"CER относительно эталона: {100 * total_errors / max(1, total_chars):.2f}% "
        f"({total_errors} правок на {total_chars} символов)"
    )
    print(f"скорость: {total_audio / max(1e-9, total_wall):.1f}x реального времени")
    print(f"  аудио {total_audio:.1f} с, обработка {total_wall:.1f} с")

    if mismatches:
        print(f"\nрасхождения ({len(mismatches)}):")
        for name, reference, produced, distance in mismatches[: args.show]:
            print(f"\n  {name}  правок: {distance}")
            print(f"    эталон:   {reference}")
            print(f"    проверка: {produced}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
