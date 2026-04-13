use std::{
    env,
    fs::{self, File, OpenOptions},
    io::Write,
    panic::{self, PanicHookInfo},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager};

struct LoggerState {
    path: PathBuf,
    file: Mutex<File>,
}

static LOGGER: OnceLock<LoggerState> = OnceLock::new();
static PANIC_HOOK_INSTALLED: OnceLock<()> = OnceLock::new();

fn timestamp_text() -> String {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => {
            let seconds = duration.as_secs();
            let millis = duration.subsec_millis();
            format!("{seconds}.{millis:03}")
        }
        Err(_) => "0.000".to_string(),
    }
}

fn build_log_line(level: &str, message: &str) -> String {
    format!("[{}] [{}] {}", timestamp_text(), level, message.trim())
}

fn write_line(level: &str, message: &str) {
    let normalized = message.trim();
    if normalized.is_empty() {
        return;
    }

    let line = build_log_line(level, normalized);
    if let Some(logger) = LOGGER.get() {
        match logger.file.lock() {
            Ok(mut file) => {
                let _ = writeln!(file, "{line}");
                let _ = file.flush();
            }
            Err(poisoned) => {
                let mut file = poisoned.into_inner();
                let _ = writeln!(file, "{line}");
                let _ = file.flush();
            }
        }
        return;
    }

    eprintln!("{line}");
}

fn panic_payload_text(info: &PanicHookInfo<'_>) -> String {
    if let Some(text) = info.payload().downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = info.payload().downcast_ref::<String>() {
        return text.clone();
    }
    "unknown panic payload".to_string()
}

fn open_log_file(path: &Path) -> Result<File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())
}

fn set_logger(path: PathBuf, file: File) -> Result<PathBuf, String> {
    if LOGGER
        .set(LoggerState {
            path: path.clone(),
            file: Mutex::new(file),
        })
        .is_err()
    {
        if let Some(logger) = LOGGER.get() {
            return Ok(logger.path.clone());
        }
    }

    Ok(path)
}

pub fn initialize(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(logger) = LOGGER.get() {
        return Ok(logger.path.clone());
    }

    let mut primary_error = String::new();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let log_path = app_data_dir.join("logs").join("app.log");
        match open_log_file(&log_path) {
            Ok(file) => {
                let log_path = set_logger(log_path, file)?;
                info(format!("日志系统已初始化：{}", log_path.display()));
                return Ok(log_path);
            }
            Err(error) => {
                primary_error = format!("应用数据目录日志初始化失败：{error}");
            }
        }
    } else if let Err(error) = app.path().app_data_dir() {
        primary_error = format!("应用数据目录解析失败：{error}");
    }

    let fallback_log_path = env::temp_dir()
        .join("Dr.SheetSplit")
        .join("logs")
        .join("app.log");
    let fallback_file = open_log_file(&fallback_log_path).map_err(|fallback_error| {
        if primary_error.is_empty() {
            format!("临时目录日志初始化失败：{fallback_error}")
        } else {
            format!("{primary_error}；临时目录日志初始化失败：{fallback_error}")
        }
    })?;
    let log_path = set_logger(fallback_log_path, fallback_file)?;

    info(format!("日志系统已初始化：{}", log_path.display()));
    if !primary_error.is_empty() {
        warn(primary_error);
        warn("已自动回退到临时目录日志。");
    }
    Ok(log_path)
}

pub fn install_panic_hook() {
    PANIC_HOOK_INSTALLED.get_or_init(|| {
        let previous_hook = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let location = info
                .location()
                .map(|item| format!("{}:{}:{}", item.file(), item.line(), item.column()))
                .unwrap_or_else(|| "unknown location".to_string());
            let payload = panic_payload_text(info);
            error(format!("应用发生 panic，位置：{location}，信息：{payload}"));
            previous_hook(info);
        }));
    });
}

pub fn info(message: impl AsRef<str>) {
    write_line("INFO", message.as_ref());
}

pub fn warn(message: impl AsRef<str>) {
    write_line("WARN", message.as_ref());
}

pub fn error(message: impl AsRef<str>) {
    write_line("ERROR", message.as_ref());
}

pub fn error_with_context(context: &str, detail: impl AsRef<str>) {
    error(format!("{context}: {}", detail.as_ref()));
}

#[allow(dead_code)]
pub fn append_raw(level: &str, message: impl AsRef<str>) {
    write_line(level, message.as_ref());
}
