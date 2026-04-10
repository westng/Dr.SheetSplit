## Bundled Python Runtime Layout

Place platform Python runtime files under this directory before building release installers.

Expected executable paths:

- macOS: `src-tauri/python/runtime/macos/bin/python3`
- Windows: `src-tauri/python/runtime/windows/python.exe`
- Linux: `src-tauri/python/runtime/linux/bin/python3` (optional if you ship Linux)

Notes:

- `pnpm tauri build` in release mode will fail if the target platform runtime executable is missing.
- `tauri.conf.json` includes `python/runtime` in bundle resources, so these runtime files will be included in the app package.
- In debug/dev mode, the app can still fall back to system Python for local development.
