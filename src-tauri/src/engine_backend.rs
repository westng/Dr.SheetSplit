use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};
use zip::{write::FileOptions, CompressionMethod, ZipWriter};

use crate::dataset_cache;

const UNKNOWN_FALLBACK: &str = "未知错误";
const ENGINE_PROCESS_EVENT: &str = "engine-process-event";

type SourceRow = HashMap<String, String>;
type SharedSourceRow = Arc<SourceRow>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProcessSourceInput {
    pub source_id: String,
    pub dataset_id: String,
    pub sheet_name: String,
    pub file_name: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingGroupEntry {
    pub source: String,
    pub target: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingGroup {
    pub id: String,
    pub name: Option<String>,
    #[serde(default)]
    pub entries: Vec<MappingGroupEntry>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEngineProcessTaskInput {
    pub task_id: String,
    pub rule: Value,
    pub sources: Vec<EngineProcessSourceInput>,
    #[serde(default)]
    pub mapping_groups: Vec<MappingGroup>,
    #[serde(default)]
    pub export_directory: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineProcessEventPayload {
    pub task_id: String,
    pub stage: Option<String>,
    pub level: String,
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStyleToken {
    pub bold: bool,
    pub font_size: usize,
    pub text_color: String,
    pub background_color: String,
    pub horizontal_align: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStyleConfig {
    pub title: EngineStyleToken,
    pub header: EngineStyleToken,
    pub data: EngineStyleToken,
    pub total_row: EngineStyleToken,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSheetOutput {
    pub name: String,
    pub title: String,
    pub title_enabled: bool,
    pub total_row_enabled: bool,
    pub group_header_enabled: bool,
    pub group_header_label: String,
    pub group_header_start_column_index: usize,
    pub header_row_index: usize,
    pub data_start_row_index: usize,
    pub reserved_footer_rows: usize,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub style_config: EngineStyleConfig,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOutput {
    pub ok: bool,
    pub sheet_count: usize,
    pub row_count: usize,
    pub sheets: Vec<EngineSheetOutput>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEngineProcessTaskResult {
    pub output_path: String,
    pub sheet_count: usize,
    pub row_count: usize,
    pub engine_output: EngineOutput,
}

#[derive(Clone)]
struct LoadedSource {
    sheet_name: String,
    rows: Vec<SharedSourceRow>,
}

#[derive(Clone)]
struct WorkingRecord {
    source_rows: HashMap<String, Option<SharedSourceRow>>,
}

#[derive(Clone)]
struct ResultBucket {
    key: String,
    dimension_values: HashMap<String, String>,
    record_indices: Vec<usize>,
    output_values: HashMap<String, String>,
    row_values: Vec<String>,
    merged_source_values: HashMap<String, String>,
}

#[derive(Clone)]
struct DynamicHeaderConfig {
    headers: Vec<String>,
    header_map: HashMap<String, String>,
}

#[derive(Clone)]
struct SheetPreview {
    rows: Vec<SourceRow>,
}

#[derive(Clone, Eq, PartialEq, Hash)]
struct StyleKey {
    bold: bool,
    font_size: usize,
    text_color: String,
    background_color: String,
    horizontal_align: String,
}

struct StyleRegistry {
    styles: Vec<StyleKey>,
    index_by_key: HashMap<StyleKey, usize>,
}

struct SheetBuildResult {
    matrix: Vec<Vec<String>>,
    header_row_index: usize,
    group_header_row_index: Option<usize>,
    data_start_row_index: usize,
    data_row_count: usize,
}

#[derive(Clone)]
enum ExprValue {
    Number(f64),
    Text(String),
    Empty,
}

#[derive(Clone, Debug)]
enum ExprToken {
    Number(f64),
    Text(String),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    LParen,
    RParen,
    Comma,
    Question,
    Colon,
    End,
}

struct ExprParser<'a> {
    tokens: Vec<ExprToken>,
    position: usize,
    rows: &'a [SourceRow],
    first_row: &'a SourceRow,
    output_values: &'a HashMap<String, String>,
}

pub fn run_engine_process_task(
    app: &AppHandle,
    input: BackendEngineProcessTaskInput,
) -> Result<BackendEngineProcessTaskResult, String> {
    let rule = input
        .rule
        .as_object()
        .ok_or_else(|| "处理规则格式无效。".to_string())?;

    emit_stage(app, &input.task_id, "load_sources", "正在读取来源表...", "info");
    let loaded_sources = load_sources(app, rule, &input.sources, &input.task_id)?;

    let mapping_indexes = build_mapping_indexes(&input.mapping_groups);
    emit_stage(app, &input.task_id, "join_sources", "正在执行关联计算...", "info");
    let working_rows = join_sources(rule, &loaded_sources, &input.task_id, app)?;

    emit_stage(app, &input.task_id, "build_result", "正在构建结果数据...", "info");
    let engine_output = build_engine_output(
        rule,
        &loaded_sources,
        &working_rows,
        &input.mapping_groups,
        &mapping_indexes,
    )?;

    emit_stage(app, &input.task_id, "build_workbook", "正在生成输出工作簿...", "info");
    let workbook_binary = build_workbook_binary(&engine_output)?;

    emit_stage(
        app,
        &input.task_id,
        "resolve_output_path",
        "正在确定导出文件路径...",
        "info",
    );
    let output_source_name = input
        .sources
        .first()
        .map(|item| item.file_name.as_str())
        .unwrap_or("output.xlsx");
    let output_path = resolve_output_path(
        output_source_name,
        &get_text_from_object(rule, "name"),
        &input.export_directory,
    )?;

    emit_stage(app, &input.task_id, "write_output_file", "正在写入输出文件...", "info");
    write_binary_file(&output_path, &workbook_binary)?;

    emit_stage(
        app,
        &input.task_id,
        "write_output_file",
        &format!("处理完成：{} 个 Sheet，{} 行数据。", engine_output.sheet_count, engine_output.row_count),
        "success",
    );

    Ok(BackendEngineProcessTaskResult {
        output_path,
        sheet_count: engine_output.sheet_count,
        row_count: engine_output.row_count,
        engine_output,
    })
}

fn emit_stage(app: &AppHandle, task_id: &str, stage: &str, message: &str, level: &str) {
    let _ = app.emit(
        ENGINE_PROCESS_EVENT,
        EngineProcessEventPayload {
            task_id: task_id.to_string(),
            stage: Some(stage.to_string()),
            level: level.to_string(),
            message: message.to_string(),
        },
    );
}

fn as_text_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(other) => other.to_string().trim().to_string(),
    }
}

fn get_text_from_object(map: &Map<String, Value>, key: &str) -> String {
    as_text_value(map.get(key))
}

fn get_bool_from_object(map: &Map<String, Value>, key: &str, fallback: bool) -> bool {
    map.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn get_usize_from_object(map: &Map<String, Value>, key: &str, fallback: usize) -> usize {
    map.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(fallback)
}

fn get_object_from_object<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    map.get(key).and_then(Value::as_object)
}

fn get_array_from_object<'a>(map: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    map.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn parse_number(value: impl AsRef<str>, field_name: &str) -> Result<f64, String> {
    let text = value.as_ref().trim().replace(',', "");
    if text.is_empty() {
        return Err(format!("字段“{}”为空，无法进行数值计算。", field_name));
    }
    text.parse::<f64>()
        .map_err(|_| format!("字段“{}”值“{}”不是合法数字。", field_name, text))
}

fn format_number(value: f64) -> String {
    if !value.is_finite() {
        return String::new();
    }
    let rounded = (value * 100.0).round() / 100.0;
    if (rounded - rounded.round()).abs() < 1e-9 {
        return rounded.round().to_string();
    }
    let mut text = format!("{rounded:.2}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

fn try_parse_number_text(value: &str) -> Option<f64> {
    let text = value.trim().replace(',', "");
    if text.is_empty() {
        return None;
    }
    text.parse::<f64>().ok()
}

fn is_date_header(value: &str) -> bool {
    value.len() == 8 && value.chars().all(|char| char.is_ascii_digit())
}

fn normalize_header(value: &str, index: usize) -> String {
    let text = value.trim();
    if text.is_empty() {
        format!("Column_{}", index + 1)
    } else {
        text.to_string()
    }
}

fn build_sheet_preview(
    raw_rows: &[Vec<String>],
    row_count: usize,
    header_row_index: usize,
    group_header_row_index: usize,
) -> SheetPreview {
    let normalized_header_row_index = header_row_index.max(1);
    let header_row = raw_rows
        .get(normalized_header_row_index.saturating_sub(1))
        .cloned()
        .unwrap_or_default();
    let group_header_row = if group_header_row_index > 0 {
        raw_rows
            .get(group_header_row_index.saturating_sub(1))
            .cloned()
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let column_count = header_row.len().max(group_header_row.len());
    let mut headers = Vec::new();
    let mut source_indexes = Vec::new();
    let mut used = HashSet::new();

    for index in 0..column_count {
        let child_header = header_row.get(index).cloned().unwrap_or_default();
        let group_header = group_header_row.get(index).cloned().unwrap_or_default();
        let mut next_header = normalize_header(&child_header, index);
        if is_date_header(&child_header) && !group_header.trim().is_empty() {
            next_header = format!("{}__{}", group_header.trim(), child_header.trim());
        }
        let base = next_header.clone();
        let mut suffix = 2usize;
        while used.contains(&next_header) {
            next_header = format!("{base}_{suffix}");
            suffix += 1;
        }
        used.insert(next_header.clone());
        headers.push(next_header);
        source_indexes.push(index);
    }

    let mut rows = Vec::new();
    for row in raw_rows.iter().skip(normalized_header_row_index) {
        let mut normalized = HashMap::new();
        for (column_index, header) in headers.iter().enumerate() {
            let source_index = source_indexes[column_index];
            normalized.insert(
                header.clone(),
                row.get(source_index).cloned().unwrap_or_default().trim().to_string(),
            );
        }
        rows.push(normalized);
    }

    let real_row_count = if row_count > normalized_header_row_index {
        row_count - normalized_header_row_index
    } else {
        rows.len()
    };

    let _ = real_row_count;
    let _ = headers;
    SheetPreview { rows }
}

fn split_keywords(value: &str) -> Vec<String> {
    value
        .split(|char| matches!(char, '\n' | '\r' | ',' | '，'))
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn parse_manual_values(text: &str) -> Vec<String> {
    split_keywords(text)
}

fn build_mapping_indexes(mapping_groups: &[MappingGroup]) -> HashMap<String, HashMap<String, String>> {
    let mut result = HashMap::new();
    for group in mapping_groups {
        let group_id = group.id.trim();
        if group_id.is_empty() {
            continue;
        }
        let mut entries = HashMap::new();
        for entry in &group.entries {
            let key = entry.source.trim();
            if key.is_empty() {
                continue;
            }
            entries.insert(key.to_string(), entry.target.trim().to_string());
        }
        result.insert(group_id.to_string(), entries);
    }
    result
}

fn build_composite_key(values: &[String]) -> String {
    values
        .iter()
        .map(|value| value.trim().to_string())
        .collect::<Vec<_>>()
        .join("+")
}

fn resolve_mapping_value(
    mapping_indexes: &HashMap<String, HashMap<String, String>>,
    mapping_group_id: &str,
    source_value: &str,
) -> String {
    let normalized = source_value.trim();
    if normalized.is_empty() {
        return String::new();
    }
    mapping_indexes
        .get(mapping_group_id)
        .and_then(|group| group.get(normalized))
        .cloned()
        .unwrap_or_else(|| UNKNOWN_FALLBACK.to_string())
}

fn resolve_baseline_mapping_value(
    mapping_indexes: &HashMap<String, HashMap<String, String>>,
    mapping_groups: &[MappingGroup],
    mapping_group_id: &str,
    baseline_value: &str,
) -> String {
    let normalized_baseline = baseline_value.trim();
    if normalized_baseline.is_empty() {
        return String::new();
    }
    if let Some(exact_value) = mapping_indexes
        .get(mapping_group_id)
        .and_then(|group| group.get(normalized_baseline))
    {
        return exact_value.clone();
    }
    let Some(group) = mapping_groups.iter().find(|item| item.id == mapping_group_id) else {
        return UNKNOWN_FALLBACK.to_string();
    };
    let prefix = format!("{normalized_baseline}+");
    let matched_targets: Vec<String> = group
        .entries
        .iter()
        .filter_map(|entry| {
            let source = entry.source.trim();
            if source == normalized_baseline || source.starts_with(&prefix) {
                let target = entry.target.trim();
                if !target.is_empty() {
                    return Some(target.to_string());
                }
            }
            None
        })
        .collect();
    let deduped: HashSet<String> = matched_targets.into_iter().collect();
    if deduped.len() == 1 {
        return deduped.into_iter().next().unwrap_or_default();
    }
    UNKNOWN_FALLBACK.to_string()
}

fn resolve_multi_mapping_value(
    mapping_indexes: &HashMap<String, HashMap<String, String>>,
    mapping_group_id: &str,
    source_values: &[String],
) -> String {
    if source_values.iter().any(|value| value.trim().is_empty()) {
        return String::new();
    }
    let key = build_composite_key(source_values);
    if key.is_empty() {
        return String::new();
    }
    mapping_indexes
        .get(mapping_group_id)
        .and_then(|group| group.get(&key))
        .cloned()
        .unwrap_or_else(|| UNKNOWN_FALLBACK.to_string())
}

fn matches_filter_value(filter: &Map<String, Value>, field_value: &str) -> bool {
    let normalized = field_value.trim();
    let value_text = get_text_from_object(filter, "valueText");
    if value_text.is_empty() {
        return true;
    }
    match get_text_from_object(filter, "operator").as_str() {
        "equals" => normalized == value_text,
        "not_equals" => normalized != value_text,
        _ => {
            let keywords = split_keywords(&value_text);
            keywords.is_empty() || keywords.iter().any(|keyword| normalized.contains(keyword))
        }
    }
}

fn apply_source_filters(rows: Vec<SourceRow>, filters: &[Value]) -> Vec<SourceRow> {
    if filters.is_empty() {
        return rows;
    }
    rows.into_iter()
        .filter(|row| {
            filters.iter().all(|filter| {
                let Some(filter_object) = filter.as_object() else {
                    return true;
                };
                let field = get_text_from_object(filter_object, "field");
                matches_filter_value(filter_object, row.get(&field).map(String::as_str).unwrap_or(""))
            })
        })
        .collect()
}

fn load_sources(
    app: &AppHandle,
    rule: &Map<String, Value>,
    runtime_sources: &[EngineProcessSourceInput],
    task_id: &str,
) -> Result<HashMap<String, LoadedSource>, String> {
    let mut result = HashMap::new();
    for source in get_array_from_object(rule, "sources") {
        let Some(source_object) = source.as_object() else {
            continue;
        };
        let source_id = get_text_from_object(source_object, "id");
        let runtime_source = runtime_sources
            .iter()
            .find(|item| item.source_id == source_id)
            .ok_or_else(|| format!("来源表缺失：{source_id}"))?;
        emit_stage(
            app,
            task_id,
            "load_sources",
            &format!(
                "正在读取来源表：{} / {}",
                if runtime_source.file_name.trim().is_empty() {
                    runtime_source.sheet_name.as_str()
                } else {
                    runtime_source.file_name.as_str()
                },
                runtime_source.sheet_name
            ),
            "info",
        );
        let sheet_data = dataset_cache::read_dataset_sheet_rows(
            app.clone(),
            runtime_source.dataset_id.clone(),
            runtime_source.sheet_name.clone(),
        )?;
        let preview = build_sheet_preview(
            &sheet_data.raw_rows,
            sheet_data.row_count,
            get_usize_from_object(source_object, "sourceHeaderRowIndex", 1),
            get_usize_from_object(source_object, "sourceGroupHeaderRowIndex", 0),
        );
        let filtered_rows = apply_source_filters(
            preview.rows,
            get_array_from_object(source_object, "preFilters"),
        );
        let filtered_row_count = filtered_rows.len();
        result.insert(
            source_id.clone(),
            LoadedSource {
                sheet_name: runtime_source.sheet_name.clone(),
                rows: filtered_rows.into_iter().map(Arc::new).collect(),
            },
        );
        emit_stage(
            app,
            task_id,
            "load_sources",
            &format!(
                "来源表读取完成：{}，{} 行。",
                runtime_source.sheet_name,
                filtered_row_count
            ),
            "info",
        );
    }
    Ok(result)
}

fn create_working_records(rows: &[SharedSourceRow], source_id: &str) -> Vec<WorkingRecord> {
    rows.iter()
        .map(|row| WorkingRecord {
            source_rows: HashMap::from([(source_id.to_string(), Some(Arc::clone(row)))]),
        })
        .collect()
}

fn join_sources(
    rule: &Map<String, Value>,
    loaded_sources: &HashMap<String, LoadedSource>,
    task_id: &str,
    app: &AppHandle,
) -> Result<Vec<WorkingRecord>, String> {
    let sources = get_array_from_object(rule, "sources");
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    if get_text_from_object(rule, "ruleType") == "single_table" || sources.len() == 1 {
        let source_id = sources
            .first()
            .and_then(Value::as_object)
            .map(|item| get_text_from_object(item, "id"))
            .unwrap_or_default();
        let rows = loaded_sources
            .get(&source_id)
            .map(|source| source.rows.clone())
            .unwrap_or_default();
        emit_stage(
            app,
            task_id,
            "join_sources",
            &format!("正在构建单表处理数据：{} 行。", rows.len()),
            "info",
        );
        return Ok(create_working_records(&rows, &source_id));
    }
    let relations = get_array_from_object(rule, "relations");
    if relations.is_empty() {
        return Err("多表规则缺少关联配置，无法开始处理。".to_string());
    }
    let mut working_rows = Vec::new();
    let mut joined_source_ids = HashSet::new();

    for (relation_index, relation) in relations.iter().enumerate() {
        let Some(relation_object) = relation.as_object() else {
            continue;
        };
        let left_source_id = get_text_from_object(relation_object, "leftSourceId");
        let right_source_id = get_text_from_object(relation_object, "rightSourceId");
        let left_source = loaded_sources
            .get(&left_source_id)
            .ok_or_else(|| format!("关联 #{} 引用了不存在的来源表。", relation_index + 1))?;
        let right_source = loaded_sources
            .get(&right_source_id)
            .ok_or_else(|| format!("关联 #{} 引用了不存在的来源表。", relation_index + 1))?;

        if working_rows.is_empty() {
            working_rows = create_working_records(&left_source.rows, &left_source_id);
            joined_source_ids.insert(left_source_id.clone());
        }
        if !joined_source_ids.contains(&left_source_id) {
            return Err(format!(
                "关联 #{} 的左表尚未加入处理链，请按处理顺序调整关联配置。",
                relation_index + 1
            ));
        }
        if joined_source_ids.contains(&right_source_id) {
            continue;
        }
        emit_stage(
            app,
            task_id,
            "join_sources",
            &format!(
                "正在执行关联 #{}：{} -> {}",
                relation_index + 1,
                left_source.sheet_name,
                right_source.sheet_name
            ),
            "info",
        );

        let left_field = get_text_from_object(relation_object, "leftField");
        let right_field = get_text_from_object(relation_object, "rightField");
        let join_type = get_text_from_object(relation_object, "joinType");
        let multi_match_strategy = get_text_from_object(relation_object, "multiMatchStrategy");

        let mut index: HashMap<String, Vec<SharedSourceRow>> = HashMap::new();
        for row in &right_source.rows {
            let key = row.get(&right_field).cloned().unwrap_or_default();
            index.entry(key).or_default().push(Arc::clone(row));
        }

        let mut next_rows = Vec::new();
        for record in &working_rows {
            let left_row = record
                .source_rows
                .get(&left_source_id)
                .and_then(|row| row.as_ref())
                .map(Arc::clone);
            let match_key = left_row
                .as_ref()
                .and_then(|row| row.get(&left_field))
                .cloned()
                .unwrap_or_default();
            let matches = if match_key.is_empty() {
                None
            } else {
                index.get(&match_key)
            };
            if matches.map(|items| items.len()).unwrap_or(0) > 1 && multi_match_strategy == "error" {
                return Err(format!("关联 #{} 命中多条记录：{}", relation_index + 1, match_key));
            }
            if matches.is_none_or(|items| items.is_empty()) {
                if join_type == "left_join" {
                    let mut source_rows = record.source_rows.clone();
                    source_rows.insert(right_source_id.clone(), None);
                    next_rows.push(WorkingRecord { source_rows });
                }
                continue;
            }
            let matches = matches.expect("matches checked above");
            if multi_match_strategy == "all" && matches.len() > 1 {
                for matched_row in matches {
                    let mut source_rows = record.source_rows.clone();
                    source_rows.insert(right_source_id.clone(), Some(Arc::clone(matched_row)));
                    next_rows.push(WorkingRecord { source_rows });
                }
                continue;
            }
            let mut source_rows = record.source_rows.clone();
            source_rows.insert(right_source_id.clone(), Some(Arc::clone(&matches[0])));
            next_rows.push(WorkingRecord { source_rows });
        }

        working_rows = next_rows;
        joined_source_ids.insert(right_source_id);
    }

    let unjoined_sources: Vec<String> = get_array_from_object(rule, "sources")
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|source| {
            let source_id = get_text_from_object(source, "id");
            if joined_source_ids.contains(&source_id) {
                None
            } else {
                let sheet_name = get_text_from_object(source, "sourceSheetName");
                Some(if sheet_name.is_empty() { source_id } else { sheet_name })
            }
        })
        .collect();
    if !unjoined_sources.is_empty() {
        return Err(format!(
            "仍有来源表未接入处理链：{}",
            unjoined_sources.join("、")
        ));
    }
    emit_stage(
        app,
        task_id,
        "join_sources",
        &format!("多表关联完成，当前结果 {} 行。", working_rows.len()),
        "info",
    );
    Ok(working_rows)
}

fn resolve_source_value(record: &WorkingRecord, source_table_id: &str, source_field: &str) -> String {
    if source_table_id.is_empty() || source_field.is_empty() {
        return String::new();
    }
    record
        .source_rows
        .get(source_table_id)
        .and_then(|row| row.as_ref())
        .and_then(|row| row.get(source_field))
        .cloned()
        .unwrap_or_default()
}

fn merge_source_values(record: &WorkingRecord, source_order: &[String]) -> HashMap<String, String> {
    let mut result = HashMap::new();
    for source_id in source_order {
        let Some(Some(row)) = record.source_rows.get(source_id) else {
            continue;
        };
        for (key, value) in row.iter() {
            if !key.is_empty() && !result.contains_key(key) {
                result.insert(key.clone(), value.trim().to_string());
            }
        }
    }
    result
}

fn build_dimension_values(rule: &Map<String, Value>, record: &WorkingRecord) -> HashMap<String, String> {
    let mut values = HashMap::new();
    if let Some(result) = get_object_from_object(rule, "result") {
        for field in get_array_from_object(result, "groupFields") {
            let Some(field_object) = field.as_object() else {
                continue;
            };
            let label = get_text_from_object(field_object, "label");
            values.insert(
                label,
                resolve_source_value(
                    record,
                    &get_text_from_object(field_object, "sourceTableId"),
                    &get_text_from_object(field_object, "sourceField"),
                ),
            );
        }
    }
    values
}

fn build_group_key_by_labels(labels: &[String], values: &HashMap<String, String>) -> String {
    labels
        .iter()
        .map(|label| values.get(label).cloned().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\u{001f}")
}

fn compare_text(left: &str, right: &str) -> Ordering {
    natural_cmp(left, right)
}

fn natural_cmp(left: &str, right: &str) -> Ordering {
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();
    let mut li = 0usize;
    let mut ri = 0usize;
    while li < left_chars.len() && ri < right_chars.len() {
        let lc = left_chars[li];
        let rc = right_chars[ri];
        if lc.is_ascii_digit() && rc.is_ascii_digit() {
            let lstart = li;
            let rstart = ri;
            while li < left_chars.len() && left_chars[li].is_ascii_digit() {
                li += 1;
            }
            while ri < right_chars.len() && right_chars[ri].is_ascii_digit() {
                ri += 1;
            }
            let lnum = left_chars[lstart..li]
                .iter()
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0);
            let rnum = right_chars[rstart..ri]
                .iter()
                .collect::<String>()
                .parse::<u64>()
                .unwrap_or(0);
            match lnum.cmp(&rnum) {
                Ordering::Equal => {}
                other => return other,
            }
            continue;
        }
        let left_lower = lc.to_lowercase().to_string();
        let right_lower = rc.to_lowercase().to_string();
        match left_lower.cmp(&right_lower) {
            Ordering::Equal => {
                li += 1;
                ri += 1;
            }
            other => return other,
        }
    }
    left_chars.len().cmp(&right_chars.len())
}

fn compare_maybe_number(left: &str, right: &str) -> Ordering {
    match (left.trim().parse::<f64>(), right.trim().parse::<f64>()) {
        (Ok(left_number), Ok(right_number)) => left_number
            .partial_cmp(&right_number)
            .unwrap_or(Ordering::Equal),
        _ => compare_text(left, right),
    }
}

fn resolve_completion_baseline_values(
    rule: &Map<String, Value>,
    loaded_sources: &HashMap<String, LoadedSource>,
    mapping_groups: &[MappingGroup],
) -> Vec<String> {
    let Some(result) = get_object_from_object(rule, "result") else {
        return Vec::new();
    };
    let Some(config) = get_object_from_object(result, "rowCompletion") else {
        return Vec::new();
    };
    if !get_bool_from_object(config, "enabled", false) {
        return Vec::new();
    }
    match get_text_from_object(config, "baselineType").as_str() {
        "manual_values" => {
            let values: HashSet<String> =
                parse_manual_values(&get_text_from_object(config, "manualValuesText"))
                    .into_iter()
                    .collect();
            values.into_iter().collect()
        }
        "mapping_group" => {
            let Some(group) = mapping_groups
                .iter()
                .find(|item| item.id == get_text_from_object(config, "mappingGroupId"))
            else {
                return Vec::new();
            };
            let use_source = get_text_from_object(config, "mappingValueType") == "source";
            let values: HashSet<String> = group
                .entries
                .iter()
                .map(|entry| {
                    if use_source {
                        entry.source.trim().to_string()
                    } else {
                        entry.target.trim().to_string()
                    }
                })
                .filter(|item| !item.is_empty())
                .collect();
            values.into_iter().collect()
        }
        _ => {
            let source_id = get_text_from_object(config, "sourceTableId");
            let field = get_text_from_object(config, "sourceField");
            let Some(source) = loaded_sources.get(&source_id) else {
                return Vec::new();
            };
            source
                .rows
                .iter()
                .filter_map(|row| row.get(&field))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<HashSet<_>>()
                .into_iter()
                .collect()
        }
    }
}

fn resolve_sheet_value_exclusions(
    rule: &Map<String, Value>,
    mapping_groups: &[MappingGroup],
) -> HashSet<String> {
    let Some(result) = get_object_from_object(rule, "result") else {
        return HashSet::new();
    };
    let Some(config) = get_object_from_object(result, "sheetConfig") else {
        return HashSet::new();
    };
    match get_text_from_object(config, "sheetValueFilterMode").as_str() {
        "exclude_manual" => parse_manual_values(&get_text_from_object(config, "sheetValueFilterValuesText"))
            .into_iter()
            .collect(),
        "exclude_mapping_source" => mapping_groups
            .iter()
            .find(|group| group.id == get_text_from_object(config, "sheetValueFilterMappingGroupId"))
            .map(|group| {
                group.entries
                    .iter()
                    .map(|entry| entry.source.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        _ => HashSet::new(),
    }
}

fn apply_row_completion(
    rule: &Map<String, Value>,
    buckets: Vec<ResultBucket>,
    baseline_values: &[String],
) -> Vec<ResultBucket> {
    let Some(result) = get_object_from_object(rule, "result") else {
        return buckets;
    };
    let Some(config) = get_object_from_object(result, "rowCompletion") else {
        return buckets;
    };
    let target_field = get_text_from_object(config, "targetField");
    if !get_bool_from_object(config, "enabled", false)
        || target_field.is_empty()
        || baseline_values.is_empty()
    {
        return buckets;
    }

    let group_fields: Vec<String> = get_array_from_object(result, "groupFields")
        .iter()
        .filter_map(Value::as_object)
        .map(|field| get_text_from_object(field, "label"))
        .collect();

    let mut buckets_by_target: HashMap<String, Vec<ResultBucket>> = HashMap::new();
    for bucket in &buckets {
        let key = bucket
            .dimension_values
            .get(&target_field)
            .cloned()
            .unwrap_or_default();
        if key.is_empty() {
            continue;
        }
        buckets_by_target.entry(key).or_default().push(bucket.clone());
    }

    let mut baseline_buckets = Vec::new();
    for value in baseline_values {
        if let Some(existing) = buckets_by_target.get(value) {
            baseline_buckets.extend(existing.clone());
            continue;
        }
        let mut dimension_values = HashMap::new();
        for label in &group_fields {
            dimension_values.insert(
                label.clone(),
                if label == &target_field {
                    value.clone()
                } else {
                    String::new()
                },
            );
        }
        baseline_buckets.push(ResultBucket {
            key: build_group_key_by_labels(&group_fields, &dimension_values),
            dimension_values,
            record_indices: Vec::new(),
            output_values: HashMap::new(),
            row_values: Vec::new(),
            merged_source_values: HashMap::new(),
        });
    }

    if get_text_from_object(config, "completionMode") == "baseline_only" {
        let mut merged = baseline_buckets;
        for bucket in buckets {
            let target_value = bucket
                .dimension_values
                .get(&target_field)
                .cloned()
                .unwrap_or_default();
            if !baseline_values.contains(&target_value) {
                merged.push(bucket);
            }
        }
        return merged;
    }

    let mut merged = baseline_buckets;
    for bucket in buckets {
        let target_value = bucket
            .dimension_values
            .get(&target_field)
            .cloned()
            .unwrap_or_default();
        if target_value.is_empty() || !baseline_values.contains(&target_value) {
            merged.push(bucket);
        }
    }
    merged
}

fn resolve_field_value(bucket: &ResultBucket, row: &SourceRow, field_name: &str) -> String {
    row.get(field_name)
        .cloned()
        .or_else(|| bucket.dimension_values.get(field_name).cloned())
        .or_else(|| bucket.output_values.get(field_name).cloned())
        .unwrap_or_default()
}

fn matches_output_filters(field: &Map<String, Value>, row: &SourceRow) -> bool {
    get_array_from_object(field, "filters").iter().all(|filter| {
        let Some(filter_object) = filter.as_object() else {
            return true;
        };
        let field_name = get_text_from_object(filter_object, "field");
        matches_filter_value(
            filter_object,
            row.get(&field_name).map(String::as_str).unwrap_or(""),
        )
    })
}

fn extract_matched_source_rows(
    bucket: &ResultBucket,
    working_rows: &[WorkingRecord],
    field: &Map<String, Value>,
) -> Vec<SourceRow> {
    let source_table_id = get_text_from_object(field, "sourceTableId");
    if source_table_id.is_empty() {
        return Vec::new();
    }
    let mut unique_rows = HashSet::new();
    let mut matched_rows = Vec::new();
    for record_index in &bucket.record_indices {
        let Some(record) = working_rows.get(*record_index) else {
            continue;
        };
        let Some(Some(row)) = record.source_rows.get(&source_table_id) else {
            continue;
        };
        if !matches_output_filters(field, row) {
            continue;
        }
        let mut match_all = true;
        for condition in get_array_from_object(field, "matchConditions") {
            let Some(condition_object) = condition.as_object() else {
                continue;
            };
            let expected = bucket
                .dimension_values
                .get(&get_text_from_object(condition_object, "resultField"))
                .cloned()
                .unwrap_or_default();
            let actual = row
                .get(&get_text_from_object(condition_object, "sourceField"))
                .cloned()
                .unwrap_or_default();
            if expected != actual {
                match_all = false;
                break;
            }
        }
        if !match_all {
            continue;
        }
        let signature = serde_json::to_string(row).unwrap_or_default();
        if unique_rows.insert(signature) {
            matched_rows.push((**row).clone());
        }
    }
    matched_rows
}

fn apply_empty_value_policy(field: &Map<String, Value>, value: String) -> Result<String, String> {
    let normalized = value.trim().to_string();
    if !normalized.is_empty() {
        return Ok(normalized);
    }
    match get_text_from_object(field, "emptyValuePolicy").as_str() {
        "zero" => Ok("0".to_string()),
        "constant" => Ok(get_text_from_object(field, "defaultValue")),
        "error" => Err(format!(
            "字段“{}”为空。",
            {
                let field_name = get_text_from_object(field, "fieldName");
                if field_name.is_empty() {
                    "未命名字段".to_string()
                } else {
                    field_name
                }
            }
        )),
        _ => Ok(String::new()),
    }
}

fn finalize_output_value(field: &Map<String, Value>, value: String) -> Result<String, String> {
    let normalized = apply_empty_value_policy(field, value)?;
    match get_text_from_object(field, "dataType").as_str() {
        "number" => {
            if let Some(parsed) = try_parse_number_text(&normalized) {
                match get_text_from_object(field, "numberPostProcessMode").as_str() {
                    "round" => Ok(parsed.round().to_string()),
                    "fixed_2" => Ok(format_number(parsed)),
                    _ => Ok(normalized),
                }
            } else {
                Ok(normalized)
            }
        }
        "date" => Ok(format_date_value(
            &normalized,
            &get_text_from_object(field, "dateOutputFormat"),
        )),
        _ => Ok(normalized),
    }
}

fn sort_rows_for_text_aggregate(rows: &[SourceRow], field: &Map<String, Value>) -> Vec<SourceRow> {
    let sort_field = get_object_from_object(field, "textAggregateConfig")
        .map(|config| get_text_from_object(config, "sortField"))
        .unwrap_or_default();
    if sort_field.is_empty() {
        return rows.to_vec();
    }
    let direction = get_object_from_object(field, "textAggregateConfig")
        .map(|config| get_text_from_object(config, "sortDirection"))
        .unwrap_or_else(|| "asc".to_string());
    let mut sorted = rows.to_vec();
    sorted.sort_by(|left, right| {
        let ordering = compare_text(
            left.get(&sort_field).map(String::as_str).unwrap_or(""),
            right.get(&sort_field).map(String::as_str).unwrap_or(""),
        );
        if direction == "desc" {
            ordering.reverse()
        } else {
            ordering
        }
    });
    sorted
}

fn aggregate_text(rows: &[SourceRow], field: &Map<String, Value>) -> String {
    let delimiter = get_object_from_object(field, "textAggregateConfig")
        .map(|config| match get_text_from_object(config, "delimiterMode").as_str() {
            "comma" => ",".to_string(),
            "custom" => get_text_from_object(config, "customDelimiter"),
            _ => "\n".to_string(),
        })
        .unwrap_or_else(|| "\n".to_string());
    let source_field = get_text_from_object(field, "sourceField");
    let sorted_rows = sort_rows_for_text_aggregate(rows, field);
    let values: Vec<String> = sorted_rows
        .iter()
        .filter_map(|row| row.get(&source_field))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    let distinct = get_object_from_object(field, "textAggregateConfig")
        .map(|config| get_bool_from_object(config, "distinct", false))
        .unwrap_or(false);
    if distinct {
        let mut seen = HashSet::new();
        values
            .into_iter()
            .filter(|value| seen.insert(value.clone()))
            .collect::<Vec<_>>()
            .join(&delimiter)
    } else {
        values.join(&delimiter)
    }
}

fn get_expression_number(value: &str) -> Result<f64, String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized == UNKNOWN_FALLBACK
        || normalized == "-"
        || normalized == "未知错误填充"
    {
        return Ok(0.0);
    }
    parse_number(normalized, "表达式")
}

fn resolve_dynamic_group_aggregate_value(
    field: &Map<String, Value>,
    output_values: &HashMap<String, String>,
    dynamic_header_configs: &HashMap<String, DynamicHeaderConfig>,
) -> Result<String, String> {
    let source_field_id = get_object_from_object(field, "dynamicGroupAggregateConfig")
        .map(|config| get_text_from_object(config, "sourceFieldId"))
        .unwrap_or_default();
    if source_field_id.is_empty() {
        return Ok(String::new());
    }
    let headers = dynamic_header_configs
        .get(&source_field_id)
        .map(|config| config.headers.clone())
        .unwrap_or_default();
    if headers.is_empty() {
        return Ok(String::new());
    }
    let mut total = 0.0;
    for header in &headers {
        total += get_expression_number(
            output_values
                .get(header)
                .map(String::as_str)
                .unwrap_or_default(),
        )?;
    }
    if get_text_from_object(field, "valueMode") == "dynamic_group_avg" {
        return Ok(format_number(safe_divide(total, headers.len() as f64)));
    }
    Ok(format_number(total))
}

fn safe_divide(numerator: f64, denominator: f64) -> f64 {
    if !numerator.is_finite() || !denominator.is_finite() || denominator.abs() < 1e-9 {
        0.0
    } else {
        numerator / denominator
    }
}

fn tokenize_expression(input: &str) -> Result<Vec<ExprToken>, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut index = 0usize;
    let mut tokens = Vec::new();
    while index < chars.len() {
        let current = chars[index];
        if current.is_whitespace() {
            index += 1;
            continue;
        }
        match current {
            '+' => {
                tokens.push(ExprToken::Plus);
                index += 1;
            }
            '-' => {
                tokens.push(ExprToken::Minus);
                index += 1;
            }
            '*' => {
                tokens.push(ExprToken::Star);
                index += 1;
            }
            '/' => {
                tokens.push(ExprToken::Slash);
                index += 1;
            }
            '?' => {
                tokens.push(ExprToken::Question);
                index += 1;
            }
            ':' => {
                tokens.push(ExprToken::Colon);
                index += 1;
            }
            '(' => {
                tokens.push(ExprToken::LParen);
                index += 1;
            }
            ')' => {
                tokens.push(ExprToken::RParen);
                index += 1;
            }
            ',' => {
                tokens.push(ExprToken::Comma);
                index += 1;
            }
            '"' | '\'' => {
                let quote = current;
                index += 1;
                let mut value = String::new();
                while index < chars.len() {
                    let ch = chars[index];
                    if ch == '\\' && index + 1 < chars.len() {
                        value.push(chars[index + 1]);
                        index += 2;
                        continue;
                    }
                    if ch == quote {
                        index += 1;
                        break;
                    }
                    value.push(ch);
                    index += 1;
                }
                tokens.push(ExprToken::Text(value));
            }
            _ if current.is_ascii_digit() || current == '.' => {
                let start = index;
                index += 1;
                while index < chars.len()
                    && (chars[index].is_ascii_digit() || chars[index] == '.')
                {
                    index += 1;
                }
                let text: String = chars[start..index].iter().collect();
                let number = text
                    .parse::<f64>()
                    .map_err(|_| format!("表达式数字格式无效：{text}"))?;
                tokens.push(ExprToken::Number(number));
            }
            _ if current.is_alphanumeric() || current == '_' => {
                let start = index;
                index += 1;
                while index < chars.len()
                    && (chars[index].is_alphanumeric() || chars[index] == '_')
                {
                    index += 1;
                }
                tokens.push(ExprToken::Ident(
                    chars[start..index].iter().collect::<String>(),
                ));
            }
            _ => {
                return Err(format!("表达式包含不支持的字符：{current}"));
            }
        }
    }
    tokens.push(ExprToken::End);
    Ok(tokens)
}

impl ExprValue {
    fn as_text(&self) -> String {
        match self {
            ExprValue::Number(number) => format_number(*number),
            ExprValue::Text(text) => text.clone(),
            ExprValue::Empty => String::new(),
        }
    }

    fn as_number(&self) -> Result<f64, String> {
        match self {
            ExprValue::Number(number) => Ok(*number),
            ExprValue::Text(text) => get_expression_number(text),
            ExprValue::Empty => Ok(0.0),
        }
    }

    fn is_truthy(&self) -> Result<bool, String> {
        match self {
            ExprValue::Number(number) => Ok(number.abs() >= 1e-9),
            ExprValue::Text(text) => {
                let normalized = text.trim();
                if normalized.is_empty() {
                    return Ok(false);
                }
                if let Ok(number) = get_expression_number(normalized) {
                    return Ok(number.abs() >= 1e-9);
                }
                Ok(true)
            }
            ExprValue::Empty => Ok(false),
        }
    }
}

impl<'a> ExprParser<'a> {
    fn new(
        expression_text: &str,
        rows: &'a [SourceRow],
        first_row: &'a SourceRow,
        output_values: &'a HashMap<String, String>,
    ) -> Result<Self, String> {
        Ok(Self {
            tokens: tokenize_expression(expression_text)?,
            position: 0,
            rows,
            first_row,
            output_values,
        })
    }

    fn parse(mut self) -> Result<ExprValue, String> {
        let value = self.parse_expression()?;
        if !matches!(self.current(), ExprToken::End) {
            return Err("表达式包含多余内容。".to_string());
        }
        Ok(value)
    }

    fn current(&self) -> &ExprToken {
        self.tokens.get(self.position).unwrap_or(&ExprToken::End)
    }

    fn advance(&mut self) {
        if self.position < self.tokens.len() {
            self.position += 1;
        }
    }

    fn expect(&mut self, expected: ExprToken) -> Result<(), String> {
        let matched = std::mem::discriminant(self.current()) == std::mem::discriminant(&expected);
        if matched {
            self.advance();
            Ok(())
        } else {
            Err("表达式语法错误。".to_string())
        }
    }

    fn parse_expression(&mut self) -> Result<ExprValue, String> {
        self.parse_ternary()
    }

    fn parse_ternary(&mut self) -> Result<ExprValue, String> {
        let condition = self.parse_additive()?;
        if matches!(self.current(), ExprToken::Question) {
            self.advance();
            let when_true = self.parse_expression()?;
            self.expect(ExprToken::Colon)?;
            let when_false = self.parse_expression()?;
            return Ok(if condition.is_truthy()? {
                when_true
            } else {
                when_false
            });
        }
        Ok(condition)
    }

    fn parse_additive(&mut self) -> Result<ExprValue, String> {
        let mut left = self.parse_term()?;
        loop {
            match self.current() {
                ExprToken::Plus => {
                    self.advance();
                    let right = self.parse_term()?;
                    left = match (&left, &right) {
                        (ExprValue::Text(_), _) | (_, ExprValue::Text(_)) => {
                            ExprValue::Text(format!("{}{}", left.as_text(), right.as_text()))
                        }
                        _ => ExprValue::Number(left.as_number()? + right.as_number()?),
                    };
                }
                ExprToken::Minus => {
                    self.advance();
                    let right = self.parse_term()?;
                    left = ExprValue::Number(left.as_number()? - right.as_number()?);
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_term(&mut self) -> Result<ExprValue, String> {
        let mut left = self.parse_factor()?;
        loop {
            match self.current() {
                ExprToken::Star => {
                    self.advance();
                    let right = self.parse_factor()?;
                    left = ExprValue::Number(left.as_number()? * right.as_number()?);
                }
                ExprToken::Slash => {
                    self.advance();
                    let right = self.parse_factor()?;
                    let divisor = right.as_number()?;
                    left = ExprValue::Number(safe_divide(left.as_number()?, divisor));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_factor(&mut self) -> Result<ExprValue, String> {
        match self.current() {
            ExprToken::Plus => {
                self.advance();
                Ok(ExprValue::Number(self.parse_factor()?.as_number()?))
            }
            ExprToken::Minus => {
                self.advance();
                Ok(ExprValue::Number(-self.parse_factor()?.as_number()?))
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Result<ExprValue, String> {
        match self.current().clone() {
            ExprToken::Number(number) => {
                self.advance();
                Ok(ExprValue::Number(number))
            }
            ExprToken::Text(text) => {
                self.advance();
                Ok(ExprValue::Text(text))
            }
            ExprToken::Ident(name) => {
                self.advance();
                if matches!(self.current(), ExprToken::LParen) {
                    self.advance();
                    let mut args = Vec::new();
                    if !matches!(self.current(), ExprToken::RParen) {
                        loop {
                            args.push(self.parse_expression()?);
                            if matches!(self.current(), ExprToken::Comma) {
                                self.advance();
                                continue;
                            }
                            break;
                        }
                    }
                    self.expect(ExprToken::RParen)?;
                    self.evaluate_function(&name, args)
                } else {
                    Err(format!("表达式函数不受支持：{name}"))
                }
            }
            ExprToken::LParen => {
                self.advance();
                let value = self.parse_expression()?;
                self.expect(ExprToken::RParen)?;
                Ok(value)
            }
            _ => Err("表达式语法错误。".to_string()),
        }
    }

    fn argument_text(args: &[ExprValue], index: usize) -> String {
        args.get(index).map(ExprValue::as_text).unwrap_or_default()
    }

    fn values_for(&self, field_name: &str) -> Vec<String> {
        self.rows
            .iter()
            .filter_map(|row| row.get(field_name))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect()
    }

    fn evaluate_function(&self, name: &str, args: Vec<ExprValue>) -> Result<ExprValue, String> {
        match name {
            "sum" => {
                let field = Self::argument_text(&args, 0);
                let total = self
                    .values_for(&field)
                    .into_iter()
                    .try_fold(0.0, |total, value| Ok::<_, String>(total + parse_number(value, &field)?))?;
                Ok(ExprValue::Number(total))
            }
            "avg" => {
                let field = Self::argument_text(&args, 0);
                let values = self.values_for(&field);
                if values.is_empty() {
                    return Ok(ExprValue::Number(0.0));
                }
                let total = values
                    .iter()
                    .try_fold(0.0, |total, value| Ok::<_, String>(total + parse_number(value, &field)?))?;
                Ok(ExprValue::Number(total / values.len() as f64))
            }
            "first" => {
                let field = Self::argument_text(&args, 0);
                Ok(ExprValue::Text(
                    self.first_row.get(&field).cloned().unwrap_or_default(),
                ))
            }
            "num" => {
                let field = Self::argument_text(&args, 0);
                Ok(ExprValue::Number(get_expression_number(
                    self.first_row.get(&field).map(String::as_str).unwrap_or(""),
                )?))
            }
            "output" => {
                let field = Self::argument_text(&args, 0);
                Ok(ExprValue::Text(
                    self.output_values.get(&field).cloned().unwrap_or_default(),
                ))
            }
            "output_num" => {
                let field = Self::argument_text(&args, 0);
                Ok(ExprValue::Number(get_expression_number(
                    self.output_values.get(&field).map(String::as_str).unwrap_or(""),
                )?))
            }
            "join" => {
                let field = Self::argument_text(&args, 0);
                let delimiter = if args.len() > 1 {
                    Self::argument_text(&args, 1)
                } else {
                    "\n".to_string()
                };
                Ok(ExprValue::Text(self.values_for(&field).join(&delimiter)))
            }
            "join_unique" => {
                let field = Self::argument_text(&args, 0);
                let delimiter = if args.len() > 1 {
                    Self::argument_text(&args, 1)
                } else {
                    "\n".to_string()
                };
                let mut seen = HashSet::new();
                let values: Vec<String> = self
                    .values_for(&field)
                    .into_iter()
                    .filter(|value| seen.insert(value.clone()))
                    .collect();
                Ok(ExprValue::Text(values.join(&delimiter)))
            }
            "count" => {
                let field = Self::argument_text(&args, 0);
                if field.is_empty() {
                    Ok(ExprValue::Number(self.rows.len() as f64))
                } else {
                    Ok(ExprValue::Number(self.values_for(&field).len() as f64))
                }
            }
            "count_non_empty" => {
                let field = Self::argument_text(&args, 0);
                Ok(ExprValue::Number(self.values_for(&field).len() as f64))
            }
            "count_distinct" => {
                let field = Self::argument_text(&args, 0);
                let count = self.values_for(&field).into_iter().collect::<HashSet<_>>().len();
                Ok(ExprValue::Number(count as f64))
            }
            "sum_latest" => {
                let value_field = Self::argument_text(&args, 0);
                let latest_field = Self::argument_text(&args, 1);
                if value_field.is_empty() || latest_field.is_empty() || self.rows.is_empty() {
                    return Ok(ExprValue::Number(0.0));
                }
                let mut latest_value = String::new();
                for row in self.rows {
                    let candidate = row.get(&latest_field).cloned().unwrap_or_default();
                    if candidate.is_empty() {
                        continue;
                    }
                    if latest_value.is_empty()
                        || compare_maybe_number(&candidate, &latest_value) == Ordering::Greater
                    {
                        latest_value = candidate;
                    }
                }
                if latest_value.is_empty() {
                    return Ok(ExprValue::Number(0.0));
                }
                let mut total = 0.0;
                for row in self.rows {
                    if row.get(&latest_field).map(String::as_str).unwrap_or("") != latest_value {
                        continue;
                    }
                    let raw_value = row.get(&value_field).cloned().unwrap_or_default();
                    if raw_value.is_empty() {
                        continue;
                    }
                    total += parse_number(raw_value, &value_field)?;
                }
                Ok(ExprValue::Number(total))
            }
            "sum_divide" => {
                let numerator_field = Self::argument_text(&args, 0);
                let denominator_field = Self::argument_text(&args, 1);
                let numerator = match self.evaluate_function("sum", vec![ExprValue::Text(numerator_field.clone())])? {
                    ExprValue::Number(number) => number,
                    _ => 0.0,
                };
                let denominator = match self.evaluate_function("num", vec![ExprValue::Text(denominator_field.clone())])? {
                    ExprValue::Number(number) => number,
                    _ => 0.0,
                };
                Ok(ExprValue::Number(safe_divide(numerator, denominator)))
            }
            "sum_divide_sum" => {
                let numerator_field = Self::argument_text(&args, 0);
                let denominator_field = Self::argument_text(&args, 1);
                let numerator = match self.evaluate_function("sum", vec![ExprValue::Text(numerator_field.clone())])? {
                    ExprValue::Number(number) => number,
                    _ => 0.0,
                };
                let denominator = match self.evaluate_function("sum", vec![ExprValue::Text(denominator_field.clone())])? {
                    ExprValue::Number(number) => number,
                    _ => 0.0,
                };
                Ok(ExprValue::Number(safe_divide(numerator, denominator)))
            }
            "coalesce" => {
                for arg in args {
                    let text = arg.as_text();
                    if !text.is_empty() {
                        return Ok(ExprValue::Text(text));
                    }
                }
                Ok(ExprValue::Empty)
            }
            _ => Err(format!("表达式函数不受支持：{name}")),
        }
    }
}

fn evaluate_expression(
    expression_text: &str,
    rows: &[SourceRow],
    first_row: &SourceRow,
    output_values: &HashMap<String, String>,
) -> Result<String, String> {
    let normalized = expression_text.trim();
    if normalized.is_empty() {
        return Ok(String::new());
    }
    match ExprParser::new(normalized, rows, first_row, output_values)?.parse()? {
        ExprValue::Number(number) => Ok(format_number(number)),
        ExprValue::Text(text) => Ok(text.trim().to_string()),
        ExprValue::Empty => Ok(String::new()),
    }
}

fn resolve_fill_value(
    bucket: &ResultBucket,
    field: &Map<String, Value>,
    mapping_indexes: &HashMap<String, HashMap<String, String>>,
    mapping_groups: &[MappingGroup],
) -> String {
    let Some(config) = get_object_from_object(field, "fillConfig") else {
        return String::new();
    };
    if !get_bool_from_object(config, "enabled", false) {
        return String::new();
    }
    let baseline_field = get_text_from_object(config, "baselineField");
    let baseline_value = bucket
        .dimension_values
        .get(&baseline_field)
        .cloned()
        .or_else(|| bucket.output_values.get(&baseline_field).cloned())
        .unwrap_or_default();
    let mapping_group_id = get_text_from_object(config, "mappingGroupId");
    if !mapping_group_id.is_empty() {
        return resolve_baseline_mapping_value(
            mapping_indexes,
            mapping_groups,
            &mapping_group_id,
            &baseline_value,
        );
    }
    let constant_value = get_text_from_object(config, "constantValue");
    if !constant_value.is_empty() {
        return constant_value;
    }
    baseline_value
}

fn resolve_fallback_value(
    bucket: &ResultBucket,
    field: &Map<String, Value>,
    mapping_indexes: &HashMap<String, HashMap<String, String>>,
    mapping_groups: &[MappingGroup],
) -> String {
    let Some(config) = get_object_from_object(field, "fallbackConfig") else {
        return String::new();
    };
    if !get_bool_from_object(config, "enabled", false) {
        return String::new();
    }
    match get_text_from_object(config, "mode").as_str() {
        "empty" => String::new(),
        "constant" => get_text_from_object(config, "constantValue"),
        "baseline" => {
            let baseline_field = get_text_from_object(config, "baselineField");
            bucket
                .dimension_values
                .get(&baseline_field)
                .cloned()
                .or_else(|| bucket.output_values.get(&baseline_field).cloned())
                .unwrap_or_default()
        }
        "mapping" => {
            let baseline_field = get_text_from_object(config, "baselineField");
            let baseline_value = bucket
                .dimension_values
                .get(&baseline_field)
                .cloned()
                .or_else(|| bucket.output_values.get(&baseline_field).cloned())
                .unwrap_or_default();
            resolve_baseline_mapping_value(
                mapping_indexes,
                mapping_groups,
                &get_text_from_object(config, "mappingGroupId"),
                &baseline_value,
            )
        }
        _ => String::new(),
    }
}

fn resolve_scalar_output_value(
    bucket: &ResultBucket,
    working_rows: &[WorkingRecord],
    field: &Map<String, Value>,
    mapping_indexes: &HashMap<String, HashMap<String, String>>,
    mapping_groups: &[MappingGroup],
) -> Result<String, String> {
    if get_text_from_object(field, "valueMode") == "constant" {
        return finalize_output_value(field, get_text_from_object(field, "constantValue"));
    }
    let matched_rows = extract_matched_source_rows(bucket, working_rows, field);
    let empty_row = SourceRow::new();
    let first_row = matched_rows.first().unwrap_or(&empty_row);
    let mut value = match get_text_from_object(field, "valueMode").as_str() {
        "source" | "first" => first_row
            .get(&get_text_from_object(field, "sourceField"))
            .cloned()
            .unwrap_or_default(),
        "last" => matched_rows
            .last()
            .and_then(|row| row.get(&get_text_from_object(field, "sourceField")))
            .cloned()
            .unwrap_or_default(),
        "sum" => {
            let source_field = get_text_from_object(field, "sourceField");
            if matched_rows.is_empty() {
                String::new()
            } else {
                format_number(matched_rows.iter().try_fold(0.0, |total, row| {
                    Ok::<_, String>(total + parse_number(
                        row.get(&source_field).cloned().unwrap_or_default(),
                        &source_field,
                    )?)
                })?)
            }
        }
        "avg" => {
            let source_field = get_text_from_object(field, "sourceField");
            if matched_rows.is_empty() {
                String::new()
            } else {
                format_number(
                    matched_rows.iter().try_fold(0.0, |total, row| {
                        Ok::<_, String>(total + parse_number(
                            row.get(&source_field).cloned().unwrap_or_default(),
                            &source_field,
                        )?)
                    })? / matched_rows.len() as f64,
                )
            }
        }
        "count" => {
            let source_field = get_text_from_object(field, "sourceField");
            matched_rows
                .iter()
                .filter_map(|row| row.get(&source_field))
                .filter(|value| !value.trim().is_empty())
                .count()
                .to_string()
        }
        "count_distinct" => {
            let source_field = get_text_from_object(field, "sourceField");
            matched_rows
                .iter()
                .filter_map(|row| row.get(&source_field))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<HashSet<_>>()
                .len()
                .to_string()
        }
        "mapping" => {
            let source_values: Vec<String> = {
                let mapping_fields = get_array_from_object(field, "mappingSourceFields");
                if mapping_fields.is_empty() {
                    vec![resolve_field_value(
                        bucket,
                        first_row,
                        &get_text_from_object(field, "sourceField"),
                    )]
                } else {
                    mapping_fields
                        .iter()
                        .map(|name| resolve_field_value(bucket, first_row, &as_text_value(Some(name))))
                        .collect()
                }
            };
            let mut mapped = if source_values.len() > 1 {
                resolve_multi_mapping_value(
                    mapping_indexes,
                    &get_text_from_object(field, "mappingGroupId"),
                    &source_values,
                )
            } else {
                resolve_mapping_value(
                    mapping_indexes,
                    &get_text_from_object(field, "mappingGroupId"),
                    source_values.first().map(String::as_str).unwrap_or(""),
                )
            };
            if (mapped.is_empty() || mapped == UNKNOWN_FALLBACK)
                && get_object_from_object(field, "fillConfig")
                    .map(|config| get_bool_from_object(config, "enabled", false))
                    .unwrap_or(false)
            {
                mapped = resolve_fill_value(bucket, field, mapping_indexes, mapping_groups);
            }
            mapped
        }
        "expression" => evaluate_expression(
            &get_text_from_object(field, "expressionText"),
            &matched_rows,
            first_row,
            &bucket.output_values,
        )?,
        "fill" => resolve_fill_value(bucket, field, mapping_indexes, mapping_groups),
        "text_aggregate" => aggregate_text(&matched_rows, field),
        _ => first_row
            .get(&get_text_from_object(field, "sourceField"))
            .cloned()
            .unwrap_or_default(),
    };

    if value.is_empty() || value == UNKNOWN_FALLBACK {
        let fallback_value = resolve_fallback_value(bucket, field, mapping_indexes, mapping_groups);
        if !fallback_value.is_empty()
            || get_object_from_object(field, "fallbackConfig")
                .map(|config| get_bool_from_object(config, "enabled", false))
                .unwrap_or(false)
        {
            value = fallback_value;
        }
    }
    finalize_output_value(field, value)
}

fn resolve_output_field_header_name(
    field: &Map<String, Value>,
    sheet_record_indices: &[usize],
    working_rows: &[WorkingRecord],
    mapping_indexes: &HashMap<String, HashMap<String, String>>,
) -> Result<String, String> {
    match get_text_from_object(field, "nameMode").as_str() {
        "fixed" => {
            let field_name = get_text_from_object(field, "fieldName");
            Ok(if field_name.is_empty() {
                "未命名字段".to_string()
            } else {
                field_name
            })
        }
        "source_field" => {
            let table_id = get_text_from_object(field, "nameSourceTableId");
            let source_field = get_text_from_object(field, "nameSourceField");
            let source_row = sheet_record_indices.iter().find_map(|record_index| {
                let record = working_rows.get(*record_index)?;
                record
                    .source_rows
                    .get(&table_id)
                    .and_then(|row| row.as_ref())
                    .cloned()
            });
            let value = source_row
                .and_then(|row| row.get(&source_field).cloned())
                .unwrap_or_default();
            Ok(if value.is_empty() {
                let fallback = get_text_from_object(field, "fieldName");
                if fallback.is_empty() {
                    "未命名字段".to_string()
                } else {
                    fallback
                }
            } else {
                value
            })
        }
        "mapping" => {
            let table_id = get_text_from_object(field, "nameSourceTableId");
            let source_row = sheet_record_indices.iter().find_map(|record_index| {
                let record = working_rows.get(*record_index)?;
                record
                    .source_rows
                    .get(&table_id)
                    .and_then(|row| row.as_ref())
                    .cloned()
            });
            let source_values: Vec<String> = get_array_from_object(field, "nameMappingSourceFields")
                .iter()
                .map(|name| {
                    source_row
                        .as_ref()
                        .and_then(|row| row.get(&as_text_value(Some(name))))
                        .cloned()
                        .unwrap_or_default()
                })
                .collect();
            let mapped_value = if source_values.len() > 1 {
                resolve_multi_mapping_value(
                    mapping_indexes,
                    &get_text_from_object(field, "nameMappingGroupId"),
                    &source_values,
                )
            } else {
                resolve_mapping_value(
                    mapping_indexes,
                    &get_text_from_object(field, "nameMappingGroupId"),
                    source_values.first().map(String::as_str).unwrap_or(""),
                )
            };
            let fallback = get_text_from_object(field, "fieldName");
            Ok(if mapped_value.is_empty() {
                if fallback.is_empty() {
                    "未命名字段".to_string()
                } else {
                    fallback
                }
            } else {
                mapped_value
            })
        }
        "expression" => {
            let table_id = get_text_from_object(field, "nameSourceTableId");
            let source_row = sheet_record_indices.iter().find_map(|record_index| {
                let record = working_rows.get(*record_index)?;
                record
                    .source_rows
                    .get(&table_id)
                    .and_then(|row| row.as_ref())
                    .cloned()
            });
            let fallback = get_text_from_object(field, "fieldName");
            let row = source_row.unwrap_or_default();
            let value = evaluate_expression(
                &get_text_from_object(field, "nameExpressionText"),
                if row.is_empty() { &[] } else { std::slice::from_ref(&row) },
                &row,
                &HashMap::new(),
            )?;
            Ok(if value.is_empty() {
                if fallback.is_empty() {
                    "未命名字段".to_string()
                } else {
                    fallback
                }
            } else {
                value
            })
        }
        _ => {
            let field_name = get_text_from_object(field, "fieldName");
            Ok(if field_name.is_empty() {
                "未命名字段".to_string()
            } else {
                field_name
            })
        }
    }
}

fn resolve_output_field_selection_label(
    field: &Map<String, Value>,
    index: usize,
    mapping_groups: &[MappingGroup],
) -> String {
    match get_text_from_object(field, "nameMode").as_str() {
        "source_field" => {
            let source_field = get_text_from_object(field, "nameSourceField");
            if source_field.is_empty() {
                format!("字段_{}", index + 1)
            } else {
                format!("{{{{{source_field}}}}}")
            }
        }
        "mapping" => mapping_groups
            .iter()
            .find(|group| group.id == get_text_from_object(field, "nameMappingGroupId"))
            .and_then(|group| group.name.clone())
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| format!("字段_{}", index + 1)),
        "expression" => {
            let expression = get_text_from_object(field, "nameExpressionText");
            if expression.is_empty() {
                format!("字段_{}", index + 1)
            } else {
                format!("={expression}")
            }
        }
        _ => {
            let field_name = get_text_from_object(field, "fieldName");
            if field_name.is_empty() {
                format!("字段_{}", index + 1)
            } else {
                field_name
            }
        }
    }
}

fn build_dynamic_header_config(
    field: &Map<String, Value>,
    sheet_record_indices: &[usize],
    working_rows: &[WorkingRecord],
) -> DynamicHeaderConfig {
    let source_table_id = get_text_from_object(field, "sourceTableId");
    let column_field = get_object_from_object(field, "dynamicColumnConfig")
        .map(|config| get_text_from_object(config, "columnField"))
        .unwrap_or_default();
    let name_prefix = get_object_from_object(field, "dynamicColumnConfig")
        .map(|config| get_text_from_object(config, "namePrefix"))
        .unwrap_or_default();
    let name_suffix = get_object_from_object(field, "dynamicColumnConfig")
        .map(|config| get_text_from_object(config, "nameSuffix"))
        .unwrap_or_default();

    let mut values = HashSet::new();
    for record_index in sheet_record_indices {
        let Some(record) = working_rows.get(*record_index) else {
            continue;
        };
        let Some(Some(row)) = record.source_rows.get(&source_table_id) else {
            continue;
        };
        if !matches_output_filters(field, row) {
            continue;
        }
        let raw_value = row.get(&column_field).cloned().unwrap_or_default();
        if !raw_value.is_empty() {
            values.insert(raw_value);
        }
    }

    let mut headers: Vec<String> = values.into_iter().collect();
    headers.sort_by(|left, right| compare_text(left, right));
    let mut header_map = HashMap::new();
    let normalized_headers = headers
        .into_iter()
        .map(|raw_value| {
            let header = format!("{name_prefix}{raw_value}{name_suffix}");
            header_map.insert(raw_value, header.clone());
            header
        })
        .collect();

    DynamicHeaderConfig {
        headers: normalized_headers,
        header_map,
    }
}

fn build_unique_headers(headers: &[String]) -> Vec<String> {
    let mut used = HashSet::new();
    headers
        .iter()
        .map(|header| {
            let base_header = if header.trim().is_empty() {
                "未命名字段".to_string()
            } else {
                header.trim().to_string()
            };
            let mut candidate = base_header.clone();
            let mut suffix = 2usize;
            while used.contains(&candidate) {
                candidate = format!("{base_header}_{suffix}");
                suffix += 1;
            }
            used.insert(candidate.clone());
            candidate
        })
        .collect()
}

fn render_template(template: &str, values: &HashMap<String, String>) -> String {
    let mut result = String::new();
    let chars: Vec<char> = template.trim().chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        if index + 1 < chars.len() && chars[index] == '{' && chars[index + 1] == '{' {
            index += 2;
            let start = index;
            while index + 1 < chars.len() && !(chars[index] == '}' && chars[index + 1] == '}') {
                index += 1;
            }
            let key = chars[start..index].iter().collect::<String>().trim().to_string();
            result.push_str(values.get(&key).map(String::as_str).unwrap_or(""));
            if index + 1 < chars.len() {
                index += 2;
            }
            continue;
        }
        result.push(chars[index]);
        index += 1;
    }
    result
}

fn sanitize_sheet_name(value: &str) -> String {
    let normalized = value
        .trim()
        .replace([':', '\\', '/', '?', '*', '[', ']'], "_")
        .trim_matches('\'')
        .to_string();
    let fallback = if normalized.is_empty() {
        "Sheet".to_string()
    } else {
        normalized
    };
    fallback.chars().take(31).collect()
}

fn unique_sheet_name(name: &str, used_names: &mut HashSet<String>) -> String {
    let base = sanitize_sheet_name(name);
    if used_names.insert(base.clone()) {
        return base;
    }
    let mut index = 2usize;
    loop {
        let suffix = format!("_{index}");
        let trimmed: String = base.chars().take(31usize.saturating_sub(suffix.len())).collect();
        let candidate = format!("{trimmed}{suffix}");
        if used_names.insert(candidate.clone()) {
            return candidate;
        }
        index += 1;
    }
}

fn parse_date_parts(text: &str) -> Option<(i32, u32, u32)> {
    let normalized = text.trim();
    if normalized.is_empty() {
        return None;
    }
    if normalized.len() == 8 && normalized.chars().all(|char| char.is_ascii_digit()) {
        return Some((
            normalized[0..4].parse().ok()?,
            normalized[4..6].parse().ok()?,
            normalized[6..8].parse().ok()?,
        ));
    }
    let normalized = normalized
        .replace(['年', '/', '.'], "-")
        .replace('月', "-")
        .replace('日', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut parts = normalized.split('-');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse().ok()?;
    let day_text = parts.next()?.split_whitespace().next()?.to_string();
    let day = day_text.parse().ok()?;
    Some((year, month, day))
}

fn format_date_value(value: &str, format: &str) -> String {
    let normalized = value.trim();
    if normalized.is_empty() {
        return String::new();
    }
    let Some((year, month, day)) = parse_date_parts(normalized) else {
        return normalized.to_string();
    };
    let mut output = if format.trim().is_empty() {
        "YYYY/M/D".to_string()
    } else {
        format.trim().to_string()
    };
    output = output.replace("YYYY", &year.to_string());
    output = output.replace("MM", &format!("{month:02}"));
    output = output.replace("DD", &format!("{day:02}"));
    output = output.replace('M', &month.to_string());
    output = output.replace('D', &day.to_string());
    output
}

fn append_total_row(
    headers: &[String],
    rows: &[Vec<String>],
    rule: &Map<String, Value>,
    total_field_groups: &HashMap<String, Vec<String>>,
) -> Result<Vec<Vec<String>>, String> {
    let Some(result) = get_object_from_object(rule, "result") else {
        return Ok(rows.to_vec());
    };
    let Some(total_row) = get_object_from_object(result, "totalRow") else {
        return Ok(rows.to_vec());
    };
    if !get_bool_from_object(total_row, "enabled", false) || headers.is_empty() {
        return Ok(rows.to_vec());
    }
    let header_index_map: HashMap<String, usize> =
        headers.iter().enumerate().map(|(index, header)| (header.clone(), index)).collect();
    let mut next_total_row = vec![String::new(); headers.len()];
    let mut total_row_output_values = HashMap::new();
    let label = {
        let value = get_text_from_object(total_row, "label");
        if value.is_empty() {
            "总计".to_string()
        } else {
            value
        }
    };
    let label_field = get_text_from_object(total_row, "labelField");
    let mut label_candidates = Vec::new();
    if !label_field.is_empty() {
        label_candidates.push(label_field.clone());
        label_candidates.extend(total_field_groups.get(&label_field).cloned().unwrap_or_default());
    }
    let resolved_label_field = label_candidates
        .into_iter()
        .find(|field| header_index_map.contains_key(field));
    if let Some(field) = resolved_label_field {
        if let Some(column_index) = header_index_map.get(&field) {
            next_total_row[*column_index] = label.clone();
            total_row_output_values.insert(field, label.clone());
        }
    } else {
        next_total_row[0] = label.clone();
        total_row_output_values.insert(headers[0].clone(), label);
    }

    let resolve_target_fields = |field_name: &str| -> Vec<String> {
        if header_index_map.contains_key(field_name) {
            return vec![field_name.to_string()];
        }
        total_field_groups
            .get(field_name)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|field| header_index_map.contains_key(field))
            .collect()
    };

    for config in get_array_from_object(total_row, "fieldConfigs") {
        let Some(config_object) = config.as_object() else {
            continue;
        };
        for field_name in resolve_target_fields(&get_text_from_object(config_object, "fieldName")) {
            let Some(column_index) = header_index_map.get(&field_name) else {
                continue;
            };
            let value = match get_text_from_object(config_object, "aggregateMode").as_str() {
                "fixed" => get_text_from_object(config_object, "fixedValue"),
                "expression" => evaluate_expression(
                    &get_text_from_object(config_object, "expressionText"),
                    &[],
                    &SourceRow::new(),
                    &total_row_output_values,
                )?,
                "single_first" => rows
                    .iter()
                    .filter_map(|row| row.get(*column_index))
                    .find(|value| !value.trim().is_empty())
                    .cloned()
                    .unwrap_or_default(),
                "single_last" => rows
                    .iter()
                    .rev()
                    .filter_map(|row| row.get(*column_index))
                    .find(|value| !value.trim().is_empty())
                    .cloned()
                    .unwrap_or_default(),
                "avg" => {
                    let values: Vec<f64> = rows
                        .iter()
                        .filter_map(|row| row.get(*column_index))
                        .filter_map(|value| value.trim().replace(',', "").parse::<f64>().ok())
                        .collect();
                    if values.is_empty() {
                        String::new()
                    } else {
                        format_number(values.iter().sum::<f64>() / values.len() as f64)
                    }
                }
                _ => {
                    let total = rows
                        .iter()
                        .filter_map(|row| row.get(*column_index))
                        .filter_map(|value| value.trim().replace(',', "").parse::<f64>().ok())
                        .sum::<f64>();
                    if total == 0.0
                        && !rows.iter().any(|row| {
                            row.get(*column_index)
                                .and_then(|value| value.trim().replace(',', "").parse::<f64>().ok())
                                .is_some()
                        })
                    {
                        String::new()
                    } else {
                        format_number(total)
                    }
                }
            };
            next_total_row[*column_index] = value.clone();
            total_row_output_values.insert(field_name.clone(), value);
        }
    }

    let mut merged = rows.to_vec();
    merged.push(next_total_row);
    Ok(merged)
}

fn build_engine_output(
    rule: &Map<String, Value>,
    loaded_sources: &HashMap<String, LoadedSource>,
    working_rows: &[WorkingRecord],
    mapping_groups: &[MappingGroup],
    mapping_indexes: &HashMap<String, HashMap<String, String>>,
) -> Result<EngineOutput, String> {
    let result = get_object_from_object(rule, "result")
        .ok_or_else(|| "规则缺少结果配置。".to_string())?;
    let sheet_template = get_object_from_object(rule, "sheetTemplate")
        .ok_or_else(|| "规则缺少导出模板配置。".to_string())?;
    let dimension_labels: Vec<String> = get_array_from_object(result, "groupFields")
        .iter()
        .filter_map(Value::as_object)
        .map(|field| get_text_from_object(field, "label"))
        .collect();
    let visible_dimension_labels: Vec<String> = get_array_from_object(result, "groupFields")
        .iter()
        .filter_map(Value::as_object)
        .filter(|field| get_bool_from_object(field, "visible", true))
        .map(|field| get_text_from_object(field, "label"))
        .collect();
    let source_order: Vec<String> = get_array_from_object(rule, "sources")
        .iter()
        .filter_map(Value::as_object)
        .map(|source| get_text_from_object(source, "id"))
        .collect();
    let baseline_values = resolve_completion_baseline_values(rule, loaded_sources, mapping_groups);
    let excluded_sheet_values = resolve_sheet_value_exclusions(rule, mapping_groups);
    let sheet_config = get_object_from_object(result, "sheetConfig")
        .ok_or_else(|| "规则缺少分 Sheet 配置。".to_string())?;

    let mut sheet_order = Vec::new();
    let mut sheet_buckets: HashMap<String, Vec<usize>> = HashMap::new();
    for (record_index, record) in working_rows.iter().enumerate() {
        let dimension_values = build_dimension_values(rule, record);
        let raw_sheet_name = if get_text_from_object(sheet_config, "mode") == "split_field" {
            let split_value = if get_text_from_object(sheet_config, "splitFieldScope") == "result_field" {
                dimension_values
                    .get(&get_text_from_object(sheet_config, "splitField"))
                    .cloned()
                    .unwrap_or_default()
            } else {
                resolve_source_value(
                    record,
                    &get_text_from_object(sheet_config, "splitSourceTableId"),
                    &get_text_from_object(sheet_config, "splitField"),
                )
            };
            if !split_value.is_empty() && excluded_sheet_values.contains(&split_value) {
                continue;
            }
            let fallback = if split_value.is_empty() {
                "未命名Sheet".to_string()
            } else {
                split_value
            };
            let template = get_text_from_object(sheet_config, "sheetNameTemplate");
            if template.is_empty() {
                fallback
            } else {
                let rendered = render_template(&template, &dimension_values);
                if rendered.is_empty() {
                    fallback
                } else {
                    rendered
                }
            }
        } else {
            let rule_name = get_text_from_object(rule, "name");
            if rule_name.is_empty() {
                "Sheet1".to_string()
            } else {
                rule_name
            }
        };
        if !sheet_buckets.contains_key(&raw_sheet_name) {
            sheet_order.push(raw_sheet_name.clone());
        }
        sheet_buckets.entry(raw_sheet_name).or_default().push(record_index);
    }
    if sheet_buckets.is_empty() {
        let default_name = {
            let name = get_text_from_object(rule, "name");
            if name.is_empty() {
                "Sheet1".to_string()
            } else {
                name
            }
        };
        sheet_order.push(default_name.clone());
        sheet_buckets.insert(default_name, Vec::new());
    }

    let mut sheets = Vec::new();
    let mut used_sheet_names = HashSet::new();
    let mut total_row_count = 0usize;

    for raw_sheet_name in sheet_order {
        let records_in_sheet = sheet_buckets.get(&raw_sheet_name).cloned().unwrap_or_default();
        let mut grouped = HashMap::new();
        for record_index in &records_in_sheet {
            let Some(record) = working_rows.get(*record_index) else {
                continue;
            };
            let dimension_values = build_dimension_values(rule, record);
            let key = build_group_key_by_labels(&dimension_labels, &dimension_values);
            grouped
                .entry(key.clone())
                .and_modify(|bucket: &mut ResultBucket| bucket.record_indices.push(*record_index))
                .or_insert_with(|| ResultBucket {
                    key,
                    dimension_values,
                    record_indices: vec![*record_index],
                    output_values: HashMap::new(),
                    row_values: Vec::new(),
                    merged_source_values: merge_source_values(record, &source_order),
                });
        }

        let mut result_buckets = apply_row_completion(
            rule,
            grouped.into_values().collect(),
            &baseline_values,
        );

        let mut dynamic_header_configs = HashMap::new();
        let mut output_field_label_map = HashMap::new();
        let output_fields = get_array_from_object(rule, "outputFields");
        for (index, field) in output_fields.iter().enumerate() {
            let Some(field_object) = field.as_object() else {
                continue;
            };
            let base_label = resolve_output_field_header_name(
                field_object,
                &records_in_sheet,
                working_rows,
                mapping_indexes,
            )?;
            output_field_label_map.insert(
                get_text_from_object(field_object, "id"),
                if base_label.is_empty() {
                    format!("字段_{}", index + 1)
                } else {
                    base_label
                },
            );
            let dynamic_config = get_object_from_object(field_object, "dynamicColumnConfig");
            if get_text_from_object(field_object, "valueMode") == "dynamic_columns"
                && dynamic_config
                    .map(|config| get_bool_from_object(config, "enabled", false))
                    .unwrap_or(false)
            {
                dynamic_header_configs.insert(
                    get_text_from_object(field_object, "id"),
                    build_dynamic_header_config(field_object, &records_in_sheet, working_rows),
                );
            }
        }

        let mut header_seeds = visible_dimension_labels.clone();
        let mut total_field_groups: HashMap<String, Vec<String>> = HashMap::new();
        for (index, field) in output_fields.iter().enumerate() {
            let Some(field_object) = field.as_object() else {
                continue;
            };
            let field_id = get_text_from_object(field_object, "id");
            let base_label = output_field_label_map
                .get(&field_id)
                .cloned()
                .unwrap_or_else(|| {
                    let field_name = get_text_from_object(field_object, "fieldName");
                    if field_name.is_empty() {
                        "未命名字段".to_string()
                    } else {
                        field_name
                    }
                });
            let selection_label = resolve_output_field_selection_label(field_object, index, mapping_groups);
            let dynamic_config = get_object_from_object(field_object, "dynamicColumnConfig");
            if get_text_from_object(field_object, "valueMode") == "dynamic_columns"
                && dynamic_config
                    .map(|config| get_bool_from_object(config, "enabled", false))
                    .unwrap_or(false)
            {
                let headers = dynamic_header_configs
                    .get(&field_id)
                    .map(|config| config.headers.clone())
                    .unwrap_or_default();
                total_field_groups.insert(base_label.clone(), headers.clone());
                total_field_groups.insert(selection_label, headers.clone());
                header_seeds.extend(headers);
                continue;
            }
            total_field_groups.insert(base_label.clone(), vec![base_label.clone()]);
            total_field_groups.insert(selection_label, vec![base_label.clone()]);
            header_seeds.push(base_label);
        }

        let headers = build_unique_headers(&header_seeds);
        let mut final_total_field_groups = HashMap::new();
        for (group_name, values) in &total_field_groups {
            final_total_field_groups.insert(
                group_name.clone(),
                values
                    .iter()
                    .map(|header| {
                        headers
                            .iter()
                            .find(|item| *item == header)
                            .cloned()
                            .unwrap_or_else(|| header.clone())
                    })
                    .collect(),
            );
        }

        for bucket in &mut result_buckets {
            let mut output_values = HashMap::new();
            let max_passes = output_fields.len().max(1);
            for _ in 0..max_passes {
                let mut changed = false;
                for (index, field) in output_fields.iter().enumerate() {
                    let Some(field_object) = field.as_object() else {
                        continue;
                    };
                    let field_id = get_text_from_object(field_object, "id");
                    let base_label = output_field_label_map
                        .get(&field_id)
                        .cloned()
                        .unwrap_or_else(|| {
                            let field_name = get_text_from_object(field_object, "fieldName");
                            if field_name.is_empty() {
                                "未命名字段".to_string()
                            } else {
                                field_name
                            }
                        });
                    let selection_label =
                        resolve_output_field_selection_label(field_object, index, mapping_groups);
                    let dynamic_config = get_object_from_object(field_object, "dynamicColumnConfig");
                    if get_text_from_object(field_object, "valueMode") == "dynamic_columns"
                        && dynamic_config
                            .map(|config| get_bool_from_object(config, "enabled", false))
                            .unwrap_or(false)
                    {
                        let config = dynamic_header_configs.get(&field_id).cloned();
                        if let Some(dynamic_headers) = config.as_ref().map(|item| item.headers.clone()) {
                            for dynamic_header in &dynamic_headers {
                                if !output_values.contains_key(dynamic_header) {
                                    output_values.insert(dynamic_header.clone(), String::new());
                                    changed = true;
                                }
                            }
                        }
                        let matched_rows = extract_matched_source_rows(bucket, working_rows, field_object);
                        let column_field = dynamic_config
                            .map(|config| get_text_from_object(config, "columnField"))
                            .unwrap_or_default();
                        let value_field = dynamic_config
                            .map(|config| get_text_from_object(config, "valueField"))
                            .unwrap_or_default();
                        let mut totals: HashMap<String, f64> = HashMap::new();
                        let mut has_number = HashSet::new();
                        for row in matched_rows {
                            let raw_key = row.get(&column_field).cloned().unwrap_or_default();
                            if raw_key.is_empty() {
                                continue;
                            }
                            let Some(dynamic_header) = config
                                .as_ref()
                                .and_then(|config| config.header_map.get(&raw_key))
                                .cloned()
                            else {
                                continue;
                            };
                            let raw_value = row.get(&value_field).cloned().unwrap_or_default();
                            if raw_value.is_empty()
                                || raw_value == UNKNOWN_FALLBACK
                                || raw_value == "-"
                                || raw_value == "未知错误填充"
                            {
                                continue;
                            }
                            let next_value = parse_number(&raw_value, &value_field)?;
                            *totals.entry(dynamic_header.clone()).or_insert(0.0) += next_value;
                            has_number.insert(dynamic_header);
                        }
                        for (dynamic_header, total) in totals {
                            if has_number.contains(&dynamic_header) {
                                let next_value = format_number(total);
                                if output_values.get(&dynamic_header) != Some(&next_value) {
                                    output_values.insert(dynamic_header, next_value);
                                    changed = true;
                                }
                            }
                        }
                        total_field_groups.insert(
                            base_label.clone(),
                            config.as_ref().map(|config| config.headers.clone()).unwrap_or_default(),
                        );
                        total_field_groups.insert(
                            selection_label,
                            config.as_ref().map(|config| config.headers.clone()).unwrap_or_default(),
                        );
                        continue;
                    }
                    if matches!(
                        get_text_from_object(field_object, "valueMode").as_str(),
                        "dynamic_group_sum" | "dynamic_group_avg"
                    ) {
                        let mut next_value = resolve_dynamic_group_aggregate_value(
                            field_object,
                            &output_values,
                            &dynamic_header_configs,
                        )?;
                        if next_value.is_empty() || next_value == UNKNOWN_FALLBACK {
                            let fallback_value = resolve_fallback_value(
                                &ResultBucket {
                                    output_values: output_values.clone(),
                                    ..bucket.clone()
                                },
                                field_object,
                                mapping_indexes,
                                mapping_groups,
                            );
                            if !fallback_value.is_empty()
                                || get_object_from_object(field_object, "fallbackConfig")
                                    .map(|config| get_bool_from_object(config, "enabled", false))
                                    .unwrap_or(false)
                            {
                                next_value = fallback_value;
                            }
                        }
                        let next_value = finalize_output_value(field_object, next_value)?;
                        if output_values.get(&base_label) != Some(&next_value) {
                            output_values.insert(base_label, next_value);
                            changed = true;
                        }
                        continue;
                    }
                    let next_value = resolve_scalar_output_value(
                        &ResultBucket {
                            output_values: output_values.clone(),
                            ..bucket.clone()
                        },
                        working_rows,
                        field_object,
                        mapping_indexes,
                        mapping_groups,
                    )?;
                    if output_values.get(&base_label) != Some(&next_value) {
                        output_values.insert(base_label, next_value);
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }
            bucket.output_values = output_values;
            bucket.row_values = headers
                .iter()
                .map(|header| {
                    if visible_dimension_labels.contains(header) {
                        bucket.dimension_values.get(header).cloned().unwrap_or_default()
                    } else {
                        bucket.output_values.get(header).cloned().unwrap_or_default()
                    }
                })
                .collect();
        }

        let sort_fields = get_array_from_object(result, "sortFields");
        result_buckets.sort_by(|left, right| {
            for sort_field in sort_fields {
                let Some(sort_field_object) = sort_field.as_object() else {
                    continue;
                };
                let field_name = get_text_from_object(sort_field_object, "fieldName");
                let left_value = left
                    .dimension_values
                    .get(&field_name)
                    .cloned()
                    .or_else(|| left.output_values.get(&field_name).cloned())
                    .unwrap_or_default();
                let right_value = right
                    .dimension_values
                    .get(&field_name)
                    .cloned()
                    .or_else(|| right.output_values.get(&field_name).cloned())
                    .unwrap_or_default();
                let result = compare_maybe_number(&left_value, &right_value);
                if result != Ordering::Equal {
                    return if get_text_from_object(sort_field_object, "direction") == "desc" {
                        result.reverse()
                    } else {
                        result
                    };
                }
            }
            compare_text(&left.key, &right.key)
        });

        let row_matrix: Vec<Vec<String>> = result_buckets
            .iter()
            .map(|bucket| bucket.row_values.clone())
            .collect();
        let row_matrix = append_total_row(&headers, &row_matrix, rule, &final_total_field_groups)?;

        let mut title_values: HashMap<String, Vec<String>> = HashMap::new();
        for bucket in &result_buckets {
            for (key, value) in &bucket.dimension_values {
                if !value.is_empty() {
                    title_values.entry(key.clone()).or_default().push(value.clone());
                }
            }
            for (key, value) in &bucket.output_values {
                if !value.is_empty() {
                    title_values.entry(key.clone()).or_default().push(value.clone());
                }
            }
            for (key, value) in &bucket.merged_source_values {
                if !value.is_empty() {
                    title_values.entry(key.clone()).or_default().push(value.clone());
                }
            }
        }
        let title_context: HashMap<String, String> = title_values
            .into_iter()
            .map(|(key, values)| {
                let mut seen = HashSet::new();
                let merged = values
                    .into_iter()
                    .filter(|value| seen.insert(value.clone()))
                    .collect::<Vec<_>>()
                    .join(" / ");
                (key, merged)
            })
            .collect();
        let sheet_title = if get_bool_from_object(sheet_template, "titleEnabled", false) {
            render_template(&get_text_from_object(sheet_template, "titleTemplate"), &title_context)
        } else {
            String::new()
        };
        let sheet_name = unique_sheet_name(&raw_sheet_name, &mut used_sheet_names);
        total_row_count += row_matrix.len();
        sheets.push(EngineSheetOutput {
            name: sheet_name,
            title: sheet_title,
            title_enabled: get_bool_from_object(sheet_template, "titleEnabled", false),
            total_row_enabled: get_object_from_object(result, "totalRow")
                .map(|config| get_bool_from_object(config, "enabled", false))
                .unwrap_or(false),
            group_header_enabled: false,
            group_header_label: String::new(),
            group_header_start_column_index: 0,
            header_row_index: get_usize_from_object(sheet_template, "headerRowIndex", 1),
            data_start_row_index: get_usize_from_object(sheet_template, "dataStartRowIndex", 2),
            reserved_footer_rows: 0,
            headers,
            rows: row_matrix,
            style_config: parse_style_config(rule.get("styleConfig")),
        });
    }

    Ok(EngineOutput {
        ok: true,
        sheet_count: sheets.len(),
        row_count: total_row_count,
        sheets,
    })
}

fn default_style_token(bold: bool, font_size: usize, text_color: &str, background_color: &str) -> EngineStyleToken {
    EngineStyleToken {
        bold,
        font_size,
        text_color: text_color.to_string(),
        background_color: background_color.to_string(),
        horizontal_align: "center".to_string(),
    }
}

fn parse_style_token(value: Option<&Value>, fallback: EngineStyleToken) -> EngineStyleToken {
    let Some(object) = value.and_then(Value::as_object) else {
        return fallback;
    };
    EngineStyleToken {
        bold: get_bool_from_object(object, "bold", fallback.bold),
        font_size: get_usize_from_object(object, "fontSize", fallback.font_size),
        text_color: {
            let value = get_text_from_object(object, "textColor");
            if value.is_empty() {
                fallback.text_color
            } else {
                value
            }
        },
        background_color: {
            let value = get_text_from_object(object, "backgroundColor");
            if value.is_empty() {
                fallback.background_color
            } else {
                value
            }
        },
        horizontal_align: {
            let value = get_text_from_object(object, "horizontalAlign");
            if value.is_empty() {
                fallback.horizontal_align
            } else {
                value
            }
        },
    }
}

fn parse_style_config(value: Option<&Value>) -> EngineStyleConfig {
    let title_fallback = EngineStyleToken {
        bold: true,
        font_size: 20,
        text_color: String::new(),
        background_color: String::new(),
        horizontal_align: "center".to_string(),
    };
    let header_fallback = EngineStyleToken {
        bold: true,
        font_size: 12,
        text_color: String::new(),
        background_color: "#F3F4F6".to_string(),
        horizontal_align: "center".to_string(),
    };
    let data_fallback = default_style_token(false, 12, "", "");
    let total_fallback = EngineStyleToken {
        bold: true,
        font_size: 12,
        text_color: "#FF0000".to_string(),
        background_color: String::new(),
        horizontal_align: "center".to_string(),
    };
    let Some(object) = value.and_then(Value::as_object) else {
        return EngineStyleConfig {
            title: title_fallback,
            header: header_fallback,
            data: data_fallback,
            total_row: total_fallback,
        };
    };
    EngineStyleConfig {
        title: parse_style_token(object.get("title"), title_fallback),
        header: parse_style_token(object.get("header"), header_fallback),
        data: parse_style_token(object.get("data"), data_fallback),
        total_row: parse_style_token(object.get("totalRow"), total_fallback),
    }
}

impl StyleRegistry {
    fn new() -> Self {
        Self {
            styles: Vec::new(),
            index_by_key: HashMap::new(),
        }
    }

    fn register(&mut self, token: &EngineStyleToken) -> usize {
        let key = StyleKey {
            bold: token.bold,
            font_size: token.font_size,
            text_color: token.text_color.clone(),
            background_color: token.background_color.clone(),
            horizontal_align: token.horizontal_align.clone(),
        };
        if let Some(index) = self.index_by_key.get(&key) {
            return *index;
        }
        let index = self.styles.len() + 1;
        self.styles.push(key.clone());
        self.index_by_key.insert(key, index);
        index
    }
}

fn ensure_row(matrix: &mut Vec<Vec<String>>, row_index: usize) -> &mut Vec<String> {
    while matrix.len() <= row_index {
        matrix.push(Vec::new());
    }
    &mut matrix[row_index]
}

fn write_row(matrix: &mut Vec<Vec<String>>, row_index: usize, values: &[String]) {
    let row = ensure_row(matrix, row_index);
    if row.len() < values.len() {
        row.resize(values.len(), String::new());
    }
    for (index, value) in values.iter().enumerate() {
        row[index] = value.clone();
    }
}

fn build_sheet_matrix(sheet: &EngineSheetOutput) -> SheetBuildResult {
    let mut matrix = Vec::new();
    let has_group_header = sheet.group_header_enabled
        && !sheet.group_header_label.trim().is_empty()
        && sheet.group_header_start_column_index < sheet.headers.len();
    let mut header_row_index = sheet.header_row_index.max(1);
    if sheet.title_enabled {
        header_row_index = header_row_index.max(2);
    }
    if has_group_header {
        header_row_index = header_row_index.max(if sheet.title_enabled { 3 } else { 2 });
    }
    let data_start_row_index = sheet.data_start_row_index.max(header_row_index + 1);
    let footer_rows = sheet.reserved_footer_rows;

    if sheet.title_enabled {
        write_row(&mut matrix, 0, &[sheet.title.clone()]);
    }

    let mut group_header_row_index = None;
    if has_group_header {
        let row_index = header_row_index - 2;
        group_header_row_index = Some(row_index);
        let mut group_header_row = vec![String::new(); sheet.headers.len()];
        for column_index in sheet.group_header_start_column_index..sheet.headers.len() {
            group_header_row[column_index] = sheet.group_header_label.clone();
        }
        write_row(&mut matrix, row_index, &group_header_row);
    }

    write_row(&mut matrix, header_row_index - 1, &sheet.headers);
    for (index, row_values) in sheet.rows.iter().enumerate() {
        write_row(&mut matrix, data_start_row_index - 1 + index, row_values);
    }

    let target_length = data_start_row_index - 1 + sheet.rows.len() + footer_rows;
    while matrix.len() < target_length {
        matrix.push(Vec::new());
    }

    SheetBuildResult {
        matrix,
        header_row_index: header_row_index - 1,
        group_header_row_index,
        data_start_row_index: data_start_row_index - 1,
        data_row_count: sheet.rows.len(),
    }
}

fn visual_length(value: &str) -> usize {
    value
        .chars()
        .map(|character| if character.is_ascii() { 1 } else { 2 })
        .sum()
}

fn infer_column_count(matrix: &[Vec<String>], header_count: usize) -> usize {
    matrix
        .iter()
        .map(|row| row.len())
        .max()
        .unwrap_or(header_count)
        .max(header_count)
}

fn estimate_column_width(value: &str) -> f64 {
    let longest = value
        .split('\n')
        .map(visual_length)
        .max()
        .unwrap_or(0)
        .max(8);
    (longest as f64 + 2.0).min(60.0)
}

fn normalize_hex_color(color: &str) -> String {
    let normalized = color.trim().trim_start_matches('#');
    if normalized.len() == 6 {
        normalized.to_uppercase()
    } else if normalized.len() == 3 {
        normalized
            .chars()
            .flat_map(|character| [character, character])
            .collect::<String>()
            .to_uppercase()
    } else {
        String::new()
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn column_name(mut index: usize) -> String {
    let mut name = String::new();
    loop {
        let remainder = index % 26;
        name.insert(0, (b'A' + remainder as u8) as char);
        if index < 26 {
            break;
        }
        index = (index / 26) - 1;
    }
    name
}

fn cell_reference(row: usize, column: usize) -> String {
    format!("{}{}", column_name(column), row + 1)
}

fn build_styles_xml(registry: &StyleRegistry) -> String {
    let mut fonts = vec![r#"<font><sz val="11"/><name val="Calibri"/></font>"#.to_string()];
    let mut fills = vec![
        r#"<fill><patternFill patternType="none"/></fill>"#.to_string(),
        r#"<fill><patternFill patternType="gray125"/></fill>"#.to_string(),
    ];
    let mut cell_xfs = vec![
        r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#.to_string(),
    ];

    for (index, style) in registry.styles.iter().enumerate() {
        let mut font = String::from("<font>");
        if style.bold {
            font.push_str("<b/>");
        }
        font.push_str(&format!(r#"<sz val="{}"/>"#, style.font_size.max(8)));
        if !style.text_color.is_empty() {
            font.push_str(&format!(
                r#"<color rgb="{}"/>"#,
                normalize_hex_color(&style.text_color)
            ));
        }
        font.push_str(r#"<name val="Calibri"/></font>"#);
        fonts.push(font);

        if style.background_color.is_empty() {
            fills.push(r#"<fill><patternFill patternType="none"/></fill>"#.to_string());
        } else {
            let color = normalize_hex_color(&style.background_color);
            fills.push(format!(
                r#"<fill><patternFill patternType="solid"><fgColor rgb="{color}"/><bgColor rgb="{color}"/></patternFill></fill>"#
            ));
        }

        let font_id = index + 1;
        let fill_id = index + 2;
        let horizontal = match style.horizontal_align.as_str() {
            "left" | "right" => style.horizontal_align.as_str(),
            _ => "center",
        };
        cell_xfs.push(format!(
            r#"<xf numFmtId="0" fontId="{font_id}" fillId="{fill_id}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="{horizontal}" vertical="center" wrapText="1"/></xf>"#
        ));
    }

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="{fonts_count}">{fonts}</fonts>
  <fills count="{fills_count}">{fills}</fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color auto="1"/></left>
      <right style="thin"><color auto="1"/></right>
      <top style="thin"><color auto="1"/></top>
      <bottom style="thin"><color auto="1"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="{cell_xfs_count}">{cell_xfs}</cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"#,
        fonts_count = fonts.len(),
        fonts = fonts.join(""),
        fills_count = fills.len(),
        fills = fills.join(""),
        cell_xfs_count = cell_xfs.len(),
        cell_xfs = cell_xfs.join("")
    )
}

fn build_sheet_xml(sheet: &EngineSheetOutput, registry: &StyleRegistry) -> String {
    let sheet_build = build_sheet_matrix(sheet);
    let column_count = infer_column_count(&sheet_build.matrix, sheet.headers.len());
    let mut column_widths = vec![8.0f64; column_count];
    for (row_index, row) in sheet_build.matrix.iter().enumerate() {
        if sheet.title_enabled && row_index == 0 {
            continue;
        }
        for column_index in 0..column_count {
            let value = row.get(column_index).cloned().unwrap_or_default();
            column_widths[column_index] = column_widths[column_index].max(estimate_column_width(&value));
        }
    }

    let title_style = registry
        .index_by_key
        .get(&StyleKey {
            bold: sheet.style_config.title.bold,
            font_size: sheet.style_config.title.font_size,
            text_color: sheet.style_config.title.text_color.clone(),
            background_color: sheet.style_config.title.background_color.clone(),
            horizontal_align: sheet.style_config.title.horizontal_align.clone(),
        })
        .copied()
        .unwrap_or(0);
    let header_style = registry
        .index_by_key
        .get(&StyleKey {
            bold: sheet.style_config.header.bold,
            font_size: sheet.style_config.header.font_size,
            text_color: sheet.style_config.header.text_color.clone(),
            background_color: sheet.style_config.header.background_color.clone(),
            horizontal_align: sheet.style_config.header.horizontal_align.clone(),
        })
        .copied()
        .unwrap_or(0);
    let data_style = registry
        .index_by_key
        .get(&StyleKey {
            bold: sheet.style_config.data.bold,
            font_size: sheet.style_config.data.font_size,
            text_color: sheet.style_config.data.text_color.clone(),
            background_color: sheet.style_config.data.background_color.clone(),
            horizontal_align: sheet.style_config.data.horizontal_align.clone(),
        })
        .copied()
        .unwrap_or(0);
    let total_style = registry
        .index_by_key
        .get(&StyleKey {
            bold: sheet.style_config.total_row.bold,
            font_size: sheet.style_config.total_row.font_size,
            text_color: sheet.style_config.total_row.text_color.clone(),
            background_color: sheet.style_config.total_row.background_color.clone(),
            horizontal_align: sheet.style_config.total_row.horizontal_align.clone(),
        })
        .copied()
        .unwrap_or(0);
    let total_row_index = if sheet.total_row_enabled && sheet_build.data_row_count > 0 {
        Some(sheet_build.data_start_row_index + sheet_build.data_row_count - 1)
    } else {
        None
    };

    let mut rows_xml = String::new();
    for (row_index, row) in sheet_build.matrix.iter().enumerate() {
        rows_xml.push_str(&format!(r#"<row r="{}">"#, row_index + 1));
        for column_index in 0..column_count {
            let value = row.get(column_index).cloned().unwrap_or_default();
            let style_index = if sheet.title_enabled && row_index == 0 {
                title_style
            } else if row_index == sheet_build.header_row_index
                || sheet_build.group_header_row_index == Some(row_index)
            {
                header_style
            } else if total_row_index == Some(row_index) {
                total_style
            } else {
                data_style
            };
            let cell_ref = cell_reference(row_index, column_index);
            rows_xml.push_str(&format!(
                r#"<c r="{cell_ref}" t="inlineStr" s="{style_index}"><is><t xml:space="preserve">{}</t></is></c>"#,
                xml_escape(&value)
            ));
        }
        rows_xml.push_str("</row>");
    }

    let cols_xml = column_widths
        .iter()
        .enumerate()
        .map(|(index, width)| {
            format!(
                r#"<col min="{idx}" max="{idx}" width="{width:.2}" customWidth="1"/>"#,
                idx = index + 1
            )
        })
        .collect::<Vec<_>>()
        .join("");

    let merge_xml = if sheet.title_enabled && !sheet.headers.is_empty() {
        format!(
            r#"<mergeCells count="1"><mergeCell ref="A1:{}1"/></mergeCells>"#,
            column_name(sheet.headers.len().saturating_sub(1))
        )
    } else {
        String::new()
    };
    let dimension_ref = format!(
        "A1:{}{}",
        column_name(column_count.saturating_sub(1)),
        sheet_build.matrix.len().max(1)
    );

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="{dimension_ref}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>{cols_xml}</cols>
  <sheetData>{rows_xml}</sheetData>
  {merge_xml}
</worksheet>"#
    )
}

fn build_workbook_binary(engine_output: &EngineOutput) -> Result<Vec<u8>, String> {
    if engine_output.sheets.is_empty() {
        return Err("处理结果为空：未生成任何输出 Sheet。".to_string());
    }
    let mut registry = StyleRegistry::new();
    for sheet in &engine_output.sheets {
        registry.register(&sheet.style_config.title);
        registry.register(&sheet.style_config.header);
        registry.register(&sheet.style_config.data);
        registry.register(&sheet.style_config.total_row);
    }

    let cursor = Cursor::new(Vec::<u8>::new());
    let mut zip = ZipWriter::new(cursor);
    let options: FileOptions<'_, ()> =
        FileOptions::default().compression_method(CompressionMethod::Deflated);

    let content_types = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  {}
</Types>"#,
        engine_output
            .sheets
            .iter()
            .enumerate()
            .map(|(index, _)| format!(r#"<Override PartName="/xl/worksheets/sheet{}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#, index + 1))
            .collect::<Vec<_>>()
            .join("")
    );
    write_zip_file(&mut zip, "[Content_Types].xml", &content_types, options)?;

    write_zip_file(
        &mut zip,
        "_rels/.rels",
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        options,
    )?;

    let workbook_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>{}</sheets>
</workbook>"#,
        engine_output
            .sheets
            .iter()
            .enumerate()
            .map(|(index, sheet)| {
                format!(
                    r#"<sheet name="{}" sheetId="{}" r:id="rId{}"/>"#,
                    xml_escape(&sheet.name),
                    index + 1,
                    index + 1
                )
            })
            .collect::<Vec<_>>()
            .join("")
    );
    write_zip_file(&mut zip, "xl/workbook.xml", &workbook_xml, options)?;

    let workbook_rels = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  {}
  <Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#,
        engine_output
            .sheets
            .iter()
            .enumerate()
            .map(|(index, _)| format!(r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{}.xml"/>"#, index + 1, index + 1))
            .collect::<Vec<_>>()
            .join(""),
        engine_output.sheets.len() + 1
    );
    write_zip_file(&mut zip, "xl/_rels/workbook.xml.rels", &workbook_rels, options)?;

    let styles_xml = build_styles_xml(&registry);
    write_zip_file(&mut zip, "xl/styles.xml", &styles_xml, options)?;

    for (index, sheet) in engine_output.sheets.iter().enumerate() {
        let sheet_xml = build_sheet_xml(sheet, &registry);
        write_zip_file(
            &mut zip,
            &format!("xl/worksheets/sheet{}.xml", index + 1),
            &sheet_xml,
            options,
        )?;
    }

    let cursor = zip.finish().map_err(|error| error.to_string())?;
    Ok(cursor.into_inner())
}

fn write_zip_file(
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
    path: &str,
    content: &str,
    options: FileOptions<'_, ()>,
) -> Result<(), String> {
    zip.start_file(path, options)
        .map_err(|error| error.to_string())?;
    zip.write_all(content.as_bytes())
        .map_err(|error| error.to_string())
}

fn sanitize_segment(value: &str) -> String {
    let sanitized = value
        .trim()
        .chars()
        .map(|character| {
            if matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                || character.is_control()
            {
                '_'
            } else if character.is_whitespace() {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "output".to_string()
    } else {
        sanitized
    }
}

fn strip_extension(file_name: &str) -> String {
    let normalized = file_name.trim();
    match normalized.rfind('.') {
        Some(index) if index > 0 => normalized[..index].to_string(),
        _ if normalized.is_empty() => "source".to_string(),
        _ => normalized.to_string(),
    }
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(stripped) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(stripped);
        }
    }
    PathBuf::from(path)
}

fn resolve_output_path(
    source_file_name: &str,
    rule_name: &str,
    preferred_directory: &str,
) -> Result<String, String> {
    let directory = if preferred_directory.trim().is_empty() {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join("Downloads")
        } else {
            std::env::current_dir().map_err(|error| error.to_string())?
        }
    } else {
        expand_home(preferred_directory)
    };
    let source_stem = sanitize_segment(&strip_extension(source_file_name));
    let normalized_rule_name = sanitize_segment(if rule_name.trim().is_empty() {
        "rule"
    } else {
        rule_name
    });
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs();
    Ok(directory
        .join(format!("{source_stem}-{normalized_rule_name}-{timestamp}.xlsx"))
        .to_string_lossy()
        .to_string())
}

fn write_binary_file(path: &str, bytes: &[u8]) -> Result<(), String> {
    let normalized_path = expand_home(path);
    if let Some(parent) = normalized_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
    }
    fs::write(normalized_path, bytes).map_err(|error| error.to_string())
}
