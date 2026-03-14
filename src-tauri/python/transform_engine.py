#!/usr/bin/env python3
import ast
import json
import re
import sys
from collections import OrderedDict
from datetime import datetime
from typing import Any, Callable, Dict, List, Tuple

SHEET_INVALID_CHAR_PATTERN = re.compile(r'[:\\/?*\[\]]')
TITLE_VARIABLE_PATTERN = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


def as_text(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def clamp_int(value, fallback: int, minimum: int) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        normalized = fallback
    return max(minimum, normalized)


def parse_number(value, field_name: str) -> float:
    text = as_text(value).replace(",", "")
    if not text:
        raise ValueError(f"字段“{field_name}”为空，无法进行数值计算。")
    try:
        return float(text)
    except ValueError as error:
        raise ValueError(f"字段“{field_name}”值“{text}”不是合法数字。") from error


def format_number(value: float) -> str:
    if abs(value - round(value)) < 1e-9:
        return str(int(round(value)))
    text = f"{value:.6f}"
    return text.rstrip("0").rstrip(".")


def resolve_headers(output_columns: List[dict]) -> List[str]:
    headers: List[str] = []
    for index, column in enumerate(output_columns):
        mode = as_text(column.get("valueMode")) or "source"
        if mode == "conditional_target":
            hit_field = as_text(column.get("conditionalHitTargetField")) or f"Column_{index + 1}_hit"
            miss_field = as_text(column.get("conditionalMissTargetField")) or f"Column_{index + 1}_miss"
            headers.append(hit_field)
            headers.append(miss_field)
            continue

        target_field = as_text(column.get("targetField"))
        headers.append(target_field or f"Column_{index + 1}")
    return headers


def build_mapping_indexes(mapping_groups: List[dict]) -> Dict[str, Dict[str, str]]:
    result: Dict[str, Dict[str, str]] = {}
    for group in mapping_groups:
        group_id = as_text(group.get("id"))
        if not group_id:
            continue
        group_map: Dict[str, str] = {}
        for entry in group.get("entries", []):
            source = as_text(entry.get("source"))
            if not source:
                continue
            group_map[source] = as_text(entry.get("target"))
        result[group_id] = group_map
    return result


def resolve_mapping_value(
    source_value: str,
    mapping_id: str,
    mapping_indexes: Dict[str, Dict[str, str]],
    unmatched_fallback: str,
) -> str:
    if not source_value:
        return ""
    group_map = mapping_indexes.get(mapping_id, {})
    if source_value in group_map:
        return group_map[source_value]
    return unmatched_fallback


def get_first_row(rows: List[Dict[str, str]]) -> Dict[str, str]:
    if not rows:
        return {}
    return rows[0]


def aggregate_values(values: List[str], mode: str, field_name: str) -> str:
    normalized = [as_text(value) for value in values if as_text(value)]
    if not normalized:
        return ""

    if mode == "sum":
        total = 0.0
        for value in normalized:
            total += parse_number(value, field_name)
        return format_number(total)

    if mode == "join_newline":
        return "\n".join(normalized)

    return normalized[0]


def parse_datetime(value: str) -> datetime:
    normalized = as_text(value)
    if not normalized:
        raise ValueError("日期值为空。")

    candidates = [
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y.%m.%d",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M",
        "%Y%m%d",
    ]
    for pattern in candidates:
        try:
            return datetime.strptime(normalized, pattern)
        except ValueError:
            continue

    try:
        return datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"无法识别日期格式：{normalized}") from error


def format_datetime(value: datetime, pattern: str) -> str:
    replacements = OrderedDict(
        [
            ("YYYY", f"{value.year:04d}"),
            ("MM", f"{value.month:02d}"),
            ("M", f"{value.month}"),
            ("DD", f"{value.day:02d}"),
            ("D", f"{value.day}"),
            ("HH", f"{value.hour:02d}"),
            ("H", f"{value.hour}"),
            ("mm", f"{value.minute:02d}"),
            ("m", f"{value.minute}"),
            ("ss", f"{value.second:02d}"),
            ("s", f"{value.second}"),
        ]
    )

    result = pattern
    for key, replacement in replacements.items():
        result = result.replace(key, replacement)
    return result


def to_number(value: Any, field_name: str) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return parse_number(value, field_name)


def expression_values(rows: List[Dict[str, str]], field_name: str) -> List[str]:
    normalized_field = as_text(field_name)
    if not normalized_field:
        raise ValueError("表达式字段名不能为空。")
    return [as_text(row.get(normalized_field)) for row in rows if as_text(row.get(normalized_field))]


def evaluate_expression(
    expression_text: str,
    rows: List[Dict[str, str]],
    first_row: Dict[str, str],
) -> Any:
    normalized_expression = as_text(expression_text)
    if not normalized_expression:
        return ""

    def fn_sum(field_name: str) -> float:
        values = expression_values(rows, field_name)
        return sum(to_number(value, as_text(field_name)) for value in values) if values else 0.0

    def fn_avg(field_name: str) -> float:
        values = expression_values(rows, field_name)
        if not values:
            return 0.0
        return fn_sum(field_name) / len(values)

    def fn_first(field_name: str) -> str:
        normalized_field = as_text(field_name)
        if not normalized_field:
            raise ValueError("first() 缺少字段名。")
        return as_text(first_row.get(normalized_field))

    def fn_num(field_name: str) -> float:
        normalized_field = as_text(field_name)
        if not normalized_field:
            raise ValueError("num() 缺少字段名。")
        return to_number(first_row.get(normalized_field), normalized_field)

    def fn_join(field_name: str, delimiter: str = "\n") -> str:
        values = expression_values(rows, field_name)
        return as_text(delimiter).join(values)

    def fn_join_unique(field_name: str, delimiter: str = "\n") -> str:
        values = expression_values(rows, field_name)
        unique_values: List[str] = []
        seen = set()
        for value in values:
            if value in seen:
                continue
            seen.add(value)
            unique_values.append(value)
        return as_text(delimiter).join(unique_values)

    def fn_count(field_name: str = "") -> float:
        normalized_field = as_text(field_name)
        if not normalized_field:
            return float(len(rows))
        return float(len(expression_values(rows, normalized_field)))

    def fn_count_non_empty(field_name: str) -> float:
        return fn_count(field_name)

    functions: Dict[str, Callable[..., Any]] = {
        "sum": fn_sum,
        "avg": fn_avg,
        "first": fn_first,
        "num": fn_num,
        "join": fn_join,
        "join_unique": fn_join_unique,
        "count": fn_count,
        "count_non_empty": fn_count_non_empty,
    }

    def eval_node(node: ast.AST) -> Any:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (str, int, float, bool)) or node.value is None:
                return node.value
            raise ValueError("表达式包含不支持的常量类型。")

        if isinstance(node, ast.BinOp):
            left = eval_node(node.left)
            right = eval_node(node.right)
            if isinstance(node.op, ast.Add):
                if isinstance(left, str) or isinstance(right, str):
                    return f"{as_text(left)}{as_text(right)}"
                return to_number(left, "表达式") + to_number(right, "表达式")
            if isinstance(node.op, ast.Sub):
                return to_number(left, "表达式") - to_number(right, "表达式")
            if isinstance(node.op, ast.Mult):
                return to_number(left, "表达式") * to_number(right, "表达式")
            if isinstance(node.op, ast.Div):
                divisor = to_number(right, "表达式")
                if abs(divisor) < 1e-9:
                    raise ValueError("表达式执行除法时分母为 0。")
                return to_number(left, "表达式") / divisor
            raise ValueError("表达式仅支持 + - * / 运算。")

        if isinstance(node, ast.UnaryOp):
            operand = eval_node(node.operand)
            if isinstance(node.op, ast.USub):
                return -to_number(operand, "表达式")
            if isinstance(node.op, ast.UAdd):
                return to_number(operand, "表达式")
            raise ValueError("表达式仅支持一元 + 或 -。")

        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise ValueError("表达式函数调用格式无效。")
            function_name = node.func.id
            function = functions.get(function_name)
            if function is None:
                raise ValueError(f"表达式函数不受支持：{function_name}")
            if node.keywords:
                raise ValueError("表达式暂不支持关键字参数。")
            args = [eval_node(arg) for arg in node.args]
            return function(*args)

        raise ValueError("表达式包含不受支持的语法。")

    try:
        expression = ast.parse(normalized_expression, mode="eval")
    except SyntaxError as error:
        raise ValueError(f"表达式语法错误：{normalized_expression}") from error

    try:
        return eval_node(expression.body)
    except TypeError as error:
        raise ValueError(f"表达式参数错误：{normalized_expression}") from error


def evaluate_group_output(
    output_columns: List[dict],
    rows: List[Dict[str, str]],
    mapping_indexes: Dict[str, Dict[str, str]],
    unmatched_fallback: str,
) -> Tuple[List[str], Dict[str, str]]:
    values: List[str] = []
    output_by_field: Dict[str, str] = {}
    first_row = get_first_row(rows)

    for index, column in enumerate(output_columns):
        mode = as_text(column.get("valueMode")) or "source"
        target_field = as_text(column.get("targetField")) or f"Column_{index + 1}"

        if mode == "constant":
            value = as_text(column.get("constantValue"))
            values.append(value)
            output_by_field[target_field] = value
            continue

        if mode == "mapping":
            source_field = as_text(column.get("sourceField"))
            mapping_section = as_text(column.get("mappingSection"))
            source_value = as_text(first_row.get(source_field))
            value = resolve_mapping_value(
                source_value,
                mapping_section,
                mapping_indexes,
                unmatched_fallback,
            )
            values.append(value)
            output_by_field[target_field] = value
            continue

        if mode == "conditional_target":
            judge_field = as_text(column.get("conditionalJudgeField"))
            mapping_section = as_text(column.get("conditionalMappingSection"))
            value_source_field = as_text(column.get("conditionalValueSourceField"))
            aggregate_mode = as_text(column.get("conditionalAggregateMode")) or "first"
            hit_target = as_text(column.get("conditionalHitTargetField")) or f"Column_{index + 1}_hit"
            miss_target = as_text(column.get("conditionalMissTargetField")) or f"Column_{index + 1}_miss"
            mapping_group = mapping_indexes.get(mapping_section, {})
            mapped_targets = {as_text(value) for value in mapping_group.values() if as_text(value)}
            default_unmatched_to_hit = False
            if hit_target != miss_target:
                if hit_target in mapped_targets and miss_target not in mapped_targets:
                    default_unmatched_to_hit = False
                elif miss_target in mapped_targets and hit_target not in mapped_targets:
                    default_unmatched_to_hit = True

            hit_values: List[str] = []
            miss_values: List[str] = []
            for row in rows:
                judge_value = as_text(row.get(judge_field))
                source_value = as_text(row.get(value_source_field))
                if not source_value:
                    continue
                if judge_value and judge_value in mapping_group:
                    mapped_target = as_text(mapping_group.get(judge_value))
                    # Prefer mapped target-field match when mapping target is provided,
                    # then fall back to legacy behavior (hit on source matched).
                    if mapped_target:
                        if mapped_target == hit_target:
                            hit_values.append(source_value)
                            continue
                        if mapped_target == miss_target:
                            miss_values.append(source_value)
                            continue
                    hit_values.append(source_value)
                    continue

                if default_unmatched_to_hit:
                    hit_values.append(source_value)
                else:
                    miss_values.append(source_value)

            hit_value = aggregate_values(hit_values, aggregate_mode, value_source_field or hit_target)
            miss_value = aggregate_values(miss_values, aggregate_mode, value_source_field or miss_target)
            values.append(hit_value)
            values.append(miss_value)
            output_by_field[hit_target] = hit_value
            output_by_field[miss_target] = miss_value
            continue

        if mode == "aggregate_sum":
            source_field = as_text(column.get("aggregateSourceField"))
            if not source_field:
                value = ""
                values.append(value)
                output_by_field[target_field] = value
                continue
            total = 0.0
            for row in rows:
                total += parse_number(row.get(source_field), source_field)
            value = format_number(total)
            values.append(value)
            output_by_field[target_field] = value
            continue

        if mode == "aggregate_sum_divide":
            numerator_field = as_text(column.get("aggregateNumeratorField"))
            denominator_field = as_text(column.get("aggregateDenominatorField"))
            if not numerator_field or not denominator_field:
                value = ""
                values.append(value)
                output_by_field[target_field] = value
                continue
            total = 0.0
            for row in rows:
                numerator = parse_number(row.get(numerator_field), numerator_field)
                denominator = parse_number(row.get(denominator_field), denominator_field)
                if abs(denominator) < 1e-9:
                    raise ValueError(f"字段“{denominator_field}”存在 0 值，无法执行除法。")
                total += numerator / denominator
            value = format_number(total)
            values.append(value)
            output_by_field[target_field] = value
            continue

        if mode == "aggregate_join":
            source_field = as_text(column.get("aggregateJoinSourceField"))
            if not source_field:
                value = ""
                values.append(value)
                output_by_field[target_field] = value
                continue
            delimiter_mode = as_text(column.get("aggregateJoinDelimiter")) or "newline"
            delimiter = "\n" if delimiter_mode != "space" else " "
            joined_values = [as_text(row.get(source_field)) for row in rows if as_text(row.get(source_field))]
            value = delimiter.join(joined_values)
            values.append(value)
            output_by_field[target_field] = value
            continue

        if mode == "copy_output":
            source_target = as_text(column.get("copyFromTargetField"))
            value = as_text(output_by_field.get(source_target))
            values.append(value)
            output_by_field[target_field] = value
            continue

        if mode == "format_date":
            date_source_field = as_text(column.get("dateSourceField"))
            date_pattern = as_text(column.get("dateOutputFormat")) or "YYYY/M/D"
            if not date_source_field:
                value = ""
                values.append(value)
                output_by_field[target_field] = value
                continue
            raw_date = as_text(first_row.get(date_source_field))
            if not raw_date:
                value = ""
            else:
                value = format_datetime(parse_datetime(raw_date), date_pattern)
            values.append(value)
            output_by_field[target_field] = value
            continue

        if mode == "expression":
            expression_text = as_text(column.get("expressionText"))
            if not expression_text:
                value = ""
            else:
                evaluated = evaluate_expression(expression_text, rows, first_row)
                if evaluated is None:
                    value = ""
                elif isinstance(evaluated, bool):
                    value = "1" if evaluated else "0"
                elif isinstance(evaluated, (int, float)):
                    value = format_number(float(evaluated))
                else:
                    value = as_text(evaluated)
            values.append(value)
            output_by_field[target_field] = value
            continue

        source_field = as_text(column.get("sourceField"))
        value = as_text(first_row.get(source_field))
        values.append(value)
        output_by_field[target_field] = value

    return values, output_by_field


def resolve_title_value(values: List[str], config: dict, variable_key: str) -> str:
    mode = as_text(config.get("conflictMode")) or "first"
    placeholder = as_text(config.get("placeholderValue"))

    unique_values: List[str] = []
    seen = set()
    for value in values:
        normalized = as_text(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_values.append(normalized)

    if not unique_values:
        return ""
    if len(unique_values) == 1:
        return unique_values[0]

    if mode == "first":
        return unique_values[0]
    if mode == "last":
        return unique_values[-1]
    if mode == "join_unique":
        return " / ".join(unique_values)
    if mode == "placeholder":
        return placeholder
    if mode == "error":
        raise ValueError(f"标题变量“{variable_key}”存在多个值：{' / '.join(unique_values)}")

    return unique_values[0]


def render_title(
    title_template: str,
    row_payloads: List[dict],
    variable_configs: Dict[str, dict],
) -> str:
    if not title_template:
        return ""

    def replace(match: re.Match[str]) -> str:
        variable_key = as_text(match.group(1))
        if not variable_key:
            return ""

        values: List[str] = []
        for item in row_payloads:
            output_row = item.get("output", {})
            source_row = item.get("source", {})

            if variable_key in output_row:
                values.append(as_text(output_row.get(variable_key)))
            else:
                values.append(as_text(source_row.get(variable_key)))

        config = variable_configs.get(variable_key, {})
        return resolve_title_value(values, config, variable_key)

    return TITLE_VARIABLE_PATTERN.sub(replace, title_template).strip()


def sanitize_sheet_name(value: str) -> str:
    normalized = SHEET_INVALID_CHAR_PATTERN.sub("_", as_text(value))
    normalized = normalized.strip().strip("'")
    if not normalized:
        normalized = "未命名分组"
    return normalized[:31]


def unique_sheet_name(base_name: str, used_names: set) -> str:
    if base_name not in used_names:
        used_names.add(base_name)
        return base_name

    index = 2
    while True:
        suffix = f"_{index}"
        candidate = f"{base_name[:31 - len(suffix)]}{suffix}"
        if candidate not in used_names:
            used_names.add(candidate)
            return candidate
        index += 1


def build_group_key(row: Dict[str, str], fields: List[str]) -> str:
    if not fields:
        return "__single__"
    return "\u001f".join([as_text(row.get(field)) for field in fields])


def parse_exclude_values_text(value: str) -> List[str]:
    normalized = as_text(value)
    if not normalized:
        return []
    return [item.strip() for item in re.split(r"[\n\r,，\s]+", normalized) if item.strip()]


def prune_conditional_empty_columns(
    headers: List[str],
    output_rows: List[List[str]],
    output_columns: List[dict],
) -> Tuple[List[str], List[List[str]]]:
    if not headers or not output_rows:
        return headers, output_rows

    drop_indices = set()
    cursor = 0
    for column in output_columns:
        mode = as_text(column.get("valueMode")) or "source"
        if mode == "conditional_target":
            hit_index = cursor
            miss_index = cursor + 1
            hit_has_value = any(
                as_text(row[hit_index]) if hit_index < len(row) else ""
                for row in output_rows
            )
            miss_has_value = any(
                as_text(row[miss_index]) if miss_index < len(row) else ""
                for row in output_rows
            )

            if hit_has_value and not miss_has_value:
                drop_indices.add(miss_index)
            elif miss_has_value and not hit_has_value:
                drop_indices.add(hit_index)

            cursor += 2
            continue

        cursor += 1

    if not drop_indices:
        return headers, output_rows

    kept_indexes = [index for index in range(len(headers)) if index not in drop_indices]
    pruned_headers = [headers[index] for index in kept_indexes]
    pruned_rows: List[List[str]] = []
    for row in output_rows:
        pruned_rows.append(
            [as_text(row[index]) if index < len(row) else "" for index in kept_indexes]
        )
    return pruned_headers, pruned_rows


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


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            raise ValueError("处理引擎未收到输入数据。")
        payload = json.loads(raw)
        result = run(payload)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        sys.stderr.write(as_text(error) or "处理引擎执行失败。")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
