#!/usr/bin/env python3
"""Собирает int8- или fp16-вариант экспортированной ONNX-модели GigaAM."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.quantization.quant_utils import (
    compute_data_quant_params,
    quantize_onnx_initializer,
)
from onnxruntime.quantization.shape_inference import quant_pre_process


MODEL_NAME = "v3_e2e_ctc"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SOURCE_DIR = PROJECT_ROOT / "build" / "onnx"

# Входные conv чувствительны к диапазону log-mel, а conv головы определяет argmax:
# оставляем их во float32 ради точности.
SENSITIVE_CONV_NODES = (
    "/encoder/pre_encode/conv.0/Conv",
    "/encoder/pre_encode/conv.2/Conv",
    "/head/decoder_layers/decoder_layers.0/Conv",
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source_dir",
        nargs="?",
        type=Path,
        default=DEFAULT_SOURCE_DIR,
        help=f"directory with the fp32 export (default: {DEFAULT_SOURCE_DIR})",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="output directory (default: build/onnx-<variant>)",
    )
    parser.add_argument(
        "--variant",
        choices=("int8", "fp16"),
        required=True,
        help="model precision to build",
    )
    parser.add_argument(
        "--quantize-all-convs",
        action="store_true",
        help="quantize every Conv, including the precision-sensitive ones",
    )
    return parser.parse_args()


def _load_manifest(source_dir: Path) -> tuple[Path, dict[str, Any]]:
    manifest_path = source_dir / f"{MODEL_NAME}.json"
    with manifest_path.open(encoding="utf-8") as source:
        manifest: dict[str, Any] = json.load(source)

    onnx_file = manifest.get("onnx_file")
    if not isinstance(onnx_file, str) or Path(onnx_file).name != onnx_file:
        raise ValueError(f"invalid ONNX filename in {manifest_path}: {onnx_file!r}")

    model_path = source_dir / onnx_file
    if not model_path.is_file():
        raise FileNotFoundError(f"source ONNX model does not exist: {model_path}")
    return model_path, manifest


def _quantize_conv_weights_as_qdq(
    model: onnx.ModelProto, keep_float: frozenset[str] = frozenset()
) -> int:
    """Store Conv weights as per-channel int8 while retaining float Conv kernels."""
    initializers = {
        initializer.name: initializer for initializer in model.graph.initializer
    }
    replacements: dict[str, str] = {}
    removed_initializers: set[str] = set()
    new_initializers: list[onnx.TensorProto] = []
    new_nodes: list[onnx.NodeProto] = []
    quantized_convs = 0

    for node in model.graph.node:
        if node.op_type != "Conv" or len(node.input) < 2:
            new_nodes.append(node)
            continue
        if node.name in keep_float:
            new_nodes.append(node)
            continue

        weight_name = node.input[1]
        if weight_name in replacements:
            node.input[1] = replacements[weight_name]
            quantized_convs += 1
            new_nodes.append(node)
            continue

        weight = initializers.get(weight_name)
        if weight is None or weight.data_type != TensorProto.FLOAT:
            new_nodes.append(node)
            continue

        weight_data = numpy_helper.to_array(weight)
        if weight_data.ndim < 1:
            new_nodes.append(node)
            continue

        zero_points: list[np.ndarray] = []
        scales: list[np.ndarray] = []
        for channel in range(weight_data.shape[0]):
            zero_point, scale = compute_data_quant_params(
                weight_data.take(channel, axis=0).ravel(),
                TensorProto.INT8,
                symmetric=True,
                reduce_range=False,
            )
            zero_points.append(zero_point)
            scales.append(scale)

        zero_point_data = np.asarray(zero_points, dtype=np.int8).reshape(-1)
        scale_data = np.asarray(scales, dtype=np.float32).reshape(-1)
        quantized_name = f"{weight_name}_quantized"
        scale_name = f"{weight_name}_scale"
        zero_point_name = f"{weight_name}_zero_point"
        dequantized_name = f"{weight_name}_dequantized"

        new_initializers.extend(
            (
                quantize_onnx_initializer(
                    weight,
                    TensorProto.INT8,
                    zero_point_data,
                    scale_data,
                    axis=0,
                    quant_weight_name=quantized_name,
                ),
                numpy_helper.from_array(scale_data, scale_name),
                numpy_helper.from_array(zero_point_data, zero_point_name),
            )
        )
        new_nodes.append(
            helper.make_node(
                "DequantizeLinear",
                (quantized_name, scale_name, zero_point_name),
                (dequantized_name,),
                name=f"{weight_name}_DequantizeLinear",
                axis=0,
            )
        )
        replacements[weight_name] = dequantized_name
        removed_initializers.add(weight_name)
        node.input[1] = dequantized_name
        quantized_convs += 1
        new_nodes.append(node)

    retained_initializers = [
        initializer
        for initializer in model.graph.initializer
        if initializer.name not in removed_initializers
    ]
    del model.graph.initializer[:]
    model.graph.initializer.extend(retained_initializers)
    model.graph.initializer.extend(new_initializers)
    del model.graph.node[:]
    model.graph.node.extend(new_nodes)
    return quantized_convs


def _build_int8(
    source_path: Path,
    destination_path: Path,
    temp_dir: Path,
    keep_float: frozenset[str] = frozenset(),
) -> None:
    preprocessed_path = temp_dir / "preprocessed.onnx"
    dynamic_output = temp_dir / "dynamic.onnx"
    temporary_output = temp_dir / destination_path.name

    print("Running ONNX Runtime quantization pre-processing...", flush=True)
    quant_pre_process(
        input_model=source_path,
        output_model_path=preprocessed_path,
        # ORT symbolic inference does not support the exported graph's dynamic seq_len expressions.
        skip_symbolic_shape=True,
    )

    print("Quantizing weights to per-channel QInt8...", flush=True)
    quantize_dynamic(
        model_input=preprocessed_path,
        model_output=dynamic_output,
        # CPUExecutionProvider on Apple Silicon has no ConvInteger kernel.
        op_types_to_quantize=("MatMul",),
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False,
    )

    print("Quantizing Conv weights to per-channel QInt8 with QDQ...", flush=True)
    quantized_model = onnx.load(dynamic_output)
    qdq_conv_count = _quantize_conv_weights_as_qdq(quantized_model, keep_float)
    onnx.save_model(quantized_model, temporary_output)
    if keep_float:
        print(f"Conv nodes kept in float32: {len(keep_float)}", flush=True)

    integer_nodes = Counter(
        node.op_type
        for node in quantized_model.graph.node
        if node.op_type.endswith("Integer") or node.op_type.startswith("QLinear")
    )
    details = ", ".join(
        f"{op_type}={count}" for op_type, count in sorted(integer_nodes.items())
    )
    print(
        f"Dynamic integer compute nodes: {sum(integer_nodes.values())}"
        + (f" ({details})" if details else ""),
        flush=True,
    )
    print(f"Conv weights stored as per-channel QInt8: {qdq_conv_count}", flush=True)
    temporary_output.replace(destination_path)


def _build_fp16(source_path: Path, destination_path: Path, temp_dir: Path) -> None:
    from onnxconverter_common import float16

    temporary_output = temp_dir / destination_path.name
    print("Converting weights and internal tensors to fp16...", flush=True)
    model = onnx.load(source_path)
    fp16_model = float16.convert_float_to_float16(model, keep_io_types=True)
    value_types = {
        value.name: value.type.tensor_type.elem_type
        for value in (
            *fp16_model.graph.input,
            *fp16_model.graph.output,
            *fp16_model.graph.value_info,
        )
        if value.type.HasField("tensor_type")
    }
    fixed_casts = 0
    for node in fp16_model.graph.node:
        if (
            node.op_type != "Cast"
            or value_types.get(node.output[0]) != TensorProto.FLOAT16
        ):
            continue
        target_type = next(
            (attribute for attribute in node.attribute if attribute.name == "to"),
            None,
        )
        if target_type is not None and target_type.i == TensorProto.FLOAT:
            target_type.i = TensorProto.FLOAT16
            fixed_casts += 1
    print(f"Aligned fp16 Cast targets: {fixed_casts}", flush=True)
    onnx.save_model(fp16_model, temporary_output)
    temporary_output.replace(destination_path)


def _write_manifest(
    output_dir: Path, manifest: dict[str, Any], onnx_filename: str
) -> Path:
    output_manifest = dict(manifest)
    output_manifest["onnx_file"] = onnx_filename
    manifest_path = output_dir / f"{MODEL_NAME}.json"
    manifest_path.write_text(
        json.dumps(output_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest_path


def main() -> None:
    args = _parse_args()
    source_dir = args.source_dir.expanduser().resolve()
    output_dir = (
        args.output_dir
        if args.output_dir is not None
        else PROJECT_ROOT / "build" / f"onnx-{args.variant}"
    ).expanduser().resolve()

    source_path, manifest = _load_manifest(source_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_filename = f"{source_path.stem}.{args.variant}{source_path.suffix}"
    destination_path = output_dir / output_filename
    if destination_path == source_path:
        raise ValueError("output model would overwrite the fp32 source model")

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=f".{MODEL_NAME}-{args.variant}-", dir=output_dir.parent
    ) as temporary_directory:
        temp_dir = Path(temporary_directory)
        if args.variant == "int8":
            keep_float = (
                frozenset() if args.quantize_all_convs else frozenset(SENSITIVE_CONV_NODES)
            )
            _build_int8(source_path, destination_path, temp_dir, keep_float)
        else:
            _build_fp16(source_path, destination_path, temp_dir)

    manifest_path = _write_manifest(output_dir, manifest, output_filename)
    size = os.path.getsize(destination_path)
    print(f"Model: {destination_path}")
    print(f"Manifest: {manifest_path}")
    print(f"Size: {size} bytes ({size / 1024**2:.2f} MiB)")


if __name__ == "__main__":
    main()
