#!/usr/bin/env python3
"""Собирает THIRD_PARTY_NOTICES.txt из того, что попадает в сборку Rechiv.

    scripts/third-party-notices.py <каталог ресурсов> <выходной файл> <darwin-arm64|linux-x86_64>

Каталог ресурсов — Rechiv.app/Contents/Resources или resources/ Linux-сборки.

Колёса Python читаются из site-packages бандла, модули Go — по `go list -deps`, пакеты npm —
по продовым зависимостям расширения, ffmpeg — из исходного архива. Тексты, которых в сборке
нет, лежат в licenses/. Компонент без текста лицензии — ошибка.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tarfile
from email.parser import Parser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LICENSES = ROOT / "licenses"
LICENSE_NAME = re.compile(r"^(licen[cs]e|copying|notice|thirdpartynotices)", re.IGNORECASE)

# По PYTHON.json полного архива python-build-standalone: что вшито статически.
PYTHON_RUNTIME = [
    ("CPython", "Python-2.0", "cpython"),
    ("OpenSSL", "Apache-2.0", "openssl-3"),
    ("SQLite", "blessing", "sqlite"),
    ("libffi", "MIT", "libffi"),
    ("mpdecimal", "BSD-2-Clause", "mpdecimal"),
    ("expat", "MIT", "expat"),
    ("liblzma (XZ Utils)", "0BSD", "liblzma"),
    ("bzip2", "bzip2-1.0.6", "bzip2"),
    ("libuuid", "BSD-3-Clause", "libuuid"),
]
# На macOS эти библиотеки системные, на Linux вшиты в рантайм.
PYTHON_RUNTIME_LINUX = [
    ("ncurses", "X11", "ncurses"),
    ("libedit", "BSD-3-Clause", "libedit"),
    ("zlib", "Zlib", "zlib"),
]
GO_ENV = {
    "darwin-arm64": {"GOOS": "darwin", "GOARCH": "arm64", "CGO_ENABLED": "1"},
    "linux-x86_64": {"GOOS": "linux", "GOARCH": "amd64", "CGO_ENABLED": "0"},
}
# Колёса без файла лицензии внутри.
VENDORED_WHEELS = {"flatbuffers": LICENSES / "flatbuffers" / "LICENSE"}

entries: list[tuple[str, list[tuple[str, str]]]] = []
missing: list[str] = []


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def add(title: str, files: list[Path | tuple[str, str]]) -> None:
    texts = []
    for item in files:
        if isinstance(item, tuple):
            texts.append(item)
        else:
            texts.append((item.name, item.read_text(encoding="utf-8", errors="replace")))
    if not texts:
        missing.append(title)
    entries.append((title, texts))


def license_files(directory: Path, recursive: bool = False) -> list[Path]:
    candidates = directory.rglob("*") if recursive else directory.iterdir()
    return sorted(p for p in candidates if p.is_file() and LICENSE_NAME.match(p.name))


def run(args: list[str], cwd: Path, env: dict | None = None) -> str:
    return subprocess.run(args, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout


def python_runtime(platform: str) -> None:
    components = PYTHON_RUNTIME + (PYTHON_RUNTIME_LINUX if platform.startswith("linux") else [])
    for name, spdx, key in components:
        add(f"{name} — Python runtime (python-build-standalone) — {spdx}",
            [LICENSES / "python-build-standalone" / f"LICENSE.{key}.txt"])


def wheels(resources: Path) -> None:
    site = next((resources / "python/lib").glob("python3*/site-packages"), None)
    if site is None:
        fail(f"нет site-packages в {resources}")
    for dist in sorted(site.glob("*.dist-info")):
        meta = Parser().parsestr((dist / "METADATA").read_text(encoding="utf-8"))
        name, version = meta["Name"], meta["Version"]
        spdx = meta.get("License-Expression") or meta.get("License") or ""
        files = license_files(dist / "licenses", recursive=True) if (dist / "licenses").is_dir() else []
        files += license_files(dist)
        package = site / name.lower().replace("-", "_")
        if package.is_dir():
            files += [p for p in license_files(package) if p.name not in {f.name for f in files}]
        if not files and name.lower() in VENDORED_WHEELS:
            files = [VENDORED_WHEELS[name.lower()]]
        add(f"{name} {version} — Python package — {spdx}".rstrip(" —"), files)


def ffmpeg() -> None:
    lock = (ROOT / "scripts/prefetch.lock").read_text(encoding="utf-8")
    url = re.search(r"^prefetch/ffmpeg-source\.tar\.xz (\S+)", lock, re.MULTILINE).group(1)
    archive = ROOT / "build/prefetch/ffmpeg-source.tar.xz"
    if not archive.is_file():
        fail(f"нет {archive}, выполни scripts/prefetch.sh")
    texts = [("README", (
        f"Rechiv ships an ffmpeg executable built from the unmodified source {url}\n"
        "with --disable-gpl --disable-nonfree (LGPL-2.1-or-later); configure flags are in\n"
        "scripts/build-ffmpeg.sh of the Rechiv repository. The same source archive is attached\n"
        "to every Rechiv release on GitHub.\n"))]
    with tarfile.open(archive) as source:
        for member in source.getmembers():
            if member.name.count("/") == 1 and member.name.split("/")[1] in {"LICENSE.md", "COPYING.LGPLv2.1"}:
                texts.append((member.name.split("/")[1], source.extractfile(member).read().decode()))
    if len(texts) < 3:
        fail("в исходниках ffmpeg нет LICENSE.md или COPYING.LGPLv2.1")
    version = re.search(r"ffmpeg-([\d.]+)\.tar", url).group(1)
    add(f"FFmpeg {version} — LGPL-2.1-or-later", texts)


def go_modules(platform: str) -> None:
    desktop = ROOT / "desktop"
    env = {**os.environ, **GO_ENV[platform]}
    goroot = Path(run(["go", "env", "GOROOT"], desktop, env).strip())
    goversion = run(["go", "env", "GOVERSION"], desktop, env).strip()
    add(f"Go standard library {goversion} — BSD-3-Clause", [goroot / "LICENSE"])
    listing = run(["go", "list", "-deps", "-f",
                   "{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}",
                   "./cmd/rechiv"], desktop, env)
    for line in sorted(set(filter(None, listing.splitlines()))):
        path, version, directory = line.split("\t")
        add(f"{path} {version} — Go module", license_files(Path(directory)))


def npm_packages() -> None:
    extension = ROOT / "extension"
    listing = run(["npm", "ls", "--omit=dev", "--all", "--parseable"], extension)
    seen = set()
    for directory in sorted(set(listing.splitlines())):
        path = Path(directory)
        if path == extension or not (path / "package.json").is_file():
            continue
        meta = json.loads((path / "package.json").read_text(encoding="utf-8"))
        key = (meta["name"], meta["version"])
        if key in seen:
            continue
        seen.add(key)
        spdx = meta.get("license") or ""
        add(f"{meta['name']} {meta['version']} — npm package — {spdx}".rstrip(" —"), license_files(path))


def model() -> None:
    add("GigaAM v3 (model weights, salute-developers/GigaAM) — MIT", [LICENSES / "gigaam" / "LICENSE"])


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[3] not in GO_ENV:
        sys.exit(__doc__)
    resources, out, platform = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    python_runtime(platform)
    wheels(resources)
    ffmpeg()
    go_modules(platform)
    npm_packages()
    model()
    if missing:
        fail("нет текста лицензии: " + "; ".join(missing) + ". Положи его в licenses/ и добавь в скрипт.")

    rechiv_license = (ROOT / "LICENSE").read_text(encoding="utf-8")
    lines = [
        "Rechiv — third-party notices",
        "",
        "Rechiv itself is distributed under the MIT License:",
        "",
        rechiv_license.rstrip(),
        "",
        f"This Rechiv build ({platform}) bundles the following third-party components:",
        "",
        *[f"  - {title}" for title, _ in entries],
        "",
    ]
    for title, texts in entries:
        lines += ["", "=" * 78, title, "=" * 78]
        for name, text in texts:
            lines += ["", f"--- {name} ---", "", text.rstrip()]
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(entries)} компонентов → {out}")


if __name__ == "__main__":
    main()
