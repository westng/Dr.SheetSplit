use std::{
    any::Any,
    fs,
    io::Cursor,
    io::{Read, Seek},
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use std::collections::HashMap;

use base64::Engine;
use calamine::{open_workbook_auto, open_workbook_auto_from_rs, Data, Range, Reader};
use csv::{ReaderBuilder, WriterBuilder};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::{app_logger, xlsx_fallback};

const HEADER_CONTEXT_ROW_LIMIT: usize = 8;
const PREVIEW_ROW_LIMIT: usize = 64;
const PROCESS_LOG_EVENT: &str = "process-log";
static DATASET_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSheetSummary {
    pub name: String,
    pub row_count: usize,
    pub column_count: usize,
    pub preview_row_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetImportResult {
    pub dataset_id: String,
    pub file_name: String,
    pub imported_at_ms: u64,
    pub sheets: Vec<DatasetSheetSummary>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSheetRowsResult {
    pub name: String,
    pub raw_rows: Vec<Vec<String>>,
    pub row_count: usize,
    pub data_mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetSheetPageResult {
    pub name: String,
    pub headers: Vec<String>,
    pub rows: Vec<HashMap<String, String>>,
    pub row_count: usize,
}

#[derive(Clone)]
struct ProcessColumn {
    source_index: usize,
    header: String,
}

struct ImportedSheetMeta {
    name: String,
    row_count: usize,
    column_count: usize,
    header_rows_json: String,
    preview_row_count: usize,
    preview_rows_json: String,
    table_name: String,
}

#[derive(Clone, Serialize)]
struct ProcessLogPayload {
    message: String,
}

fn current_timestamp_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|err| err.to_string())
}

fn emit_process_log(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit(
        PROCESS_LOG_EVENT,
        ProcessLogPayload {
            message: message.into(),
        },
    );
}

fn log_command_result<T>(context: &str, result: Result<T, String>) -> Result<T, String> {
    result.map_err(|error| {
        app_logger::error_with_context(context, &error);
        error
    })
}

fn panic_payload_to_text(payload: Box<dyn Any + Send>) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        return (*text).to_string();
    }
    if let Some(text) = payload.downcast_ref::<String>() {
        return text.clone();
    }
    "unknown panic payload".to_string()
}

pub(crate) fn spreadsheet_panic_user_message() -> String {
    if cfg!(target_os = "windows") {
        "当前文件在 Windows 环境解析时发生异常，请先用 Excel 或 WPS 将文件另存为标准 .xlsx 后重试。".to_string()
    } else {
        "当前文件解析时发生异常，请尝试将文件另存为标准 .xlsx 后重试。".to_string()
    }
}

fn guard_spreadsheet_operation<T>(
    context: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(result) => result,
        Err(payload) => {
            let panic_text = panic_payload_to_text(payload);
            app_logger::error_with_context(context, format!("spreadsheet parser panic: {panic_text}"));
            Err(spreadsheet_panic_user_message())
        }
    }
}

fn next_dataset_id() -> Result<String, String> {
    let timestamp = current_timestamp_ms()?;
    let counter = DATASET_COUNTER.fetch_add(1, Ordering::Relaxed);
    Ok(format!("ds_{timestamp}_{counter}"))
}

fn resolve_dataset_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|err| err.to_string())?;
    Ok(app_data_dir.join("datasets.sqlite"))
}

fn open_dataset_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = resolve_dataset_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|err| err.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|err| err.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|err| err.to_string())?;
    Ok(conn)
}

fn table_has_column(conn: &Connection, table_name: &str, column_name: &str) -> Result<bool, String> {
    let mut statement = conn
        .prepare(&format!(r#"PRAGMA table_info("{table_name}")"#))
        .map_err(|err| err.to_string())?;
    let column_iter = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| err.to_string())?;

    for column in column_iter {
        if column.map_err(|err| err.to_string())? == column_name {
            return Ok(true);
        }
    }

    Ok(false)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS datasets (
          dataset_id VARCHAR PRIMARY KEY,
          file_name VARCHAR NOT NULL,
          file_path VARCHAR NOT NULL DEFAULT '',
          imported_at_ms BIGINT NOT NULL,
          sheet_count INTEGER NOT NULL,
          total_row_count BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dataset_sheets (
          dataset_id VARCHAR NOT NULL,
          sheet_name VARCHAR NOT NULL,
          sheet_index INTEGER NOT NULL,
          row_count BIGINT NOT NULL,
          column_count INTEGER NOT NULL,
          header_rows_json VARCHAR NOT NULL DEFAULT '[]',
          preview_row_count INTEGER NOT NULL,
          preview_rows_json VARCHAR NOT NULL,
          table_name VARCHAR NOT NULL,
          PRIMARY KEY (dataset_id, sheet_name)
        );
        "#,
    )
    .map_err(|err| err.to_string())?;

    if !table_has_column(conn, "datasets", "file_path")? {
        conn.execute("ALTER TABLE datasets ADD COLUMN file_path VARCHAR", [])
            .map_err(|err| err.to_string())?;
    }

    conn.execute(
        "UPDATE datasets SET file_path = '' WHERE file_path IS NULL",
        [],
    )
    .map_err(|err| err.to_string())?;

    if !table_has_column(conn, "dataset_sheets", "header_rows_json")? {
        conn.execute("ALTER TABLE dataset_sheets ADD COLUMN header_rows_json VARCHAR", [])
            .map_err(|err| err.to_string())?;
    }

    conn.execute(
        "UPDATE dataset_sheets SET header_rows_json = '[]' WHERE header_rows_json IS NULL",
        [],
    )
    .map_err(|err| err.to_string())?;

    Ok(())
}

fn sanitize_table_name(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            result.push(ch);
        } else {
            result.push('_');
        }
    }
    if result.is_empty() {
        "dataset_rows".to_string()
    } else {
        result
    }
}

fn normalize_header(value: &str, index: usize) -> String {
    let normalized = value.trim();
    if normalized.is_empty() {
        format!("Column_{}", index + 1)
    } else {
        normalized.to_string()
    }
}

fn is_date_header(value: &str) -> bool {
    value.len() == 8 && value.chars().all(|ch| ch.is_ascii_digit())
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        _ => cell.to_string().trim().to_string(),
    }
}

fn get_text_row_value(row: &[String], index: usize) -> String {
    row.get(index)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn insert_sheet_range(
    conn: &mut Connection,
    table_name: &str,
    range: &Range<Data>,
) -> Result<(usize, usize, String, String), String> {
    conn.execute_batch(&format!(
        r#"
        CREATE TABLE "{table_name}" (
          row_index BIGINT NOT NULL,
          row_json VARCHAR NOT NULL
        );
        "#
    ))
    .map_err(|err| err.to_string())?;

    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let (row_count, column_count, header_rows_json, preview_rows_json) = {
        let mut statement = tx
            .prepare(&format!(
                r#"INSERT INTO "{table_name}" (row_index, row_json) VALUES (?, ?)"#
            ))
            .map_err(|err| err.to_string())?;

        let mut row_count = 0usize;
        let mut column_count = 0usize;
        let mut header_rows = Vec::new();
        let mut preview_rows = Vec::new();

        for row in range.rows() {
            let values = row.iter().map(cell_to_string).collect::<Vec<String>>();
            if values.iter().all(|value| value.is_empty()) {
                continue;
            }
            column_count = column_count.max(values.len());
            if header_rows.len() < HEADER_CONTEXT_ROW_LIMIT {
                header_rows.push(values.clone());
            }
            if preview_rows.len() < PREVIEW_ROW_LIMIT {
                preview_rows.push(values.clone());
            }
            let row_json = serde_json::to_string(&values).map_err(|err| err.to_string())?;
            statement
                .execute(params![row_count as i64, row_json])
                .map_err(|err| err.to_string())?;
            row_count += 1;
        }

        let header_rows_json =
            serde_json::to_string(&header_rows).map_err(|err| err.to_string())?;
        let preview_rows_json =
            serde_json::to_string(&preview_rows).map_err(|err| err.to_string())?;
        (row_count, column_count, header_rows_json, preview_rows_json)
    };
    tx.commit().map_err(|err| err.to_string())?;
    Ok((row_count, column_count, header_rows_json, preview_rows_json))
}

fn insert_sheet_rows(
    conn: &mut Connection,
    table_name: &str,
    rows: &[Vec<String>],
) -> Result<(usize, usize, String, String), String> {
    conn.execute_batch(&format!(
        r#"
        CREATE TABLE "{table_name}" (
          row_index BIGINT NOT NULL,
          row_json VARCHAR NOT NULL
        );
        "#
    ))
    .map_err(|err| err.to_string())?;

    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let (row_count, column_count, header_rows_json, preview_rows_json) = {
        let mut statement = tx
            .prepare(&format!(
                r#"INSERT INTO "{table_name}" (row_index, row_json) VALUES (?, ?)"#
            ))
            .map_err(|err| err.to_string())?;

        let mut row_count = 0usize;
        let mut column_count = 0usize;
        let mut header_rows = Vec::new();
        let mut preview_rows = Vec::new();

        for row in rows {
            if row.iter().all(|value| value.trim().is_empty()) {
                continue;
            }
            column_count = column_count.max(row.len());
            if header_rows.len() < HEADER_CONTEXT_ROW_LIMIT {
                header_rows.push(row.clone());
            }
            if preview_rows.len() < PREVIEW_ROW_LIMIT {
                preview_rows.push(row.clone());
            }
            let row_json = serde_json::to_string(row).map_err(|err| err.to_string())?;
            statement
                .execute(params![row_count as i64, row_json])
                .map_err(|err| err.to_string())?;
            row_count += 1;
        }

        let header_rows_json =
            serde_json::to_string(&header_rows).map_err(|err| err.to_string())?;
        let preview_rows_json =
            serde_json::to_string(&preview_rows).map_err(|err| err.to_string())?;
        (row_count, column_count, header_rows_json, preview_rows_json)
    };
    tx.commit().map_err(|err| err.to_string())?;
    Ok((row_count, column_count, header_rows_json, preview_rows_json))
}

fn load_sheet_rows(
    conn: &Connection,
    dataset_id: &str,
    sheet_name: &str,
) -> Result<Vec<Vec<String>>, String> {
    let mut meta_statement = conn
        .prepare(
            r#"
            SELECT table_name
            FROM dataset_sheets
            WHERE dataset_id = ? AND sheet_name = ?
            "#,
        )
        .map_err(|err| err.to_string())?;

    let table_name: String = meta_statement
        .query_row(params![dataset_id, sheet_name], |row| row.get(0))
        .map_err(|err| err.to_string())?;

    if table_name.trim().is_empty() {
        return Err("目标 Sheet 尚未物化缓存。".to_string());
    }

    let mut rows_statement = conn
        .prepare(&format!(
            r#"SELECT row_json FROM "{table_name}" ORDER BY row_index ASC"#
        ))
        .map_err(|err| err.to_string())?;

    let row_iter = rows_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;

    let mut raw_rows = Vec::new();
    for row_result in row_iter {
        let row_json = row_result.map_err(|err| err.to_string())?;
        let row = serde_json::from_str::<Vec<String>>(&row_json).map_err(|err| err.to_string())?;
        raw_rows.push(row);
    }

    Ok(raw_rows)
}

fn load_sheet_rows_page(
    conn: &Connection,
    dataset_id: &str,
    sheet_name: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<Vec<String>>, String> {
    let mut meta_statement = conn
        .prepare(
            r#"
            SELECT table_name
            FROM dataset_sheets
            WHERE dataset_id = ? AND sheet_name = ?
            "#,
        )
        .map_err(|err| err.to_string())?;

    let table_name: String = meta_statement
        .query_row(params![dataset_id, sheet_name], |row| row.get(0))
        .map_err(|err| err.to_string())?;

    if table_name.trim().is_empty() {
        return Err("目标 Sheet 尚未物化缓存。".to_string());
    }

    let mut rows_statement = conn
        .prepare(&format!(
            r#"SELECT row_json FROM "{table_name}" ORDER BY row_index ASC LIMIT ? OFFSET ?"#
        ))
        .map_err(|err| err.to_string())?;

    let row_iter = rows_statement
        .query_map(params![limit as i64, offset as i64], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;

    let mut raw_rows = Vec::new();
    for row_result in row_iter {
        let row_json = row_result.map_err(|err| err.to_string())?;
        let row = serde_json::from_str::<Vec<String>>(&row_json).map_err(|err| err.to_string())?;
        raw_rows.push(row);
    }

    Ok(raw_rows)
}

fn import_workbook_eager<RS, W>(
    conn: &mut Connection,
    workbook: &mut W,
    dataset_id: &str,
    file_name: &str,
    file_path: &str,
    imported_at_ms: u64,
) -> Result<DatasetImportResult, String>
where
    RS: Read + Seek,
    W: Reader<RS>,
    W::Error: std::fmt::Display,
{
    ensure_schema(conn)?;

    let sheet_names = workbook.sheet_names().to_vec();
    let mut sheet_metas = Vec::with_capacity(sheet_names.len());
    let mut total_row_count = 0usize;

    for (sheet_index, sheet_name) in sheet_names.iter().enumerate() {
        let range = workbook
            .worksheet_range(sheet_name)
            .map_err(|err| err.to_string())?;
        let table_name =
            sanitize_table_name(&format!("dataset_{}_sheet_{}", dataset_id, sheet_index));
        let (row_count, column_count, header_rows_json, preview_rows_json) =
            insert_sheet_range(conn, &table_name, &range)?;
        total_row_count += row_count;
        sheet_metas.push(ImportedSheetMeta {
            name: sheet_name.clone(),
            row_count,
            column_count,
            header_rows_json,
            preview_row_count: row_count.min(PREVIEW_ROW_LIMIT),
            preview_rows_json,
            table_name,
        });
    }

    conn.execute(
        r#"
        INSERT INTO datasets (dataset_id, file_name, file_path, imported_at_ms, sheet_count, total_row_count)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
        params![
            dataset_id,
            file_name,
            file_path,
            imported_at_ms as i64,
            sheet_metas.len() as i64,
            total_row_count as i64
        ],
    )
    .map_err(|err| err.to_string())?;

    let mut sheets = Vec::with_capacity(sheet_metas.len());
    for (sheet_index, sheet) in sheet_metas.iter().enumerate() {
        conn.execute(
            r#"
            INSERT INTO dataset_sheets (
              dataset_id,
              sheet_name,
              sheet_index,
              row_count,
              column_count,
              header_rows_json,
              preview_row_count,
              preview_rows_json,
              table_name
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                dataset_id,
                sheet.name.as_str(),
                sheet_index as i64,
                sheet.row_count as i64,
                sheet.column_count as i64,
                sheet.header_rows_json.as_str(),
                sheet.preview_row_count as i64,
                sheet.preview_rows_json.as_str(),
                sheet.table_name.as_str(),
            ],
        )
        .map_err(|err| err.to_string())?;

        sheets.push(DatasetSheetSummary {
            name: sheet.name.clone(),
            row_count: sheet.row_count,
            column_count: sheet.column_count,
            preview_row_count: sheet.preview_row_count,
        });
    }

    Ok(DatasetImportResult {
        dataset_id: dataset_id.to_string(),
        file_name: file_name.to_string(),
        imported_at_ms,
        sheets,
    })
}

fn import_workbook_lazy<RS, W>(
    conn: &mut Connection,
    workbook: &mut W,
    dataset_id: &str,
    file_name: &str,
    file_path: &str,
    imported_at_ms: u64,
) -> Result<DatasetImportResult, String>
where
    RS: Read + Seek,
    W: Reader<RS>,
{
    ensure_schema(conn)?;

    let sheet_names = workbook.sheet_names().to_vec();
    conn.execute(
        r#"
        INSERT INTO datasets (dataset_id, file_name, file_path, imported_at_ms, sheet_count, total_row_count)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
        params![
            dataset_id,
            file_name,
            file_path,
            imported_at_ms as i64,
            sheet_names.len() as i64,
            0i64
        ],
    )
    .map_err(|err| err.to_string())?;

    let mut sheets = Vec::with_capacity(sheet_names.len());
    for (sheet_index, sheet_name) in sheet_names.iter().enumerate() {
        conn.execute(
            r#"
            INSERT INTO dataset_sheets (
              dataset_id,
              sheet_name,
              sheet_index,
              row_count,
              column_count,
              header_rows_json,
              preview_row_count,
              preview_rows_json,
              table_name
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                dataset_id,
                sheet_name.as_str(),
                sheet_index as i64,
                0i64,
                0i64,
                "[]",
                0i64,
                "[]",
                "",
            ],
        )
        .map_err(|err| err.to_string())?;

        sheets.push(DatasetSheetSummary {
            name: sheet_name.clone(),
            row_count: 0,
            column_count: 0,
            preview_row_count: 0,
        });
    }

    Ok(DatasetImportResult {
        dataset_id: dataset_id.to_string(),
        file_name: file_name.to_string(),
        imported_at_ms,
        sheets,
    })
}

fn import_fallback_workbook_eager(
    conn: &mut Connection,
    workbook: &xlsx_fallback::FallbackWorkbook,
    dataset_id: &str,
    file_name: &str,
    file_path: &str,
    imported_at_ms: u64,
) -> Result<DatasetImportResult, String> {
    ensure_schema(conn)?;

    let mut sheet_metas = Vec::with_capacity(workbook.sheets.len());
    let mut total_row_count = 0usize;

    for (sheet_index, sheet) in workbook.sheets.iter().enumerate() {
        let table_name =
            sanitize_table_name(&format!("dataset_{}_sheet_{}", dataset_id, sheet_index));
        let (row_count, column_count, header_rows_json, preview_rows_json) =
            insert_sheet_rows(conn, &table_name, &sheet.rows)?;
        total_row_count += row_count;
        sheet_metas.push(ImportedSheetMeta {
            name: sheet.name.clone(),
            row_count,
            column_count,
            header_rows_json,
            preview_row_count: row_count.min(PREVIEW_ROW_LIMIT),
            preview_rows_json,
            table_name,
        });
    }

    conn.execute(
        r#"
        INSERT INTO datasets (dataset_id, file_name, file_path, imported_at_ms, sheet_count, total_row_count)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
        params![
            dataset_id,
            file_name,
            file_path,
            imported_at_ms as i64,
            sheet_metas.len() as i64,
            total_row_count as i64
        ],
    )
    .map_err(|err| err.to_string())?;

    let mut sheets = Vec::with_capacity(sheet_metas.len());
    for (sheet_index, sheet) in sheet_metas.iter().enumerate() {
        conn.execute(
            r#"
            INSERT INTO dataset_sheets (
              dataset_id,
              sheet_name,
              sheet_index,
              row_count,
              column_count,
              header_rows_json,
              preview_row_count,
              preview_rows_json,
              table_name
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
            params![
                dataset_id,
                sheet.name.as_str(),
                sheet_index as i64,
                sheet.row_count as i64,
                sheet.column_count as i64,
                sheet.header_rows_json.as_str(),
                sheet.preview_row_count as i64,
                sheet.preview_rows_json.as_str(),
                sheet.table_name.as_str(),
            ],
        )
        .map_err(|err| err.to_string())?;

        sheets.push(DatasetSheetSummary {
            name: sheet.name.clone(),
            row_count: sheet.row_count,
            column_count: sheet.column_count,
            preview_row_count: sheet.preview_row_count,
        });
    }

    Ok(DatasetImportResult {
        dataset_id: dataset_id.to_string(),
        file_name: file_name.to_string(),
        imported_at_ms,
        sheets,
    })
}

fn get_dataset_file_path(conn: &Connection, dataset_id: &str) -> Result<String, String> {
    let mut statement = conn
        .prepare("SELECT file_path FROM datasets WHERE dataset_id = ?")
        .map_err(|err| err.to_string())?;
    let file_path: String = statement
        .query_row(params![dataset_id], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    if file_path.trim().is_empty() {
        return Err("当前数据集未记录源文件路径。".to_string());
    }
    Ok(file_path)
}

fn get_dataset_source_info(conn: &Connection, dataset_id: &str) -> Result<(String, String), String> {
    let mut statement = conn
        .prepare("SELECT file_path, file_name FROM datasets WHERE dataset_id = ?")
        .map_err(|err| err.to_string())?;
    let result = statement
        .query_row(params![dataset_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?;
    Ok(result)
}

fn detect_source_format(file_path: &str, file_name: &str) -> String {
    let candidate = if !file_path.trim().is_empty() {
        file_path
    } else {
        file_name
    };
    Path::new(candidate)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn is_windows_ooxml_format(source_format: &str) -> bool {
    matches!(source_format, "xlsx" | "xlsm" | "xltx" | "xltm")
}

fn should_force_windows_ooxml_fallback(file_path: &str, file_name: &str) -> bool {
    cfg!(target_os = "windows")
        && is_windows_ooxml_format(&detect_source_format(file_path, file_name))
}

fn collect_range_rows(range: &Range<Data>) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    for row in range.rows() {
        let values = row.iter().map(cell_to_string).collect::<Vec<String>>();
        if values.iter().all(|value| value.is_empty()) {
            continue;
        }
        rows.push(values);
    }
    rows
}

fn read_sheet_rows_from_path(file_path: &str, sheet_name: &str) -> Result<Vec<Vec<String>>, String> {
    let normalized_path = file_path.trim();
    let file_name = Path::new(normalized_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(normalized_path);

    if should_force_windows_ooxml_fallback(normalized_path, file_name) {
        let workbook = xlsx_fallback::read_xlsx_from_path(Path::new(normalized_path))?;
        let sheet = workbook
            .sheets
            .into_iter()
            .find(|sheet| sheet.name == sheet_name)
            .ok_or_else(|| format!("未找到工作表：{}", sheet_name))?;
        return Ok(sheet.rows);
    }

    let mut workbook =
        open_workbook_auto(Path::new(normalized_path)).map_err(|err| err.to_string())?;
    let range = workbook
        .worksheet_range(sheet_name)
        .map_err(|err| err.to_string())?;
    Ok(collect_range_rows(&range))
}

fn resolve_sheet_csv_cache_path(
    app: &AppHandle,
    dataset_id: &str,
    sheet_name: &str,
) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let process_cache_dir = app_data_dir.join("process-cache");
    fs::create_dir_all(&process_cache_dir).map_err(|err| err.to_string())?;
    Ok(process_cache_dir.join(format!(
        "{}_{}.csv",
        sanitize_table_name(dataset_id),
        sanitize_table_name(sheet_name)
    )))
}

fn export_sheet_to_csv(
    source_file_path: &str,
    sheet_name: &str,
    target_csv_path: &Path,
) -> Result<(), String> {
    let mut writer = WriterBuilder::new()
        .has_headers(false)
        .from_path(target_csv_path)
        .map_err(|err| err.to_string())?;

    for row in read_sheet_rows_from_path(source_file_path, sheet_name)? {
        writer.write_record(row).map_err(|err| err.to_string())?;
    }

    writer.flush().map_err(|err| err.to_string())
}

fn load_csv_rows(csv_path: &Path) -> Result<Vec<Vec<String>>, String> {
    let mut reader = ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_path(csv_path)
        .map_err(|err| err.to_string())?;

    let mut rows = Vec::new();
    for record in reader.records() {
        let row = record
            .map_err(|err| err.to_string())?
            .iter()
            .map(|value| value.trim().to_string())
            .collect::<Vec<String>>();
        if row.iter().all(|value| value.is_empty()) {
            continue;
        }
        rows.push(row);
    }

    Ok(rows)
}

fn load_process_rows(
    app: &AppHandle,
    conn: &mut Connection,
    dataset_id: &str,
    sheet_name: &str,
) -> Result<Vec<Vec<String>>, String> {
    let (file_path, file_name) = get_dataset_source_info(conn, dataset_id)?;
    let source_format = detect_source_format(&file_path, &file_name);
    emit_process_log(app, format!("正在检测源文件格式：{}。", source_format));

    match source_format.as_str() {
        "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" => {
            if file_path.trim().is_empty() {
                emit_process_log(app, "未记录源文件路径，回退到缓存数据处理。");
                ensure_materialized_sheet(app, conn, dataset_id, sheet_name)?;
                return load_sheet_rows(conn, dataset_id, sheet_name);
            }

            let csv_cache_path = resolve_sheet_csv_cache_path(app, dataset_id, sheet_name)?;
            if !csv_cache_path.exists() {
                emit_process_log(app, "检测到 Excel 文件，正在转换为 CSV 临时缓存...");
                export_sheet_to_csv(&file_path, sheet_name, &csv_cache_path)?;
            } else {
                emit_process_log(app, "已命中 CSV 临时缓存，正在直接读取...");
            }
            emit_process_log(app, "正在读取 CSV 数据...");
            load_csv_rows(&csv_cache_path)
        }
        "csv" => {
            if file_path.trim().is_empty() {
                emit_process_log(app, "未记录 CSV 源文件路径，回退到缓存数据处理。");
                ensure_materialized_sheet(app, conn, dataset_id, sheet_name)?;
                return load_sheet_rows(conn, dataset_id, sheet_name);
            }
            emit_process_log(app, "检测到 CSV 文件，正在直接读取数据...");
            load_csv_rows(Path::new(&file_path))
        }
        _ => {
            emit_process_log(app, "当前格式未启用 CSV 直连处理，正在使用缓存数据...");
            ensure_materialized_sheet(app, conn, dataset_id, sheet_name)?;
            load_sheet_rows(conn, dataset_id, sheet_name)
        }
    }
}

fn parse_sheet_header_from_path(
    file_path: &str,
    sheet_name: &str,
) -> Result<(Vec<Vec<String>>, usize), String> {
    let rows = read_sheet_rows_from_path(file_path, sheet_name)?;
    let mut header_rows = Vec::new();
    let mut column_count = 0usize;
    for row in rows {
        column_count = column_count.max(row.len());
        header_rows.push(row);
        if header_rows.len() >= HEADER_CONTEXT_ROW_LIMIT {
            break;
        }
    }

    Ok((header_rows, column_count))
}

fn ensure_materialized_sheet(
    app: &AppHandle,
    conn: &mut Connection,
    dataset_id: &str,
    sheet_name: &str,
) -> Result<(), String> {
    let table_name: String = {
        let mut statement = conn
            .prepare(
                r#"
                SELECT table_name
                FROM dataset_sheets
                WHERE dataset_id = ? AND sheet_name = ?
                "#,
            )
            .map_err(|err| err.to_string())?;
        statement
            .query_row(params![dataset_id, sheet_name], |row| row.get(0))
            .map_err(|err| err.to_string())?
    };
    if !table_name.trim().is_empty() {
        return Ok(());
    }

    let file_path = get_dataset_file_path(conn, dataset_id)?;
    let next_table_name = sanitize_table_name(&format!("dataset_{}_sheet_cache_{}", dataset_id, sheet_name));
    let rows = read_sheet_rows_from_path(&file_path, sheet_name)?;
    let (row_count, column_count, header_rows_json, preview_rows_json) =
        insert_sheet_rows(conn, &next_table_name, &rows)?;

    conn.execute(
        r#"
        UPDATE dataset_sheets
        SET row_count = ?, column_count = ?, header_rows_json = ?, preview_row_count = ?, preview_rows_json = ?, table_name = ?
        WHERE dataset_id = ? AND sheet_name = ?
        "#,
        params![
            row_count as i64,
            column_count as i64,
            header_rows_json,
            row_count.min(PREVIEW_ROW_LIMIT) as i64,
            preview_rows_json,
            next_table_name,
            dataset_id,
            sheet_name
        ],
    )
    .map_err(|err| err.to_string())?;

    let _ = app;
    Ok(())
}

#[tauri::command]
pub fn read_dataset_sheet_header(
    app: AppHandle,
    dataset_id: String,
    sheet_name: String,
) -> Result<DatasetSheetRowsResult, String> {
    log_command_result("read_dataset_sheet_header", guard_spreadsheet_operation("read_dataset_sheet_header", || {
        let conn = open_dataset_db(&app)?;
        ensure_schema(&conn)?;

        let mut statement = conn
            .prepare(
                r#"
                SELECT header_rows_json, column_count
                FROM dataset_sheets
                WHERE dataset_id = ? AND sheet_name = ?
                "#,
            )
            .map_err(|err| err.to_string())?;

        let (header_rows_json, column_count): (String, i64) = statement
            .query_row(params![dataset_id.as_str(), sheet_name.as_str()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|err| err.to_string())?;

        if header_rows_json != "[]" || column_count > 0 {
            let raw_rows =
                serde_json::from_str::<Vec<Vec<String>>>(&header_rows_json).map_err(|err| err.to_string())?;
            return Ok(DatasetSheetRowsResult {
                name: sheet_name,
                raw_rows,
                row_count: 0,
                data_mode: "header".to_string(),
            });
        }

        let file_path = get_dataset_file_path(&conn, &dataset_id)?;
        let (header_rows, actual_column_count) = parse_sheet_header_from_path(&file_path, &sheet_name)?;
        let header_rows_json = serde_json::to_string(&header_rows).map_err(|err| err.to_string())?;
        conn.execute(
            r#"
            UPDATE dataset_sheets
            SET column_count = ?, header_rows_json = ?
            WHERE dataset_id = ? AND sheet_name = ?
            "#,
            params![
                actual_column_count as i64,
                header_rows_json,
                dataset_id.as_str(),
                sheet_name.as_str()
            ],
        )
        .map_err(|err| err.to_string())?;

        Ok(DatasetSheetRowsResult {
            name: sheet_name,
            raw_rows: header_rows,
            row_count: 0,
            data_mode: "header".to_string(),
        })
    }))
}

fn build_process_columns(
    raw_rows: &[Vec<String>],
    header_row_index: usize,
    group_header_row_index: usize,
    group_name: &str,
) -> Vec<ProcessColumn> {
    let header_row = raw_rows
        .get(header_row_index.saturating_sub(1))
        .cloned()
        .unwrap_or_default();
    let group_header_row = if group_header_row_index > 0 {
        raw_rows
            .get(group_header_row_index - 1)
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let selected_group_name = group_name.trim();
    let column_count = header_row.len().max(group_header_row.len());
    let mut used_headers = std::collections::HashSet::new();
    let mut columns = Vec::new();

    for index in 0..column_count {
        let child_header = get_text_row_value(&header_row, index);
        let group_header = get_text_row_value(&group_header_row, index);
        let child_is_date = is_date_header(&child_header);
        if !selected_group_name.is_empty() && child_is_date && group_header != selected_group_name
        {
            continue;
        }

        let mut next_header = normalize_header(&child_header, index);
        if selected_group_name.is_empty() && child_is_date && !group_header.is_empty() {
            next_header = format!("{group_header}__{child_header}");
        }

        let base_header = next_header.clone();
        let mut suffix = 2usize;
        while used_headers.contains(&next_header) {
            next_header = format!("{base_header}_{suffix}");
            suffix += 1;
        }
        used_headers.insert(next_header.clone());
        columns.push(ProcessColumn {
            source_index: index,
            header: next_header,
        });
    }

    columns
}

fn build_process_sheet_value(
    raw_rows: &[Vec<String>],
    sheet_name: &str,
    header_row_index: usize,
    group_header_row_index: usize,
    group_name: &str,
) -> Value {
    let normalized_header_row_index = header_row_index.max(1);
    let normalized_group_header_row_index = group_header_row_index;
    let columns = build_process_columns(
        raw_rows,
        normalized_header_row_index,
        normalized_group_header_row_index,
        group_name,
    );
    let headers = columns
        .iter()
        .map(|column| Value::String(column.header.clone()))
        .collect::<Vec<_>>();

    let rows = raw_rows
        .iter()
        .skip(normalized_header_row_index)
        .map(|row| {
            let mut object = Map::new();
            for column in &columns {
                object.insert(
                    column.header.clone(),
                    Value::String(get_text_row_value(row, column.source_index)),
                );
            }
            Value::Object(object)
        })
        .collect::<Vec<_>>();

    Value::Object(Map::from_iter([
        ("name".to_string(), Value::String(sheet_name.to_string())),
        ("headers".to_string(), Value::Array(headers)),
        ("rows".to_string(), Value::Array(rows)),
    ]))
}

pub(crate) fn build_python_payload_for_dataset(
    app: &AppHandle,
    base_payload: &str,
    dataset_id: &str,
    sheet_name: &str,
) -> Result<String, String> {
    guard_spreadsheet_operation("build_python_payload_for_dataset", || {
        let mut payload = serde_json::from_str::<Value>(base_payload).map_err(|err| err.to_string())?;
        let payload_object = payload
            .as_object_mut()
            .ok_or_else(|| "处理引擎入参不是合法对象。".to_string())?;
        let rule = payload_object
            .get("rule")
            .and_then(Value::as_object)
            .ok_or_else(|| "处理引擎入参缺少规则配置。".to_string())?;

        let header_row_index = rule
            .get("sourceHeaderRowIndex")
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize;
        let group_header_row_index = rule
            .get("sourceGroupHeaderRowIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let group_name = rule
            .get("sourceGroupName")
            .and_then(Value::as_str)
            .unwrap_or("");

        let mut conn = open_dataset_db(app)?;
        ensure_schema(&conn)?;
        emit_process_log(app, "正在处理数据...");
        let raw_rows = load_process_rows(app, &mut conn, dataset_id, sheet_name)?;
        emit_process_log(app, "正在构建处理数据载荷...");
        let sheet_value = build_process_sheet_value(
            &raw_rows,
            sheet_name,
            header_row_index,
            group_header_row_index,
            group_name,
        );
        payload_object.insert("sheet".to_string(), sheet_value);
        serde_json::to_string(&payload).map_err(|err| err.to_string())
    })
}

fn load_process_rows_from_path(file_path: &str, sheet_name: &str) -> Result<Vec<Vec<String>>, String> {
    let source_format = detect_source_format(file_path, file_path);
    match source_format.as_str() {
        "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" => read_sheet_rows_from_path(file_path, sheet_name),
        "csv" => load_csv_rows(Path::new(file_path)),
        _ => Err(format!("当前文件格式暂不支持按路径直接处理：{}", source_format)),
    }
}

pub(crate) fn build_python_payload_for_path(
    app: &AppHandle,
    base_payload: &str,
    file_path: &str,
    sheet_name: &str,
) -> Result<String, String> {
    guard_spreadsheet_operation("build_python_payload_for_path", || {
        let mut payload = serde_json::from_str::<Value>(base_payload).map_err(|err| err.to_string())?;
        let payload_object = payload
            .as_object_mut()
            .ok_or_else(|| "处理引擎入参不是合法对象。".to_string())?;
        let rule = payload_object
            .get("rule")
            .and_then(Value::as_object)
            .ok_or_else(|| "处理引擎入参缺少规则配置。".to_string())?;

        let header_row_index = rule
            .get("sourceHeaderRowIndex")
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize;
        let group_header_row_index = rule
            .get("sourceGroupHeaderRowIndex")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let group_name = rule
            .get("sourceGroupName")
            .and_then(Value::as_str)
            .unwrap_or("");

        emit_process_log(app, "正在按源文件路径读取处理数据...");
        let raw_rows = load_process_rows_from_path(file_path, sheet_name)?;
        emit_process_log(app, "正在构建处理数据载荷...");
        let sheet_value = build_process_sheet_value(
            &raw_rows,
            sheet_name,
            header_row_index,
            group_header_row_index,
            group_name,
        );
        payload_object.insert("sheet".to_string(), sheet_value);
        serde_json::to_string(&payload).map_err(|err| err.to_string())
    })
}

#[tauri::command]
pub fn import_spreadsheet_dataset(
    app: AppHandle,
    file_name: String,
    content_base64: String,
) -> Result<DatasetImportResult, String> {
    log_command_result("import_spreadsheet_dataset", (|| {
        guard_spreadsheet_operation("import_spreadsheet_dataset", || {
            let dataset_id = next_dataset_id()?;
            let imported_at_ms = current_timestamp_ms()?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(content_base64)
                .map_err(|err| err.to_string())?;
            let cursor = Cursor::new(bytes);
            let mut workbook = open_workbook_auto_from_rs(cursor).map_err(|err| err.to_string())?;
            let mut conn = open_dataset_db(&app)?;
            import_workbook_eager(&mut conn, &mut workbook, &dataset_id, &file_name, "", imported_at_ms)
        })
    })())
}

#[tauri::command]
pub fn import_spreadsheet_dataset_from_path(
    app: AppHandle,
    file_path: String,
) -> Result<DatasetImportResult, String> {
    log_command_result("import_spreadsheet_dataset_from_path", (|| {
        let normalized_path = file_path.trim();
        if normalized_path.is_empty() {
            return Err("导入文件路径不能为空。".to_string());
        }

        let dataset_id = next_dataset_id()?;
        let imported_at_ms = current_timestamp_ms()?;
        let path = Path::new(normalized_path);
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_string())
            .unwrap_or_else(|| normalized_path.to_string());
        let source_format = detect_source_format(normalized_path, &file_name);

        if should_force_windows_ooxml_fallback(normalized_path, &file_name) {
            let workbook = xlsx_fallback::read_xlsx_from_path(path)?;
            let mut conn = open_dataset_db(&app)?;
            return import_fallback_workbook_eager(
                &mut conn,
                &workbook,
                &dataset_id,
                &file_name,
                "",
                imported_at_ms,
            );
        }

        let primary_result = guard_spreadsheet_operation("import_spreadsheet_dataset_from_path", || {
            let mut workbook = open_workbook_auto(path).map_err(|err| err.to_string())?;
            let mut conn = open_dataset_db(&app)?;
            import_workbook_lazy(
                &mut conn,
                &mut workbook,
                &dataset_id,
                &file_name,
                normalized_path,
                imported_at_ms,
            )
        });

        match primary_result {
            Ok(result) => Ok(result),
            Err(primary_error) => {
                if cfg!(target_os = "windows") && is_windows_ooxml_format(&source_format) {
                    app_logger::warn(format!(
                        "import_spreadsheet_dataset_from_path primary parser failed, trying fallback parser: {}",
                        primary_error
                    ));
                    let workbook = xlsx_fallback::read_xlsx_from_path(path)?;
                    let mut conn = open_dataset_db(&app)?;
                    // Clear file_path so later processing uses cached sheet rows instead of reopening the source workbook.
                    return import_fallback_workbook_eager(
                        &mut conn,
                        &workbook,
                        &dataset_id,
                        &file_name,
                        "",
                        imported_at_ms,
                    );
                }
                Err(primary_error)
            }
        }
    })())
}

#[tauri::command]
pub fn inspect_spreadsheet_from_path(file_path: String) -> Result<DatasetImportResult, String> {
    log_command_result("inspect_spreadsheet_from_path", (|| {
        let normalized_path = file_path.trim();
        if normalized_path.is_empty() {
            return Err("导入文件路径不能为空。".to_string());
        }

        let path = Path::new(normalized_path);
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_string())
            .unwrap_or_else(|| normalized_path.to_string());
        let imported_at_ms = current_timestamp_ms()?;
        let source_format = detect_source_format(normalized_path, &file_name);

        if should_force_windows_ooxml_fallback(normalized_path, &file_name) {
            let workbook = xlsx_fallback::read_xlsx_from_path(path)?;
            return Ok(DatasetImportResult {
                dataset_id: String::new(),
                file_name,
                imported_at_ms,
                sheets: workbook
                    .sheets
                    .iter()
                    .map(|sheet| DatasetSheetSummary {
                        name: sheet.name.clone(),
                        row_count: sheet.rows.len(),
                        column_count: sheet.rows.iter().map(|row| row.len()).max().unwrap_or(0),
                        preview_row_count: sheet.rows.len().min(PREVIEW_ROW_LIMIT),
                    })
                    .collect(),
            });
        }

        let primary_result = guard_spreadsheet_operation("inspect_spreadsheet_from_path", || {
            let workbook = open_workbook_auto(path).map_err(|err| err.to_string())?;
            let sheets = workbook
                .sheet_names()
                .iter()
                .map(|sheet_name| DatasetSheetSummary {
                    name: sheet_name.clone(),
                    row_count: 0,
                    column_count: 0,
                    preview_row_count: 0,
                })
                .collect::<Vec<_>>();

            Ok(DatasetImportResult {
                dataset_id: String::new(),
                file_name: file_name.clone(),
                imported_at_ms,
                sheets,
            })
        });

        match primary_result {
            Ok(result) => Ok(result),
            Err(primary_error) => {
                if cfg!(target_os = "windows") && is_windows_ooxml_format(&source_format) {
                    app_logger::warn(format!(
                        "inspect_spreadsheet_from_path primary parser failed, trying fallback parser: {}",
                        primary_error
                    ));
                    let workbook = xlsx_fallback::read_xlsx_from_path(path)?;
                    return Ok(DatasetImportResult {
                        dataset_id: String::new(),
                        file_name,
                        imported_at_ms,
                        sheets: workbook
                            .sheets
                            .iter()
                            .map(|sheet| DatasetSheetSummary {
                                name: sheet.name.clone(),
                                row_count: sheet.rows.len(),
                                column_count: sheet.rows.iter().map(|row| row.len()).max().unwrap_or(0),
                                preview_row_count: sheet.rows.len().min(PREVIEW_ROW_LIMIT),
                            })
                            .collect(),
                    });
                }
                Err(primary_error)
            }
        }
    })())
}

#[tauri::command]
pub fn read_spreadsheet_sheet_header_from_path(
    file_path: String,
    sheet_name: String,
) -> Result<DatasetSheetRowsResult, String> {
    log_command_result("read_spreadsheet_sheet_header_from_path", (|| {
        guard_spreadsheet_operation("read_spreadsheet_sheet_header_from_path", || {
            let normalized_path = file_path.trim();
            if normalized_path.is_empty() {
                return Err("源文件路径不能为空。".to_string());
            }

            let (header_rows, _) = parse_sheet_header_from_path(normalized_path, &sheet_name)?;
            Ok(DatasetSheetRowsResult {
                name: sheet_name,
                raw_rows: header_rows,
                row_count: 0,
                data_mode: "header".to_string(),
            })
        })
    })())
}

#[tauri::command]
pub fn read_dataset_sheet_preview(
    app: AppHandle,
    dataset_id: String,
    sheet_name: String,
) -> Result<DatasetSheetRowsResult, String> {
    log_command_result("read_dataset_sheet_preview", guard_spreadsheet_operation("read_dataset_sheet_preview", || {
        let conn = open_dataset_db(&app)?;
        ensure_schema(&conn)?;

        let mut statement = conn
            .prepare(
                r#"
                SELECT preview_rows_json, row_count
                FROM dataset_sheets
                WHERE dataset_id = ? AND sheet_name = ?
                "#,
            )
            .map_err(|err| err.to_string())?;

        let (preview_rows_json, row_count): (String, i64) = statement
            .query_row(params![dataset_id.as_str(), sheet_name.as_str()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|err| err.to_string())?;

        if preview_rows_json != "[]" || row_count > 0 {
            let raw_rows =
                serde_json::from_str::<Vec<Vec<String>>>(&preview_rows_json).map_err(|err| err.to_string())?;
            return Ok(DatasetSheetRowsResult {
                name: sheet_name,
                raw_rows,
                row_count: row_count.max(0) as usize,
                data_mode: "preview".to_string(),
            });
        }

        let file_path = get_dataset_file_path(&conn, &dataset_id)?;
        let rows = read_sheet_rows_from_path(&file_path, &sheet_name)?;
        let mut preview_rows = Vec::new();
        let mut actual_row_count = 0usize;
        let mut column_count = 0usize;
        let mut header_rows = Vec::new();
        for row in rows {
            column_count = column_count.max(row.len());
            actual_row_count += 1;
            if header_rows.len() < HEADER_CONTEXT_ROW_LIMIT {
                header_rows.push(row.clone());
            }
            if preview_rows.len() < PREVIEW_ROW_LIMIT {
                preview_rows.push(row);
            }
        }
        let header_rows_json = serde_json::to_string(&header_rows).map_err(|err| err.to_string())?;
        let preview_rows_json = serde_json::to_string(&preview_rows).map_err(|err| err.to_string())?;
        conn.execute(
            r#"
            UPDATE dataset_sheets
            SET row_count = ?, column_count = ?, header_rows_json = ?, preview_row_count = ?, preview_rows_json = ?
            WHERE dataset_id = ? AND sheet_name = ?
            "#,
            params![
                actual_row_count as i64,
                column_count as i64,
                header_rows_json,
                preview_rows.len() as i64,
                preview_rows_json,
                dataset_id.as_str(),
                sheet_name.as_str()
            ],
        )
        .map_err(|err| err.to_string())?;

        Ok(DatasetSheetRowsResult {
            name: sheet_name,
            raw_rows: preview_rows,
            row_count: actual_row_count,
            data_mode: "preview".to_string(),
        })
    }))
}

#[tauri::command]
pub fn read_dataset_sheet_rows(
    app: AppHandle,
    dataset_id: String,
    sheet_name: String,
) -> Result<DatasetSheetRowsResult, String> {
    log_command_result("read_dataset_sheet_rows", guard_spreadsheet_operation("read_dataset_sheet_rows", || {
        let mut conn = open_dataset_db(&app)?;
        ensure_schema(&conn)?;
        ensure_materialized_sheet(&app, &mut conn, &dataset_id, &sheet_name)?;
        let raw_rows = load_sheet_rows(&conn, &dataset_id, &sheet_name)?;
        let row_count = raw_rows.len();

        Ok(DatasetSheetRowsResult {
            name: sheet_name,
            raw_rows,
            row_count,
            data_mode: "full".to_string(),
        })
    }))
}

#[tauri::command]
pub fn read_dataset_sheet_page(
    app: AppHandle,
    dataset_id: String,
    sheet_name: String,
    header_row_index: usize,
    group_header_row_index: usize,
    offset: usize,
    limit: usize,
) -> Result<DatasetSheetPageResult, String> {
    log_command_result("read_dataset_sheet_page", guard_spreadsheet_operation("read_dataset_sheet_page", || {
        let mut conn = open_dataset_db(&app)?;
        ensure_schema(&conn)?;
        ensure_materialized_sheet(&app, &mut conn, &dataset_id, &sheet_name)?;

        let mut statement = conn
            .prepare(
                r#"
                SELECT header_rows_json, row_count
                FROM dataset_sheets
                WHERE dataset_id = ? AND sheet_name = ?
                "#,
            )
            .map_err(|err| err.to_string())?;

        let (header_rows_json, total_row_count): (String, i64) = statement
            .query_row(params![dataset_id.as_str(), sheet_name.as_str()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|err| err.to_string())?;

        let header_rows =
            serde_json::from_str::<Vec<Vec<String>>>(&header_rows_json).map_err(|err| err.to_string())?;
        let normalized_header_row_index = header_row_index.max(1);
        let columns = build_process_columns(
            &header_rows,
            normalized_header_row_index,
            group_header_row_index,
            "",
        );
        let headers = columns
            .iter()
            .map(|column| column.header.clone())
            .collect::<Vec<_>>();

        let data_row_count = (total_row_count.max(0) as usize).saturating_sub(normalized_header_row_index);
        let normalized_limit = limit.max(1);
        let raw_rows = load_sheet_rows_page(
            &conn,
            &dataset_id,
            &sheet_name,
            normalized_header_row_index + offset,
            normalized_limit,
        )?;

        let rows = raw_rows
            .iter()
            .map(|row| {
                let mut normalized = HashMap::new();
                for column in &columns {
                    normalized.insert(
                        column.header.clone(),
                        get_text_row_value(row, column.source_index),
                    );
                }
                normalized
            })
            .collect::<Vec<_>>();

        Ok(DatasetSheetPageResult {
            name: sheet_name,
            headers,
            rows,
            row_count: data_row_count,
        })
    }))
}
