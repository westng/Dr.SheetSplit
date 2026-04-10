use std::{
    any::Any,
    collections::HashSet,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

use base64::Engine;
use serde::Serialize;
use tauri::async_runtime::{spawn, spawn_blocking};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager};

mod app_logger;
mod dataset_cache;
mod engine_backend;
mod xlsx_fallback;

const SLOGAN_API_URL: &str =
    "https://api.southerly.top/api/yiyan?msg=%E8%AF%97%E8%AF%8D&output=json";
const PYTHON_SCRIPT_RESOURCE_PATH: &str = "python/transform_engine.py";
const PYTHON_INTERPRETER_ENV_KEY: &str = "DR_SHEETSPLIT_PYTHON";
const PROCESS_LOG_EVENT: &str = "process-log";
const SOURCE_INSPECT_JOB_EVENT: &str = "source-inspect-job";
static SOURCE_INSPECT_JOB_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceInspectJobEvent {
    job_id: String,
    source_id: String,
    status: String,
    sheet_name: String,
    preview: Option<dataset_cache::DatasetImportResult>,
    header: Option<dataset_cache::DatasetSheetRowsResult>,
    error: Option<String>,
}

fn next_source_inspect_job_id() -> String {
    let counter = SOURCE_INSPECT_JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("source_inspect_{counter}")
}

fn emit_source_inspect_event(app: &AppHandle, event: SourceInspectJobEvent) {
    let _ = app.emit(SOURCE_INSPECT_JOB_EVENT, event);
}

fn log_command_error(context: &str, error: impl AsRef<str>) -> String {
    let message = error.as_ref().to_string();
    app_logger::error_with_context(context, &message);
    message
}

fn panic_payload_text(payload: Box<dyn Any + Send>) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "unknown panic payload".to_string()
}

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
    fs::write(path, content).map_err(|err| log_command_error("write_text_file", err.to_string()))
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|err| log_command_error("read_text_file", err.to_string()))
}

#[tauri::command]
fn write_binary_file(path: String, content_base64: String) -> Result<(), String> {
    let normalized = PathBuf::from(path.trim());
    if normalized.as_os_str().is_empty() {
        return Err(log_command_error("write_binary_file", "输出路径无效。"));
    }

    if let Some(parent) = normalized.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|err| log_command_error("write_binary_file", err.to_string()))?;
        }
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content_base64)
        .map_err(|err| log_command_error("write_binary_file", err.to_string()))?;
    fs::write(normalized, bytes).map_err(|err| log_command_error("write_binary_file", err.to_string()))
}

#[tauri::command]
fn append_app_log(level: String, message: String) {
    let normalized_level = level.trim().to_uppercase();
    let normalized_message = message.trim();
    if normalized_message.is_empty() {
        return;
    }
    match normalized_level.as_str() {
        "WARN" => app_logger::warn(normalized_message),
        "ERROR" => app_logger::error(normalized_message),
        _ => app_logger::info(normalized_message),
    }
}

pub(crate) fn resolve_python_script_path(app: &AppHandle) -> Result<PathBuf, String> {
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

pub(crate) fn python_candidates(app: &AppHandle) -> Result<Vec<String>, String> {
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

pub(crate) fn execute_python(
    python_bin: &str,
    script_path: &Path,
    payload: &str,
) -> Result<Output, String> {
    let mut child = Command::new(python_bin)
        .arg("-X")
        .arg("utf8")
        .arg(script_path)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
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
        Err(log_command_error(
            "run_python_transform",
            "调用 Python 引擎失败：未找到可用的 Python 解释器。",
        ))
    } else {
        Err(log_command_error("run_python_transform", last_error))
    }
}

#[tauri::command]
fn run_python_transform_for_dataset(
    app: AppHandle,
    payload: String,
    dataset_id: String,
    sheet_name: String,
) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|err| format!("处理引擎入参不是合法 JSON：{}", err))?;

    let final_payload =
        dataset_cache::build_python_payload_for_dataset(&app, &payload, &dataset_id, &sheet_name)?;
    let _ = app.emit(
        PROCESS_LOG_EVENT,
        serde_json::json!({ "message": "正在调用 Python 转换引擎..." }),
    );
    let script_path = resolve_python_script_path(&app)?;
    let candidates = python_candidates(&app)?;
    let mut last_error = String::new();

    for candidate in candidates {
        match execute_python(&candidate, &script_path, &final_payload) {
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
        Err(log_command_error(
            "run_python_transform_for_dataset",
            "调用 Python 引擎失败：未找到可用的 Python 解释器。",
        ))
    } else {
        Err(log_command_error("run_python_transform_for_dataset", last_error))
    }
}

#[tauri::command]
fn run_python_transform_for_path(
    app: AppHandle,
    payload: String,
    file_path: String,
    sheet_name: String,
) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|err| format!("处理引擎入参不是合法 JSON：{}", err))?;

    let final_payload =
        dataset_cache::build_python_payload_for_path(&app, &payload, &file_path, &sheet_name)?;
    let _ = app.emit(
        PROCESS_LOG_EVENT,
        serde_json::json!({ "message": "正在调用 Python 转换引擎..." }),
    );
    let script_path = resolve_python_script_path(&app)?;
    let candidates = python_candidates(&app)?;
    let mut last_error = String::new();

    for candidate in candidates {
        match execute_python(&candidate, &script_path, &final_payload) {
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
        Err(log_command_error(
            "run_python_transform_for_path",
            "调用 Python 引擎失败：未找到可用的 Python 解释器。",
        ))
    } else {
        Err(log_command_error("run_python_transform_for_path", last_error))
    }
}

#[tauri::command]
async fn start_source_inspect_job(
    app: AppHandle,
    source_id: String,
    file_path: String,
    preferred_sheet_name: String,
) -> Result<String, String> {
    let normalized_file_path = file_path.trim().to_string();
    if normalized_file_path.is_empty() {
        return Err(log_command_error("start_source_inspect_job", "来源文件路径不能为空。"));
    }

    let job_id = next_source_inspect_job_id();
    emit_source_inspect_event(
        &app,
        SourceInspectJobEvent {
            job_id: job_id.clone(),
            source_id: source_id.clone(),
            status: "queued".to_string(),
            sheet_name: String::new(),
            preview: None,
            header: None,
            error: None,
        },
    );

    let app_handle = app.clone();
    let return_job_id = job_id.clone();
    spawn(async move {
        emit_source_inspect_event(
            &app_handle,
            SourceInspectJobEvent {
                job_id: job_id.clone(),
                source_id: source_id.clone(),
                status: "reading_sheets".to_string(),
                sheet_name: String::new(),
                preview: None,
                header: None,
                error: None,
            },
        );

        let preview_result = spawn_blocking({
            let app_handle = app_handle.clone();
            let file_path = normalized_file_path.clone();
            move || dataset_cache::import_spreadsheet_dataset_from_path(app_handle, file_path)
        }).await;

        let preview = match preview_result {
            Ok(Ok(preview)) => preview,
            Ok(Err(error)) => {
                app_logger::error_with_context("start_source_inspect_job/import_spreadsheet_dataset_from_path", &error);
                emit_source_inspect_event(
                    &app_handle,
                    SourceInspectJobEvent {
                        job_id: job_id.clone(),
                        source_id: source_id.clone(),
                        status: "failed".to_string(),
                        sheet_name: String::new(),
                        preview: None,
                        header: None,
                        error: Some(error),
                    },
                );
                return;
            }
            Err(error) => {
                let detail = match error {
                    tauri::Error::JoinError(join_error) if join_error.is_panic() => {
                        let panic_text = panic_payload_text(join_error.into_panic());
                        format!("spawn_blocking panic: {panic_text}")
                    }
                    other => other.to_string(),
                };
                app_logger::error_with_context("start_source_inspect_job/import_spreadsheet_dataset_from_path_join", &detail);
                emit_source_inspect_event(
                    &app_handle,
                    SourceInspectJobEvent {
                        job_id: job_id.clone(),
                        source_id: source_id.clone(),
                        status: "failed".to_string(),
                        sheet_name: String::new(),
                        preview: None,
                        header: None,
                        error: Some(detail),
                    },
                );
                return;
            }
        };

        let resolved_sheet_name = if !preferred_sheet_name.trim().is_empty()
            && preview
                .sheets
                .iter()
                .any(|sheet| sheet.name == preferred_sheet_name)
        {
            preferred_sheet_name.trim().to_string()
        } else {
            preview
                .sheets
                .first()
                .map(|sheet| sheet.name.clone())
                .unwrap_or_default()
        };

        emit_source_inspect_event(
            &app_handle,
            SourceInspectJobEvent {
                job_id: job_id.clone(),
                source_id: source_id.clone(),
                status: "reading_headers".to_string(),
                sheet_name: resolved_sheet_name.clone(),
                preview: Some(preview.clone()),
                header: None,
                error: None,
            },
        );

        let dataset_id = preview.dataset_id.clone();
        let header_result = spawn_blocking({
            let app_handle = app_handle.clone();
            let sheet_name = resolved_sheet_name.clone();
            move || dataset_cache::read_dataset_sheet_header(app_handle, dataset_id, sheet_name)
        }).await;

        match header_result {
            Ok(Ok(header)) => {
                emit_source_inspect_event(
                    &app_handle,
                    SourceInspectJobEvent {
                        job_id: job_id.clone(),
                        source_id: source_id.clone(),
                        status: "done".to_string(),
                        sheet_name: resolved_sheet_name,
                        preview: Some(preview),
                        header: Some(header),
                        error: None,
                    },
                );
            }
            Ok(Err(error)) => {
                app_logger::error_with_context("start_source_inspect_job/read_dataset_sheet_header", &error);
                emit_source_inspect_event(
                    &app_handle,
                    SourceInspectJobEvent {
                        job_id: job_id.clone(),
                        source_id: source_id.clone(),
                        status: "failed".to_string(),
                        sheet_name: resolved_sheet_name,
                        preview: Some(preview),
                        header: None,
                        error: Some(error),
                    },
                );
            }
            Err(error) => {
                let detail = match error {
                    tauri::Error::JoinError(join_error) if join_error.is_panic() => {
                        let panic_text = panic_payload_text(join_error.into_panic());
                        format!("spawn_blocking panic: {panic_text}")
                    }
                    other => other.to_string(),
                };
                app_logger::error_with_context("start_source_inspect_job/read_dataset_sheet_header_join", &detail);
                emit_source_inspect_event(
                    &app_handle,
                    SourceInspectJobEvent {
                        job_id: job_id.clone(),
                        source_id: source_id.clone(),
                        status: "failed".to_string(),
                        sheet_name: resolved_sheet_name,
                        preview: Some(preview),
                        header: None,
                        error: Some(detail),
                    },
                );
            }
        }
    });

    Ok(return_job_id)
}

#[tauri::command]
async fn run_engine_process_task(
    app: AppHandle,
    input: engine_backend::BackendEngineProcessTaskInput,
) -> Result<engine_backend::BackendEngineProcessTaskResult, String> {
    let app_handle = app.clone();
    match spawn_blocking(move || engine_backend::run_engine_process_task(&app_handle, input)).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error)) => Err(log_command_error("run_engine_process_task", error)),
        Err(error) => Err(log_command_error("run_engine_process_task_join", error.to_string())),
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
        .map_err(|err| log_command_error("fetch_slogan/send", err.to_string()))?;

    let body = response
        .text()
        .await
        .map_err(|err| log_command_error("fetch_slogan/text", err.to_string()))?;
    parse_slogan_from_body(&body).ok_or_else(|| log_command_error("fetch_slogan/parse", "未获取到有效文案"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            match app_logger::initialize(&app.handle()) {
                Ok(log_path) => {
                    app_logger::install_panic_hook();
                    app_logger::info(format!("应用启动完成，日志文件：{}", log_path.display()));
                }
                Err(error) => {
                    eprintln!("failed to initialize logger: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restart_app,
            fetch_slogan,
            write_text_file,
            read_text_file,
            write_binary_file,
            append_app_log,
            run_python_transform,
            run_python_transform_for_dataset,
            run_python_transform_for_path,
            start_source_inspect_job,
            run_engine_process_task,
            dataset_cache::import_spreadsheet_dataset,
            dataset_cache::import_spreadsheet_dataset_from_path,
            dataset_cache::inspect_spreadsheet_from_path,
            dataset_cache::read_dataset_sheet_header,
            dataset_cache::read_spreadsheet_sheet_header_from_path,
            dataset_cache::read_dataset_sheet_preview,
            dataset_cache::read_dataset_sheet_rows,
            dataset_cache::read_dataset_sheet_page
        ]);

    if let Err(error) = builder.run(tauri::generate_context!()) {
        app_logger::error(format!("error while running tauri application: {error}"));
    }
}
