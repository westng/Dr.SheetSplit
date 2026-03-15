from collections import OrderedDict
from typing import Dict, List

from .common import (
    as_text,
    build_group_key,
    clamp_int,
    get_first_row,
    parse_exclude_values_text,
    sanitize_sheet_name,
    unique_sheet_name,
)
from .evaluator import evaluate_group_output, prune_conditional_empty_columns
from .mapping import build_mapping_indexes, resolve_headers
from .title import render_title


def run(payload: dict) -> dict:
    rule = payload.get("rule") or {}
    sheet = payload.get("sheet") or {}
    output_columns = rule.get("outputColumns") or []
    group_fields = rule.get("groupByFields") or []
    group_exclude_mode = as_text(rule.get("groupExcludeMode")) or "none"
    group_exclude_values_text = as_text(rule.get("groupExcludeValuesText"))
    group_exclude_mapping_section = as_text(rule.get("groupExcludeMappingSection"))
    summary_group_fields = [as_text(field) for field in (rule.get("summaryGroupByFields") or []) if as_text(field)]
    source_rows = sheet.get("rows") or []
    mapping_groups = payload.get("mappingGroups") or []
    unmatched_fallback = as_text(payload.get("unmatchedFallback")) or "未知错误"
    sheet_template = rule.get("sheetTemplate") or {}

    if not output_columns:
        raise ValueError("规则未配置输出字段。")
    group_field = as_text(group_fields[0]) if group_fields else ""

    output_headers = resolve_headers(output_columns)
    mapping_indexes = build_mapping_indexes(mapping_groups)
    excluded_group_values = set()
    if group_exclude_mode == "manual_values":
        excluded_group_values = set(parse_exclude_values_text(group_exclude_values_text))
    elif group_exclude_mode == "mapping_group_source" and group_exclude_mapping_section:
        excluded_group_values = set(mapping_indexes.get(group_exclude_mapping_section, {}).keys())

    grouped_rows: "OrderedDict[str, List[Dict[str, str]]]" = OrderedDict()
    for raw_row in source_rows:
        if not isinstance(raw_row, dict):
            continue
        normalized_row = {str(key): as_text(value) for key, value in raw_row.items()}
        if group_field:
            sheet_group_value = as_text(normalized_row.get(group_field))
            if sheet_group_value and sheet_group_value in excluded_group_values:
                continue
            sheet_group_key = sheet_group_value or "未命名分组"
        else:
            sheet_group_key = as_text(sheet.get("name")) or "默认输出"
        grouped_rows.setdefault(sheet_group_key, []).append(normalized_row)

    title_enabled = bool(sheet_template.get("titleEnabled"))
    title_template = as_text(sheet_template.get("titleTemplate"))
    header_row_index = clamp_int(sheet_template.get("headerRowIndex"), 1, 1)
    data_start_row_index = clamp_int(
        sheet_template.get("dataStartRowIndex"),
        header_row_index + 1,
        header_row_index + 1,
    )
    if title_enabled:
        header_row_index = max(2, header_row_index)
        data_start_row_index = max(data_start_row_index, header_row_index + 1)
    reserved_footer_rows = clamp_int(sheet_template.get("reservedFooterRows"), 0, 0)

    variable_configs: Dict[str, dict] = {}
    for config in sheet_template.get("variableConfigs", []):
        variable_key = as_text(config.get("variableKey"))
        if not variable_key:
            continue
        variable_configs[variable_key] = config

    sheets: List[dict] = []
    used_sheet_names = set()
    total_rows = 0

    for sheet_group_name, rows_in_sheet in grouped_rows.items():
        summary_groups: "OrderedDict[str, List[Dict[str, str]]]" = OrderedDict()
        if summary_group_fields:
            for row in rows_in_sheet:
                key = build_group_key(row, summary_group_fields)
                summary_groups.setdefault(key, []).append(row)
        else:
            for index, row in enumerate(rows_in_sheet):
                summary_groups[str(index)] = [row]

        output_rows: List[List[str]] = []
        row_payloads: List[dict] = []
        for rows_in_summary_group in summary_groups.values():
            values, output_by_field = evaluate_group_output(
                output_columns,
                rows_in_summary_group,
                mapping_indexes,
                unmatched_fallback,
            )
            output_rows.append(values)
            row_payloads.append(
                {
                    "source": get_first_row(rows_in_summary_group),
                    "output": output_by_field,
                    "values": values,
                }
            )

        sheet_headers, sheet_rows = prune_conditional_empty_columns(
            output_headers,
            output_rows,
            output_columns,
        )

        total_rows += len(sheet_rows)
        sheet_name = unique_sheet_name(sanitize_sheet_name(sheet_group_name), used_sheet_names)
        title = ""
        if title_enabled:
            title = render_title(title_template, row_payloads, variable_configs)

        sheets.append(
            {
                "name": sheet_name,
                "title": title,
                "titleEnabled": title_enabled,
                "headerRowIndex": header_row_index,
                "dataStartRowIndex": data_start_row_index,
                "reservedFooterRows": reserved_footer_rows,
                "headers": sheet_headers,
                "rows": sheet_rows,
            }
        )

    return {
        "ok": True,
        "sheetCount": len(sheets),
        "rowCount": total_rows,
        "sheets": sheets,
    }

