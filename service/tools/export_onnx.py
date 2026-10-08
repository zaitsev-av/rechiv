#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path

import gigaam
import torch

MODEL_NAME = "v3_e2e_ctc"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIR = PROJECT_ROOT / "build" / "onnx"
PREPROCESSOR_KEYS = (
    "sample_rate",
    "features",
    "n_fft",
    "win_length",
    "hop_length",
    "mel_scale",
    "mel_norm",
    "center",
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export GigaAM v3_e2e_ctc to fp32 ONNX with a JSON manifest."
    )
    parser.add_argument(
        "output_dir",
        nargs="?",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"output directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    return parser.parse_args()


def _build_manifest(model: object) -> dict[str, object]:
    cfg = model.cfg  # type: ignore[attr-defined]
    preprocessor = {key: cfg.preprocessor.get(key) for key in PREPROCESSOR_KEYS}

    tokenizer = model.decoding.tokenizer  # type: ignore[attr-defined]
    sentencepiece = tokenizer.model
    pieces = [sentencepiece.IdToPiece(index) for index in range(len(tokenizer))]

    blank_id = int(model.decoding.blank_id)  # type: ignore[attr-defined]
    num_classes = int(cfg.head.num_classes)
    if len(pieces) != blank_id or num_classes != blank_id + 1:
        raise ValueError(
            "inconsistent CTC vocabulary: "
            f"pieces={len(pieces)}, blank_id={blank_id}, num_classes={num_classes}"
        )

    return {
        "model_name": MODEL_NAME,
        "onnx_file": f"{MODEL_NAME}.onnx",
        "preprocessor": preprocessor,
        "blank_id": blank_id,
        "num_classes": num_classes,
        "pieces": pieces,
    }


def main() -> None:
    args = _parse_args()
    output_dir = args.output_dir.expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    model = gigaam.load_model(MODEL_NAME, device="cpu")
    model.to_onnx(str(output_dir), dtype=torch.float32)

    manifest_path = output_dir / f"{MODEL_NAME}.json"
    manifest_path.write_text(
        json.dumps(_build_manifest(model), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Saved runtime manifest to {manifest_path}.")


if __name__ == "__main__":
    main()
