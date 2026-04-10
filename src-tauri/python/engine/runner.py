from collections import OrderedDict
import re
from typing import Dict, List, Tuple

from .common import (
    as_text,
    build_group_key,
    clamp_int,
    format_number,
    get_first_row,
    parse_exclude_values_text,
    parse_number,
    sanitize_sheet_name,
    unique_sheet_name,
)
from .evaluator import evaluate_group_output, prune_conditional_empty_columns
from .mapping import (
    build_mapping_indexes,
    resolve_headers,
    resolve_mapping_value,
    resolve_multi_mapping_value,
)
from .title import render_title

DYNAMIC_DATE_HEADER_PATTERN = re.compile(r"^\d{8}$")


def resolve_bool(value, fallback: bool) -> bool:
    return value if isinstance(value, bool) else fallback


def split_composite_source_key(value: str) -> List[str]:
    normalized = as_text(value)
    if not normalized:
        return []
    return [as_text(part) for part in normalized.split("+")]


def resolve_unmatched_value(policy: str, unmatched_fallback: str, error_message: str) -> str:
    if policy == "error":
        raise ValueError(error_message)
    if policy == "empty":
        return ""
    return unmatched_fallback


def resolve_mapping_with_policy(
    source_value: str,
    mapping_section: str,
    mapping_indexes: Dict[str, Dict[str, str]],
    unmatched_fallback: str,
    fallback_policy: str,
    field_name: str,
) -> str:
    if not source_value:
        return ""
    marker = "__mapping_unmatched__"
    value = resolve_mapping_value(
        source_value,
        mapping_section,
        mapping_indexes,
        marker,
    )
    if value != marker:
        return value
    return resolve_unmatched_value(
        fallback_policy,
        unmatched_fallback,
        f"字段“{field_name}”映射未命中：{source_value}",
    )


def resolve_multi_mapping_with_policy(
    source_values: List[str],
    mapping_section: str,
    mapping_indexes: Dict[str, Dict[str, str]],
    unmatched_fallback: str,
    fallback_policy: str,
    field_name: str,
) -> str:
    if not any(as_text(item) for item in source_values):
        return ""
    marker = "__multi_mapping_unmatched__"
    value = resolve_multi_mapping_value(
        [as_text(item) for item in source_values],
        mapping_section,
        mapping_indexes,
        marker,
    )
    if value != marker:
        return value
    joined = "+".join([as_text(item) for item in source_values])
    return resolve_unmatched_value(
        fallback_policy,
        unmatched_fallback,
        f"字段“{field_name}”多条件映射未命中：{joined}",
    )


def append_total_row(
    sheet_headers: List[str],
    sheet_rows: List[List[str]],
    total_row_config: dict,
    dynamic_column_headers: Dict[str, List[str]] | None = None,
) -> List[List[str]]:
    if not sheet_headers:
        return sheet_rows

    total_row_enabled = resolve_bool(total_row_config.get("enabled"), False)
    if not total_row_enabled:
        return sheet_rows

    configured_sum_fields = [
        as_text(field) for field in (total_row_config.get("sumFields") or []) if as_text(field)
    ]
    label = as_text(total_row_config.get("label")) or "总计"
    label_field = as_text(total_row_config.get("labelField"))
    header_index_map = {header: index for index, header in enumerate(sheet_headers)}
    dynamic_column_headers = dynamic_column_headers or {}

    total_row = ["" for _ in sheet_headers]
    if label_field and label_field in header_index_map:
        total_row[header_index_map[label_field]] = label
    else:
        total_row[0] = label

    sum_fields: List[str] = []
    for field in configured_sum_fields:
        if field in header_index_map:
            sum_fields.append(field)
            continue
        expanded_headers = dynamic_column_headers.get(field, [])
        for expanded_header in expanded_headers:
            if expanded_header in header_index_map:
                sum_fields.append(expanded_header)
    sum_fields = list(dict.fromkeys(sum_fields))
    if not sum_fields:
        for index, header in enumerate(sheet_headers):
            if label_field and header == label_field:
                continue
            if not label_field and index == 0:
                continue

            has_number = False
            for row in sheet_rows:
                cell_value = as_text(row[index]) if index < len(row) else ""
                if not cell_value:
                    continue
                try:
                    parse_number(cell_value, header)
                    has_number = True
                    break
                except ValueError:
                    has_number = False
                    break
            if has_number:
                sum_fields.append(header)

    for field in sum_fields:
        column_index = header_index_map.get(field)
        if column_index is None:
            continue
        total = 0.0
        has_number = False
        for row in sheet_rows:
            cell_value = as_text(row[column_index]) if column_index < len(row) else ""
            if not cell_value:
                continue
            try:
                total += parse_number(cell_value, field)
                has_number = True
            except ValueError:
                # Total rows should be resilient to mixed text/numeric columns
                # such as mapped price fields that may still contain fallback text.
                continue
        if has_number:
            total_row[column_index] = format_number(total)

    return [*sheet_rows, total_row]


def resolve_dynamic_date_headers(sheet_headers: List[str]) -> List[str]:
    return [header for header in sheet_headers if DYNAMIC_DATE_HEADER_PATTERN.match(as_text(header))]


def resolve_dynamic_date_output_headers(
    source_headers: List[str],
    dynamic_date_config: dict,
) -> List[str]:
    output_mode = as_text(dynamic_date_config.get("outputMode")) or "replace"
    output_suffix = as_text(dynamic_date_config.get("outputSuffix")) or "_折算后"
    if output_mode == "append_suffix":
        return [f"{header}{output_suffix}" for header in source_headers]
    return list(source_headers)


def resolve_dynamic_date_factor(
    rows: List[Dict[str, str]],
    dynamic_date_config: dict,
    mapping_indexes: Dict[str, Dict[str, str]],
) -> float:
    factor_mode = as_text(dynamic_date_config.get("factorMode")) or "fixed"
    if factor_mode == "mapping":
        type_field = as_text(dynamic_date_config.get("typeField"))
        factor_mapping_section = as_text(dynamic_date_config.get("factorMappingSection"))
        if not type_field:
            raise ValueError("动态日期列缺少类型字段。")
        if not factor_mapping_section:
            raise ValueError("动态日期列缺少系数映射分组。")
        type_value = as_text(get_first_row(rows).get(type_field))
        if any(as_text(row.get(type_field)) != type_value for row in rows):
            raise ValueError(f"动态日期列类型字段“{type_field}”在同一分组内存在不一致值，无法匹配系数。")
        if not type_value:
            raise ValueError(f"动态日期列类型字段“{type_field}”为空，无法匹配系数。")
        marker = "__dynamic_date_factor_unmatched__"
        factor_value = resolve_mapping_value(
            type_value,
            factor_mapping_section,
            mapping_indexes,
            marker,
        )
        if factor_value == marker or not as_text(factor_value):
            raise ValueError(f"动态日期列系数映射未命中：{type_value}")
        return parse_number(factor_value, f"动态日期列系数({type_value})")

    fixed_factor = as_text(dynamic_date_config.get("fixedFactor")) or "1"
    return parse_number(fixed_factor, "动态日期列固定系数")


def evaluate_dynamic_date_output(
    rows: List[Dict[str, str]],
    dynamic_date_source_headers: List[str],
    dynamic_date_output_headers: List[str],
    dynamic_date_config: dict,
    mapping_indexes: Dict[str, Dict[str, str]],
) -> Tuple[List[str], Dict[str, str]]:
    if not dynamic_date_source_headers:
        return [], {}

    if not rows:
        return (["" for _ in dynamic_date_output_headers], {})

    factor = resolve_dynamic_date_factor(rows, dynamic_date_config, mapping_indexes)
    values: List[str] = []
    output_by_field: Dict[str, str] = {}
    for index, source_header in enumerate(dynamic_date_source_headers):
        target_header = dynamic_date_output_headers[index]
        total = 0.0
        has_numeric = False
        for row in rows:
            raw_value = as_text(row.get(source_header))
            if not raw_value or raw_value == "-":
                continue
            total += parse_number(raw_value, source_header)
            has_numeric = True
        value = format_number(total * factor) if has_numeric else ""
        values.append(value)
        output_by_field[target_header] = value

    return values, output_by_field


def infer_placeholder_source_values(
    output_columns: List[dict],
    fill_field_rules: Dict[str, dict],
    initial_values: Dict[str, str],
    mapping_indexes: Dict[str, Dict[str, str]],
    primary_field: str,
    source_defaults: Dict[str, Dict[str, str]],
) -> Dict[str, str]:
    source_values = dict(initial_values)

    for source_field, value_map in source_defaults.items():
        if as_text(source_values.get(source_field)):
            continue
        primary_value = as_text(source_values.get(primary_field))
        if not primary_value:
            continue
        default_value = as_text(value_map.get(primary_value))
        if default_value:
            source_values[source_field] = default_value

    mapping_multi_candidates: List[dict] = []
    for column in output_columns:
        if (as_text(column.get("valueMode")) or "source") == "mapping_multi":
            mapping_multi_candidates.append(column)
    for field_rule in fill_field_rules.values():
        if (as_text(field_rule.get("valueMode")) or "inherit") == "mapping_multi":
            mapping_multi_candidates.append(field_rule)

    for column in mapping_multi_candidates:
        mode = as_text(column.get("valueMode")) or "source"
        if mode != "mapping_multi":
            continue

        source_fields = [
            as_text(field) for field in column.get("mappingSourceFields", []) if as_text(field)
        ]
        mapping_section = as_text(column.get("mappingSection"))
        if not source_fields or not mapping_section:
            continue

        mapping_group = mapping_indexes.get(mapping_section, {})
        if not mapping_group:
            continue

        candidates: List[List[str]] = []
        for source_key in mapping_group.keys():
            parts = split_composite_source_key(source_key)
            if len(parts) != len(source_fields):
                continue
            matched = True
            for index, source_field in enumerate(source_fields):
                known_value = as_text(source_values.get(source_field))
                if known_value and known_value != parts[index]:
                    matched = False
                    break
            if matched:
                candidates.append(parts)

        if not candidates:
            continue

        for index, source_field in enumerate(source_fields):
            if as_text(source_values.get(source_field)):
                continue
            candidate_values = [
                as_text(parts[index]) for parts in candidates if as_text(parts[index])
            ]
            unique_values = list(dict.fromkeys(candidate_values))
            if len(unique_values) == 1:
                source_values[source_field] = unique_values[0]
                continue
            # Keep unresolved when multiple candidates exist so downstream mapping
            # falls back to configured unmatched marker instead of aborting whole task.

    return source_values


def build_placeholder_output_row(
    output_columns: List[dict],
    output_headers: List[str],
    summary_values: Dict[str, str],
    mapping_indexes: Dict[str, Dict[str, str]],
    unmatched_fallback: str,
    primary_field: str,
    source_defaults: Dict[str, Dict[str, str]],
    fill_field_rules: Dict[str, dict],
    fill_fallback_mode: str,
) -> Tuple[List[str], Dict[str, str], Dict[str, str]]:
    source_values = infer_placeholder_source_values(
        output_columns,
        fill_field_rules,
        summary_values,
        mapping_indexes,
        primary_field,
        source_defaults,
    )
    output_by_field: Dict[str, str] = {}

    for index, column in enumerate(output_columns):
        mode = as_text(column.get("valueMode")) or "source"
        if mode == "conditional_target":
            hit_target = as_text(column.get("conditionalHitTargetField")) or f"Column_{index + 1}_hit"
            miss_target = as_text(column.get("conditionalMissTargetField")) or f"Column_{index + 1}_miss"
            output_by_field[hit_target] = ""
            output_by_field[miss_target] = ""
            continue

        target_field = as_text(column.get("targetField")) or f"Column_{index + 1}"
        value = ""
        if mode == "source":
            source_field = as_text(column.get("sourceField"))
            value = as_text(source_values.get(source_field))
        elif mode == "constant":
            value = as_text(column.get("constantValue"))
        elif mode == "mapping":
            source_field = as_text(column.get("sourceField"))
            mapping_section = as_text(column.get("mappingSection"))
            source_value = as_text(source_values.get(source_field))
            value = resolve_mapping_with_policy(
                source_value,
                mapping_section,
                mapping_indexes,
                unmatched_fallback,
                fill_fallback_mode,
                target_field,
            )
        elif mode == "mapping_multi":
            source_fields = [
                as_text(field) for field in column.get("mappingSourceFields", []) if as_text(field)
            ]
            mapping_section = as_text(column.get("mappingSection"))
            if source_fields:
                key_parts = [as_text(source_values.get(source_field)) for source_field in source_fields]
                value = resolve_multi_mapping_with_policy(
                    key_parts,
                    mapping_section,
                    mapping_indexes,
                    unmatched_fallback,
                    fill_fallback_mode,
                    target_field,
                )
            else:
                value = resolve_unmatched_value(
                    fill_fallback_mode,
                    unmatched_fallback,
                    f"字段“{target_field}”缺少多条件映射来源字段。",
                )
        elif mode == "copy_output":
            source_target = as_text(column.get("copyFromTargetField"))
            value = as_text(output_by_field.get(source_target))

        output_by_field[target_field] = value

    for target_field, field_rule in fill_field_rules.items():
        if target_field not in output_by_field:
            continue

        mode = as_text(field_rule.get("valueMode")) or "inherit"
        if mode == "inherit":
            continue
        if mode == "empty":
            output_by_field[target_field] = ""
            continue
        if mode == "constant":
            output_by_field[target_field] = as_text(field_rule.get("constantValue"))
            continue
        if mode == "copy_output":
            source_target = as_text(field_rule.get("copyFromTargetField"))
            output_by_field[target_field] = as_text(output_by_field.get(source_target))
            continue
        if mode == "mapping":
            source_field = as_text(field_rule.get("sourceField"))
            mapping_section = as_text(field_rule.get("mappingSection"))
            source_value = as_text(source_values.get(source_field))
            output_by_field[target_field] = resolve_mapping_with_policy(
                source_value,
                mapping_section,
                mapping_indexes,
                unmatched_fallback,
                fill_fallback_mode,
                target_field,
            )
            continue
        if mode == "mapping_multi":
            source_fields = [
                as_text(field) for field in field_rule.get("mappingSourceFields", []) if as_text(field)
            ]
            mapping_section = as_text(field_rule.get("mappingSection"))
            if not source_fields:
                output_by_field[target_field] = resolve_unmatched_value(
                    fill_fallback_mode,
                    unmatched_fallback,
                    f"字段“{target_field}”缺少多条件映射来源字段。",
                )
                continue
            key_parts = [as_text(source_values.get(source_field)) for source_field in source_fields]
            output_by_field[target_field] = resolve_multi_mapping_with_policy(
                key_parts,
                mapping_section,
                mapping_indexes,
                unmatched_fallback,
                fill_fallback_mode,
                target_field,
            )

    values = [as_text(output_by_field.get(header)) for header in output_headers]
    return values, output_by_field, source_values


def normalize_source_rows(source_rows: List[dict]) -> List[Dict[str, str]]:
    normalized_rows: List[Dict[str, str]] = []
    for raw_row in source_rows:
        if not isinstance(raw_row, dict):
            continue
        normalized_rows.append({str(key): as_text(value) for key, value in raw_row.items()})
    return normalized_rows


def source_filter_matches(row: Dict[str, str], filter_config: dict) -> bool:
    field = as_text(filter_config.get("field"))
    if not field:
        return True

    operator = as_text(filter_config.get("operator")) or "contains_any"
    if operator != "contains_any":
        return True

    keywords = [as_text(item) for item in (filter_config.get("keywords") or []) if as_text(item)]
    if not keywords:
        return True

    field_value = as_text(row.get(field))
    return any(keyword in field_value for keyword in keywords)


def apply_source_filters(source_rows: List[Dict[str, str]], source_filters: List[dict]) -> List[Dict[str, str]]:
    if not source_filters:
        return source_rows

    filtered_rows: List[Dict[str, str]] = []
    for row in source_rows:
        matched = True
        for filter_config in source_filters:
            if not isinstance(filter_config, dict):
                continue
            if not source_filter_matches(row, filter_config):
                matched = False
                break
        if matched:
            filtered_rows.append(row)
    return filtered_rows


def resolve_dynamic_bucket_headers(output_columns: List[dict], source_rows: List[Dict[str, str]]) -> Dict[str, List[str]]:
    result: Dict[str, List[str]] = {}
    used_headers = set()
    static_headers = set(resolve_headers(output_columns))

    for index, column in enumerate(output_columns):
        mode = as_text(column.get("valueMode")) or "source"
        if mode != "dynamic_bucket_sum":
            continue

        target_field = as_text(column.get("targetField")) or f"Column_{index + 1}"
        match_field = as_text(column.get("bucketMatchField"))
        values = {as_text(row.get(match_field)) for row in source_rows if as_text(row.get(match_field))}
        dynamic_headers = sorted(values)

        for header in dynamic_headers:
            if header in static_headers:
                raise ValueError(f"动态列“{header}”与现有输出字段重名，无法生成。")
            if header in used_headers:
                raise ValueError(f"动态列“{header}”重复生成，无法输出。")
            used_headers.add(header)

        result[target_field] = dynamic_headers

    return result


def resolve_pivot_headers(rows: List[Dict[str, str]], pivot_config: dict) -> List[str]:
    whitelist = [as_text(item) for item in (pivot_config.get("columnWhitelist") or []) if as_text(item)]
    if whitelist:
        return whitelist

    column_field = as_text(pivot_config.get("columnField"))
    values = {as_text(row.get(column_field)) for row in rows if as_text(row.get(column_field))}
    return sorted(values)


def build_pivot_sheet_rows(
    rows_in_sheet: List[Dict[str, str]],
    row_group_fields: List[str],
    pivot_headers: List[str],
    pivot_config: dict,
) -> Tuple[List[List[str]], List[dict]]:
    column_field = as_text(pivot_config.get("columnField"))
    value_field = as_text(pivot_config.get("valueField"))
    include_total_column = resolve_bool(pivot_config.get("includeTotalColumn"), True)
    total_column_label = as_text(pivot_config.get("totalColumnLabel")) or "总计"
    include_average_column = resolve_bool(pivot_config.get("includeAverageColumn"), True)
    average_column_label = as_text(pivot_config.get("averageColumnLabel")) or "日均"
    static_value_columns = [
        as_text(item) for item in (pivot_config.get("staticValueColumns") or []) if as_text(item)
    ]

    grouped_entries: "OrderedDict[str, dict]" = OrderedDict()
    pivot_header_set = set(pivot_headers)
    for row in rows_in_sheet:
        group_key = build_group_key(row, row_group_fields)
        if group_key not in grouped_entries:
            grouped_entries[group_key] = {
                "source": row,
                "row_values": {field: as_text(row.get(field)) for field in row_group_fields},
                "pivot_values": {header: 0.0 for header in pivot_headers},
                "pivot_has_value": {header: False for header in pivot_headers},
            }

        column_value = as_text(row.get(column_field))
        if not column_value or column_value not in pivot_header_set:
            continue

        raw_value = as_text(row.get(value_field))
        if not raw_value or raw_value == "-":
            continue

        grouped_entries[group_key]["pivot_values"][column_value] += parse_number(raw_value, value_field)
        grouped_entries[group_key]["pivot_has_value"][column_value] = True

    output_rows: List[List[str]] = []
    row_payloads: List[dict] = []
    for entry in grouped_entries.values():
        output_by_field = dict(entry["row_values"])
        row_values = [as_text(entry["row_values"].get(field)) for field in row_group_fields]
        numeric_values: List[float] = []

        for header in pivot_headers:
            has_value = bool(entry["pivot_has_value"].get(header))
            value = format_number(entry["pivot_values"].get(header, 0.0)) if has_value else ""
            row_values.append(value)
            output_by_field[header] = value
            if has_value:
                numeric_values.append(entry["pivot_values"].get(header, 0.0))

        if include_total_column:
            total_value = format_number(sum(numeric_values)) if numeric_values else ""
            row_values.append(total_value)
            output_by_field[total_column_label] = total_value

        if include_average_column:
            divisor = len(pivot_headers)
            avg_value = format_number(sum(numeric_values) / divisor) if numeric_values and divisor > 0 else ""
            row_values.append(avg_value)
            output_by_field[average_column_label] = avg_value

        for header in static_value_columns:
            row_values.append("")
            output_by_field[header] = ""

        output_rows.append(row_values)
        row_payloads.append(
            {
                "source": entry["source"],
                "output": output_by_field,
                "values": row_values,
            }
        )

    return output_rows, row_payloads


def run_pivot(
    rule: dict,
    sheet: dict,
    source_rows: List[Dict[str, str]],
    total_row_config: dict,
) -> dict:
    pivot_config = rule.get("pivot") or {}
    sheet_group_field = as_text(pivot_config.get("sheetGroupField"))
    row_group_fields = [as_text(field) for field in (pivot_config.get("rowGroupFields") or []) if as_text(field)]
    if not sheet_group_field:
        raise ValueError("透视输出缺少 Sheet 分组字段。")
    if not row_group_fields:
        raise ValueError("透视输出至少需要一个行分组字段。")

    pivot_headers = resolve_pivot_headers(source_rows, pivot_config)
    include_total_column = resolve_bool(pivot_config.get("includeTotalColumn"), True)
    total_column_label = as_text(pivot_config.get("totalColumnLabel")) or "总计"
    include_average_column = resolve_bool(pivot_config.get("includeAverageColumn"), True)
    average_column_label = as_text(pivot_config.get("averageColumnLabel")) or "日均"
    static_value_columns = [
        as_text(item) for item in (pivot_config.get("staticValueColumns") or []) if as_text(item)
    ]
    output_headers = [*row_group_fields, *pivot_headers]
    if include_total_column:
        output_headers.append(total_column_label)
    if include_average_column:
        output_headers.append(average_column_label)
    output_headers.extend(static_value_columns)

    sheet_template = rule.get("sheetTemplate") or {}
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

    grouped_rows: "OrderedDict[str, List[Dict[str, str]]]" = OrderedDict()
    for row in source_rows:
        group_value = as_text(row.get(sheet_group_field)) or "未命名分组"
        grouped_rows.setdefault(group_value, []).append(row)

    sheets: List[dict] = []
    used_sheet_names = set()
    total_rows = 0
    for sheet_group_name, rows_in_sheet in grouped_rows.items():
        sheet_rows, row_payloads = build_pivot_sheet_rows(
            rows_in_sheet,
            row_group_fields,
            pivot_headers,
            pivot_config,
        )
        sheet_rows = append_total_row(output_headers, sheet_rows, total_row_config)
        total_rows += len(sheet_rows)
        title = render_title(title_template, row_payloads, variable_configs) if title_enabled else ""
        sheet_name = unique_sheet_name(sanitize_sheet_name(sheet_group_name), used_sheet_names)
        sheets.append(
            {
                "name": sheet_name,
                "title": title,
                "titleEnabled": title_enabled,
                "groupHeaderEnabled": False,
                "groupHeaderLabel": "",
                "groupHeaderStartColumnIndex": 0,
                "headerRowIndex": header_row_index,
                "dataStartRowIndex": data_start_row_index,
                "reservedFooterRows": reserved_footer_rows,
                "headers": output_headers,
                "rows": sheet_rows,
            }
        )

    return {
        "ok": True,
        "sheetCount": len(sheets),
        "rowCount": total_rows,
        "sheets": sheets,
    }


def run(payload: dict) -> dict:
    rule = payload.get("rule") or {}
    sheet = payload.get("sheet") or {}
    group_by_enabled = resolve_bool(rule.get("groupByEnabled"), False)
    output_columns = rule.get("outputColumns") or []
    group_fields = (rule.get("groupByFields") or []) if group_by_enabled else []
    group_exclude_mode = (as_text(rule.get("groupExcludeMode")) or "none") if group_by_enabled else "none"
    group_exclude_values_text = as_text(rule.get("groupExcludeValuesText")) if group_by_enabled else ""
    group_exclude_mapping_section = as_text(rule.get("groupExcludeMappingSection")) if group_by_enabled else ""
    summary_group_fields = (
        [as_text(field) for field in (rule.get("summaryGroupByFields") or []) if as_text(field)]
        if group_by_enabled
        else []
    )
    result_fill_config = rule.get("resultFill")
    if not isinstance(result_fill_config, dict):
        result_fill_config = {}
    legacy_fill_enabled = resolve_bool(rule.get("summaryFillMissingPrimary"), False)
    fill_missing_rows = (
        resolve_bool(result_fill_config.get("enabled"), False) or legacy_fill_enabled
        if group_by_enabled
        else False
    )
    fill_baseline_source_field = as_text(result_fill_config.get("baselineSourceField"))
    fill_baseline_mapping_section = as_text(result_fill_config.get("baselineMappingSection"))
    fill_fallback_mode = as_text(result_fill_config.get("fallbackMode")) or "unknown"
    if fill_fallback_mode not in {"unknown", "empty", "error"}:
        fill_fallback_mode = "unknown"
    fill_field_rules: Dict[str, dict] = {}
    for field_rule in result_fill_config.get("fieldRules") or []:
        if not isinstance(field_rule, dict):
            continue
        target_field = as_text(field_rule.get("targetField"))
        if not target_field:
            continue
        fill_field_rules[target_field] = field_rule
    source_rows = normalize_source_rows(sheet.get("rows") or [])
    source_headers = [as_text(header) for header in (sheet.get("headers") or []) if as_text(header)]
    mapping_groups = payload.get("mappingGroups") or []
    unmatched_fallback = as_text(payload.get("unmatchedFallback")) or "未知错误"
    sheet_template = rule.get("sheetTemplate") or {}
    dynamic_date_config = rule.get("dynamicDateColumns")
    if not isinstance(dynamic_date_config, dict):
        dynamic_date_config = {}
    total_row_config = rule.get("totalRow")
    if not isinstance(total_row_config, dict):
        total_row_config = {}
    source_filters = rule.get("sourceFilters") or []
    source_rows = apply_source_filters(source_rows, source_filters)
    dynamic_bucket_headers = resolve_dynamic_bucket_headers(output_columns, source_rows)

    if not output_columns:
        raise ValueError("规则未配置输出字段。")
    group_field = as_text(group_fields[0]) if group_fields else ""
    if fill_missing_rows and not fill_baseline_source_field:
        fill_baseline_source_field = as_text(summary_group_fields[0]) if summary_group_fields else ""

    mapping_indexes = build_mapping_indexes(mapping_groups)
    dynamic_date_enabled = resolve_bool(dynamic_date_config.get("enabled"), False)
    dynamic_date_source_headers = (
        resolve_dynamic_date_headers(source_headers) if dynamic_date_enabled else []
    )
    if dynamic_date_enabled and not dynamic_date_source_headers:
        raise ValueError("当前来源表头中未识别到日期列（需为 YYYYMMDD）。")
    dynamic_date_output_headers = resolve_dynamic_date_output_headers(
        dynamic_date_source_headers,
        dynamic_date_config,
    )
    group_header_label_text = as_text(rule.get("sourceGroupDisplayName")) or as_text(rule.get("sourceGroupName"))
    group_header_enabled = bool(dynamic_date_output_headers) and bool(group_header_label_text)
    group_header_label = group_header_label_text if group_header_enabled else ""
    static_output_headers = resolve_headers(output_columns, dynamic_bucket_headers)
    group_header_start_column_index = len(static_output_headers) if group_header_enabled else 0
    output_headers = [*static_output_headers, *dynamic_date_output_headers]
    excluded_group_values = set()
    if group_exclude_mode == "manual_values":
        excluded_group_values = set(parse_exclude_values_text(group_exclude_values_text))
    elif group_exclude_mode == "mapping_group_source" and group_exclude_mapping_section:
        excluded_group_values = set(mapping_indexes.get(group_exclude_mapping_section, {}).keys())

    grouped_rows: "OrderedDict[str, List[Dict[str, str]]]" = OrderedDict()
    fill_baseline_values: List[str] = []
    fill_baseline_seen = set()
    fill_source_defaults: Dict[str, Dict[str, str]] = {}
    fill_candidate_values: Dict[str, Dict[str, set]] = {}
    default_candidate_fields = set(summary_group_fields)
    for column in output_columns:
        mode = as_text(column.get("valueMode")) or "source"
        if mode in {"source", "mapping"}:
            source_field = as_text(column.get("sourceField"))
            if source_field:
                default_candidate_fields.add(source_field)
        elif mode == "mapping_multi":
            for source_field in column.get("mappingSourceFields", []):
                normalized = as_text(source_field)
                if normalized:
                    default_candidate_fields.add(normalized)
    for field_rule in fill_field_rules.values():
        mode = as_text(field_rule.get("valueMode")) or "inherit"
        if mode == "mapping":
            source_field = as_text(field_rule.get("sourceField"))
            if source_field:
                default_candidate_fields.add(source_field)
        elif mode == "mapping_multi":
            for source_field in field_rule.get("mappingSourceFields", []):
                normalized = as_text(source_field)
                if normalized:
                    default_candidate_fields.add(normalized)

    for normalized_row in source_rows:
        if group_field:
            sheet_group_value = as_text(normalized_row.get(group_field))
            if sheet_group_value and sheet_group_value in excluded_group_values:
                continue
            sheet_group_key = sheet_group_value or "未命名分组"
        else:
            sheet_group_key = as_text(sheet.get("name")) or "默认输出"
        grouped_rows.setdefault(sheet_group_key, []).append(normalized_row)

        if fill_missing_rows and fill_baseline_source_field:
            baseline_value = as_text(normalized_row.get(fill_baseline_source_field))
            if baseline_value and baseline_value not in fill_baseline_seen:
                fill_baseline_seen.add(baseline_value)
                fill_baseline_values.append(baseline_value)

            if baseline_value:
                for source_field in default_candidate_fields:
                    normalized_field = as_text(source_field)
                    if not normalized_field or normalized_field == fill_baseline_source_field:
                        continue
                    source_value = as_text(normalized_row.get(normalized_field))
                    if not source_value:
                        continue
                    field_candidates = fill_candidate_values.setdefault(normalized_field, {})
                    field_candidates.setdefault(baseline_value, set()).add(source_value)

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

    if fill_missing_rows and fill_baseline_mapping_section:
        baseline_mapping = mapping_indexes.get(fill_baseline_mapping_section, {})
        mapping_sources = [as_text(source) for source in baseline_mapping.keys() if as_text(source)]
        if mapping_sources:
            fill_baseline_values = list(dict.fromkeys(mapping_sources))

    for source_field, by_primary in fill_candidate_values.items():
        fill_source_defaults[source_field] = {}
        for primary_value, candidates in by_primary.items():
            if len(candidates) == 1:
                fill_source_defaults[source_field][primary_value] = next(iter(candidates))

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
        row_is_filled: List[bool] = []
        summary_entries: List[Tuple[List[Dict[str, str]], Dict[str, str]]] = []

        if fill_missing_rows and fill_baseline_source_field and fill_baseline_values:
            grouped_by_primary: "OrderedDict[str, List[List[Dict[str, str]]]]" = OrderedDict()
            remaining_groups: List[List[Dict[str, str]]] = []
            for rows_in_summary_group in summary_groups.values():
                primary_value = as_text(get_first_row(rows_in_summary_group).get(fill_baseline_source_field))
                if primary_value:
                    grouped_by_primary.setdefault(primary_value, []).append(rows_in_summary_group)
                    continue
                remaining_groups.append(rows_in_summary_group)

            for primary_value in fill_baseline_values:
                existing_groups = grouped_by_primary.pop(primary_value, [])
                if existing_groups:
                    for existing_group in existing_groups:
                        summary_entries.append((existing_group, {}))
                    continue
                summary_entries.append(([], {fill_baseline_source_field: primary_value}))

            for groups in grouped_by_primary.values():
                for rows_in_summary_group in groups:
                    summary_entries.append((rows_in_summary_group, {}))
            for rows_in_summary_group in remaining_groups:
                summary_entries.append((rows_in_summary_group, {}))
        else:
            for rows_in_summary_group in summary_groups.values():
                summary_entries.append((rows_in_summary_group, {}))

        for rows_in_summary_group, placeholder_summary_values in summary_entries:
            if rows_in_summary_group:
                static_values, output_by_field = evaluate_group_output(
                    output_columns,
                    rows_in_summary_group,
                    mapping_indexes,
                    unmatched_fallback,
                    dynamic_bucket_headers,
                )
                dynamic_values, dynamic_output_by_field = evaluate_dynamic_date_output(
                    rows_in_summary_group,
                    dynamic_date_source_headers,
                    dynamic_date_output_headers,
                    dynamic_date_config,
                    mapping_indexes,
                )
                values = [*static_values, *dynamic_values]
                output_by_field.update(dynamic_output_by_field)
                source_row = get_first_row(rows_in_summary_group)
                row_is_filled.append(False)
            else:
                static_values, output_by_field, source_row = build_placeholder_output_row(
                    output_columns,
                    resolve_headers(output_columns, dynamic_bucket_headers),
                    placeholder_summary_values,
                    mapping_indexes,
                    unmatched_fallback,
                    fill_baseline_source_field,
                    fill_source_defaults,
                    fill_field_rules,
                    fill_fallback_mode,
                )
                values = [*static_values, *(["" for _ in dynamic_date_output_headers])]
                row_is_filled.append(True)

            output_rows.append(values)
            row_payloads.append(
                {
                    "source": source_row,
                    "output": output_by_field,
                    "values": values,
                }
            )

        sheet_headers, sheet_rows = prune_conditional_empty_columns(
            output_headers,
            output_rows,
            output_columns,
            row_is_filled,
        )
        sheet_rows = append_total_row(sheet_headers, sheet_rows, total_row_config, dynamic_bucket_headers)

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
                "groupHeaderEnabled": group_header_enabled,
                "groupHeaderLabel": group_header_label,
                "groupHeaderStartColumnIndex": group_header_start_column_index,
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
