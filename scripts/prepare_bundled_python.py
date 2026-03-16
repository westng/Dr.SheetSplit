#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare bundled Python runtime files for Tauri packaging.",
    )
    parser.add_argument(
        "--platform",
        required=True,
        choices=("macos", "windows", "linux"),
        help="Target platform runtime folder name under src-tauri/python/runtime.",
    )
    parser.add_argument(
        "--source-prefix",
        default=sys.prefix,
        help="Python installation prefix to copy from (default: current sys.prefix).",
    )
    parser.add_argument(
        "--target-root",
        default="src-tauri/python/runtime",
        help="Runtime root directory (default: src-tauri/python/runtime).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print actions without changing files.",
    )
    return parser.parse_args()


def expected_interpreter(platform: str) -> Path:
    if platform == "windows":
        return Path("python.exe")
    return Path("bin/python3")


def site_packages_path(platform: str, version: tuple[int, int]) -> Path:
    major, minor = version
    if platform == "windows":
        return Path("Lib") / "site-packages"
    return Path("lib") / f"python{major}.{minor}" / "site-packages"


def ensure_site_packages(path: Path, dry_run: bool) -> None:
    if path.is_symlink() and not path.exists():
        if dry_run:
            print(f"[dry-run] unlink broken symlink: {path}")
        else:
            path.unlink()
    if dry_run:
        print(f"[dry-run] mkdir -p: {path}")
        return
    path.mkdir(parents=True, exist_ok=True)


def ensure_macos_python3_alias(target_dir: Path, dry_run: bool) -> None:
    bin_dir = target_dir / "bin"
    if not bin_dir.exists():
        return
    alias = bin_dir / "python3"
    if alias.exists():
        return

    fallback = bin_dir / f"python{sys.version_info.major}.{sys.version_info.minor}"
    if not fallback.exists():
        return

    if dry_run:
        print(f"[dry-run] ln -s {fallback.name} {alias}")
        return
    alias.symlink_to(fallback.name)


def main() -> int:
    args = parse_args()
    source_prefix = Path(args.source_prefix).expanduser().resolve()
    target_root = Path(args.target_root).expanduser().resolve()
    target_dir = target_root / args.platform

    print(f"source_prefix={source_prefix}")
    print(f"target_dir={target_dir}")
    print(f"python={sys.executable}")
    print(f"version={sys.version.split()[0]}")

    if not source_prefix.exists():
        raise SystemExit(f"Source prefix does not exist: {source_prefix}")

    if args.dry_run:
        if target_dir.exists():
            print(f"[dry-run] remove existing directory: {target_dir}")
        print(f"[dry-run] copytree {source_prefix} -> {target_dir}")
    else:
        if target_dir.exists():
            shutil.rmtree(target_dir)
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_prefix, target_dir, symlinks=True)

    ensure_site_packages(
        target_dir / site_packages_path(args.platform, (sys.version_info.major, sys.version_info.minor)),
        dry_run=args.dry_run,
    )

    if args.platform == "macos":
        ensure_macos_python3_alias(target_dir, dry_run=args.dry_run)

    interpreter_path = target_dir / expected_interpreter(args.platform)
    if args.dry_run:
        print(f"[dry-run] expected interpreter: {interpreter_path}")
        return 0

    if not interpreter_path.exists():
        raise SystemExit(f"Bundled interpreter missing after copy: {interpreter_path}")

    size_mb = sum(p.stat().st_size for p in target_dir.rglob("*") if p.is_file()) / (1024 * 1024)
    print(f"runtime_ready={interpreter_path}")
    print(f"runtime_size_mb={size_mb:.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
