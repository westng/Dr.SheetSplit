use std::{
    collections::HashSet,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use base64::Engine;
use tauri::{path::BaseDirectory, AppHandle, Manager};

const SLOGAN_API_URL: &str =
    "https://api.southerly.top/api/yiyan?msg=%E8%AF%97%E8%AF%8D&output=json";
const PYTHON_SCRIPT_RESOURCE_PATH: &str = "python/transform_engine.py";
const PYTHON_INTERPRETER_ENV_KEY: &str = "DR_SHEETSPLIT_PYTHON";

#[cfg(target_os = "windows")]
const BUNDLED_PYTHON_RELATIVE_CANDIDATES: &[&str] =
    &["python/runtime/windows/python.exe", "python/runtime/python.exe"];

#[cfg(target_os = "macos")]
const BUNDLED_PYTHON_RELATIVE_CANDIDATES: &[&str] = &[
    "python/runtime/macos/bin/python3",
    "python/runtime/bin/python3",
    "python/runtime/python3",
];

#[cfg(target_os = "linux")]
const BUNDLED_PYTHON_RELATIVE_CANDIDATES: &[&str] = &[
    "python/runtime/linux/bin/python3",
    "python/runtime/bin/python3",
    "python/runtime/python3",
];

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|err| err.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|err| err.to_string())
}

#[tauri::command]
fn write_binary_file(path: String, content_base64: String) -> Result<(), String> {
    let normalized = PathBuf::from(path.trim());
    if normalized.as_os_str().is_empty() {
        return Err("输出路径无效。".to_string());
    }

    if let Some(parent) = normalized.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|err| err.to_string())?;
    fs::write(normalized, bytes).map_err(|err| err.to_string())
}

fn resolve_python_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_path) = app
        .path()
        .resolve(PYTHON_SCRIPT_RESOURCE_PATH, BaseDirectory::Resource)
    {
        if resource_path.exists() {
            return Ok(resource_path);
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidates = vec![
        manifest_dir.join(PYTHON_SCRIPT_RESOURCE_PATH),
        manifest_dir.join("../src-tauri").join(PYTHON_SCRIPT_RESOURCE_PATH),
        manifest_dir.join("../").join(PYTHON_SCRIPT_RESOURCE_PATH),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("未找到 Python 处理引擎脚本，请检查打包资源或开发目录。".to_string())
}

fn resolve_resource_path(app: &AppHandle, relative: &str) -> Option<PathBuf> {
    app.path()
        .resolve(relative, BaseDirectory::Resource)
        .ok()
        .filter(|path| path.exists())
}

fn bundled_python_candidates(app: &AppHandle) -> Vec<String> {
    let mut candidates = Vec::new();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

    for relative in BUNDLED_PYTHON_RELATIVE_CANDIDATES {
        if let Some(path) = resolve_resource_path(app, relative) {
            candidates.push(path.to_string_lossy().to_string());
            continue;
        }

        let dev_candidate = manifest_dir.join(relative);
        if dev_candidate.exists() {
            candidates.push(dev_candidate.to_string_lossy().to_string());
        }
    }

    candidates
}

fn python_candidates(app: &AppHandle) -> Result<Vec<String>, String> {
    let mut candidates = Vec::new();

    if let Ok(custom) = env::var(PYTHON_INTERPRETER_ENV_KEY) {
        let normalized = custom.trim();
        if !normalized.is_empty() {
            candidates.push(normalized.to_string());
        }
    }

    candidates.extend(bundled_python_candidates(app));

    // 开发模式允许回落到系统 Python，发布包默认只使用内置运行时。
    if cfg!(debug_assertions) {
        candidates.push("python3".to_string());
        candidates.push("python".to_string());
    }

    let mut deduped = Vec::new();
    let mut seen = HashSet::new();
    for candidate in candidates {
        if seen.insert(candidate.clone()) {
            deduped.push(candidate);
        }
    }

    if deduped.is_empty() {
        return Err(
            "未找到可用的 Python 解释器。发布版本请确保已内置 python/runtime 运行时。".to_string(),
        );
    }

    Ok(deduped)
}

fn execute_python(
    python_bin: &str,
    script_path: &Path,
    payload: &str,
) -> Result<Output, String> {
    let mut child = Command::new(python_bin)
        .arg(script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("启动 Python 失败（{}）：{}", python_bin, err))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法写入 Python stdin。".to_string())?;

    let write_result = stdin
        .write_all(payload.as_bytes())
        .and_then(|_| stdin.flush());
    drop(stdin);

    let output = child
        .wait_with_output()
        .map_err(|err| format!("等待 Python 进程结束失败：{}", err))?;

    if let Err(err) = write_result {
        let stderr_text = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr_text.is_empty() {
            String::new()
        } else {
            format!("；stderr：{}", stderr_text)
        };
        return Err(format!(
            "写入 Python 请求数据失败（{}）：{}{}",
            python_bin, err, detail
        ));
    }

    Ok(output)
}

#[tauri::command]
fn run_python_transform(app: AppHandle, payload: String) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|err| format!("处理引擎入参不是合法 JSON：{}", err))?;

    let script_path = resolve_python_script_path(&app)?;
    let candidates = python_candidates(&app)?;
    let mut last_error = String::new();

    for candidate in candidates {
        match execute_python(&candidate, &script_path, &payload) {
            Ok(output) => {
                let stdout_text = String::from_utf8(output.stdout)
                    .map_err(|err| format!("Python 输出不是 UTF-8：{}", err))?;
                if output.status.success() {
                    let normalized = stdout_text.trim();
                    if normalized.is_empty() {
                        return Err("Python 引擎执行成功但未返回结果。".to_string());
                    }
                    return Ok(normalized.to_string());
                }

                let stderr_text = String::from_utf8_lossy(&output.stderr).trim().to_string();
                last_error = if stderr_text.is_empty() {
                    format!(
                        "Python 引擎执行失败（{}），退出码：{}",
                        candidate,
                        output.status
                    )
                } else {
                    format!("Python 引擎执行失败（{}）：{}", candidate, stderr_text)
                };
            }
            Err(err) => {
                last_error = err;
            }
        }
    }

    if last_error.is_empty() {
        Err("调用 Python 引擎失败：未找到可用的 Python 解释器。".to_string())
    } else {
        Err(last_error)
    }
}

fn normalize_text(value: Option<&serde_json::Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn extract_slogan(value: &serde_json::Value) -> Option<String> {
    if let Some(direct) = normalize_text(Some(value)) {
        return Some(direct);
    }

    let object = value.as_object()?;
    let keys = ["data", "content", "text", "result", "msg", "hitokoto", "yiyan"];
    for key in keys {
        if let Some(text) = normalize_text(object.get(key)) {
            return Some(text);
        }

        if let Some(nested) = object.get(key).and_then(|item| item.as_object()) {
            let nested_text = normalize_text(nested.get("content"))
                .or_else(|| normalize_text(nested.get("text")))
                .or_else(|| normalize_text(nested.get("result")))
                .or_else(|| normalize_text(nested.get("msg")));
            if nested_text.is_some() {
                return nested_text;
            }
        }
    }

    None
}

fn parse_slogan_from_body(body: &str) -> Option<String> {
    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(parsed) = extract_slogan(&payload) {
            return Some(parsed);
        }
    }

    let raw = body.trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

#[tauri::command]
async fn fetch_slogan() -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(SLOGAN_API_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|err| err.to_string())?;

    let body = response.text().await.map_err(|err| err.to_string())?;
    parse_slogan_from_body(&body).ok_or_else(|| "未获取到有效文案".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            restart_app,
            fetch_slogan,
            write_text_file,
            read_text_file,
            write_binary_file,
            run_python_transform
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
