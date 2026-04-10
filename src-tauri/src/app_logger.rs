use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    panic::{self, PanicHookInfo},
    path::PathBuf,
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

pub fn initialize(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(logger) = LOGGER.get() {
        return Ok(logger.path.clone());
    }

    let app_data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let logs_dir = app_data_dir.join("logs");
    fs::create_dir_all(&logs_dir).map_err(|error| error.to_string())?;

    let log_path = logs_dir.join("app.log");
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;

    if LOGGER
        .set(LoggerState {
            path: log_path.clone(),
            file: Mutex::new(file),
        })
        .is_err()
    {
        if let Some(logger) = LOGGER.get() {
            return Ok(logger.path.clone());
        }
    }

    info(format!("日志系统已初始化：{}", log_path.display()));
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
