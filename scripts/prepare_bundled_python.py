#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
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


def test_suite_path(platform: str, version: tuple[int, int]) -> Path:
    major, minor = version
    if platform == "windows":
        return Path("Lib") / "test"
    return Path("lib") / f"python{major}.{minor}" / "test"


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


def remove_test_suite(path: Path, dry_run: bool) -> None:
    if not path.exists():
        return
    if dry_run:
        print(f"[dry-run] remove test suite: {path}")
        return
    shutil.rmtree(path)


def remove_path(path: Path, dry_run: bool) -> None:
    if not path.exists() and not path.is_symlink():
        return
    if dry_run:
        print(f"[dry-run] remove path: {path}")
        return
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
        return
    path.unlink()


def prune_runtime(platform: str, target_dir: Path, version: tuple[int, int], dry_run: bool) -> None:
    major, minor = version
    lib_dir = target_dir / ("Lib" if platform == "windows" else Path("lib") / f"python{major}.{minor}")

    removable_paths = [
        lib_dir / "ensurepip",
        lib_dir / "idlelib",
        lib_dir / "tkinter",
        lib_dir / "turtledemo",
        lib_dir / "site-packages",
    ]

    if platform == "windows":
        removable_paths.extend(
            [
                target_dir / "Scripts" / "pip.exe",
                target_dir / "Scripts" / "pip3.exe",
                target_dir / "Scripts" / f"pip{major}.{minor}.exe",
            ],
        )
    else:
        removable_paths.extend(
            [
                target_dir / "bin" / "pip3",
                target_dir / "bin" / f"pip3.{minor}",
                target_dir / "bin" / f"pydoc3.{minor}",
                target_dir / "bin" / f"idle3.{minor}",
                target_dir / "bin" / f"2to3-{major}.{minor}",
            ],
        )

    for path in removable_paths:
        remove_path(path, dry_run=dry_run)

    site_packages_dir = lib_dir / "site-packages"
    ensure_site_packages(site_packages_dir, dry_run=dry_run)

    if lib_dir.exists():
        for cache_dir in lib_dir.rglob("__pycache__"):
            remove_path(cache_dir, dry_run=dry_run)


def normalize_permissions(target_dir: Path, dry_run: bool) -> None:
    for path in target_dir.rglob("*"):
        if dry_run:
            print(f"[dry-run] chmod normalize: {path}")
            continue

        mode = path.stat().st_mode
        if path.is_dir():
            path.chmod(mode | 0o755)
            continue

        normalized = 0o644
        if mode & 0o111:
            normalized = 0o755
        path.chmod(normalized)


def dependency_lines(path: Path) -> list[str]:
    result = subprocess.run(
        ["otool", "-L", str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []

    lines = result.stdout.splitlines()[1:]
    dependencies: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        dependencies.append(stripped.split(" (", 1)[0])
    return dependencies


def macos_loader_reference(from_dir: Path, target_path: Path) -> str:
    relative = Path(os.path.relpath(target_path, from_dir))
    relative_text = relative.as_posix()
    if relative_text == ".":
        relative_text = target_path.name
    return f"@loader_path/{relative_text}"


def retarget_macos_runtime(target_dir: Path, version: tuple[int, int], dry_run: bool) -> None:
    major, minor = version
    framework_suffix = f"Python.framework/Versions/{major}.{minor}/Python"
    bundled_python_dylib = target_dir / "Python"
    dylib_alias = target_dir / "lib" / f"libpython{major}.{minor}.dylib"

    for path in target_dir.rglob("*"):
        if not path.is_file():
            continue

        dependencies = dependency_lines(path)
        if not dependencies:
            continue

        for dependency in dependencies:
            if framework_suffix not in dependency:
                continue

            new_dependency = macos_loader_reference(path.parent, bundled_python_dylib)
            command = ["install_name_tool", "-change", dependency, new_dependency, str(path)]
            if dry_run:
                print(f"[dry-run] {' '.join(command)}")
                continue
            subprocess.run(command, check=True)

    if bundled_python_dylib.exists():
        command = ["install_name_tool", "-id", "@rpath/Python", str(bundled_python_dylib)]
        if dry_run:
            print(f"[dry-run] {' '.join(command)}")
        else:
            subprocess.run(command, check=True)

    if dylib_alias.exists():
        command = [
            "install_name_tool",
            "-id",
            f"@rpath/libpython{major}.{minor}.dylib",
            str(dylib_alias),
        ]
        if dry_run:
            print(f"[dry-run] {' '.join(command)}")
        else:
            subprocess.run(command, check=True)


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
        # Bundle real files instead of host-machine symlinks so the packaged
        # runtime remains self-contained after moving to end-user machines.
        shutil.copytree(source_prefix, target_dir, symlinks=False)

    ensure_site_packages(
        target_dir / site_packages_path(args.platform, (sys.version_info.major, sys.version_info.minor)),
        dry_run=args.dry_run,
    )
    remove_test_suite(
        target_dir / test_suite_path(args.platform, (sys.version_info.major, sys.version_info.minor)),
        dry_run=args.dry_run,
    )
    prune_runtime(
        args.platform,
        target_dir,
        (sys.version_info.major, sys.version_info.minor),
        dry_run=args.dry_run,
    )
    normalize_permissions(target_dir, dry_run=args.dry_run)

    if args.platform == "macos":
        ensure_macos_python3_alias(target_dir, dry_run=args.dry_run)
        retarget_macos_runtime(
            target_dir,
            (sys.version_info.major, sys.version_info.minor),
            dry_run=args.dry_run,
        )

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
