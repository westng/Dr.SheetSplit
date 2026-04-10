use std::{env, path::PathBuf};

fn expected_runtime_path_for_target(target_os: &str) -> Option<&'static str> {
    match target_os {
        "windows" => Some("python/runtime/windows/python.exe"),
        "macos" => Some("python/runtime/macos/bin/python3"),
        "linux" => Some("python/runtime/linux/bin/python3"),
        _ => None,
    }
}

fn main() {
    tauri_build::build();

    let profile = env::var("PROFILE").unwrap_or_default();
    if profile != "release" {
        return;
    }

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let Some(relative_path) = expected_runtime_path_for_target(&target_os) else {
        return;
    };

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string()));
    let runtime_path = manifest_dir.join(relative_path);
    if !runtime_path.exists() {
        panic!(
            "Release 构建缺少内置 Python 运行时：{}。请先放置对应平台运行时后再执行 `pnpm tauri build`。",
            runtime_path.display()
        );
    }
}
