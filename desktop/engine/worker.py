#!/usr/bin/env python3
"""stdout зарезервирован под JSONL-протокол; диагностика идёт в stderr."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path


def _development_service_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "service"


def _configure_import_path(service_dir: str | None) -> None:
    candidate = Path(service_dir).expanduser() if service_dir else _development_service_dir()
    if candidate.is_dir():
        sys.path.insert(0, str(candidate))


def _write(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-dir")
    parser.add_argument("--model", default="v3_e2e_ctc")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--engine", choices=("onnx", "torch"), default="onnx")
    parser.add_argument("--onnx-model-dir", help="каталог с ONNX-моделью и манифестом")
    args = parser.parse_args()

    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    _configure_import_path(args.service_dir)

    # Ленивый импорт не загружает тяжёлый torch при выборе ONNX.
    if args.engine == "onnx":
        if not args.onnx_model_dir:
            raise SystemExit("--engine onnx требует --onnx-model-dir")
        from rechiv_engine.models.onnx_transcriber import OnnxTranscriber

        transcriber = OnnxTranscriber(
            model_dir=args.onnx_model_dir,
            num_threads=args.threads,
        )
    else:
        from rechiv_engine.models.transcriber import Transcriber

        transcriber = Transcriber(
            model_name=args.model,
            num_threads=args.threads,
            device=args.device,
        )
    logging.info(
        "GigaAM worker started (engine=%s); model will be loaded on first request",
        args.engine,
    )

    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = str(request.get("id", ""))
            action = request.get("action")
            if action == "ping":
                _write({"id": request_id, "segments": []})
                continue
            if action == "warmup":
                # Прогрев во время записи избавляет первую реплику от ожидания загрузки модели.
                transcriber.ensure_model()
                _write({"id": request_id, "segments": []})
                continue
            if action != "transcribe":
                raise ValueError(f"unsupported action: {action}")

            audio_path = Path(request["audioPath"])
            segments = transcriber.transcribe(audio_path)
            _write(
                {
                    "id": request_id,
                    "segments": [
                        {"text": segment.text, "start": segment.start, "end": segment.end}
                        for segment in segments
                    ],
                }
            )
        except Exception as exc:
            logging.exception("Transcription request failed")
            _write(
                {
                    "id": str(locals().get("request_id", "")),
                    "segments": [],
                    "error": str(exc),
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
