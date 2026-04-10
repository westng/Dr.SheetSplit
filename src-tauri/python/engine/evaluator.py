from typing import Dict, List, Tuple

from .common import (
    aggregate_values,
    as_text,
    format_datetime,
    format_number,
    get_first_row,
    parse_datetime,
    parse_number,
)
from .expression import evaluate_expression, normalize_expression_result
from .mapping import resolve_mapping_value, resolve_multi_mapping_value


def evaluate_group_output(
    output_columns: List[dict],
    rows: List[Dict[str, str]],
    mapping_indexes: Dict[str, Dict[str, str]],
    unmatched_fallback: str,
    dynamic_column_headers: Dict[str, List[str]] | None = None,
) -> Tuple[List[str], Dict[str, str]]:
    values: List[str] = []
    output_by_field: Dict[str, str] = {}
    dynamic_output_by_target: Dict[str, List[str]] = {}
    first_row = get_first_row(rows)
    dynamic_column_headers = dynamic_column_headers or {}

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

        if mode == "mapping_multi":
            source_fields = [
                as_text(field) for field in column.get("mappingSourceFields", []) if as_text(field)
            ]
            mapping_section = as_text(column.get("mappingSection"))
            if not source_fields:
                value = "未知错误填充"
                values.append(value)
                output_by_field[target_field] = value
                continue

            key_parts: List[str] = []
            for source_field in source_fields:
                source_value = as_text(first_row.get(source_field))
                if any(as_text(row.get(source_field)) != source_value for row in rows):
                    raise ValueError(
                        f"多条件映射字段“{source_field}”在同一分组内存在不一致值，无法映射。"
                    )
                key_parts.append(source_value)

            value = resolve_multi_mapping_value(
                key_parts,
                mapping_section,
                mapping_indexes,
                "未知错误填充",
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

        if mode == "bucket_sum":
            match_field = as_text(column.get("bucketMatchField"))
            value_field = as_text(column.get("bucketValueField"))
            match_value = as_text(column.get("bucketMatchValue")) or target_field
            if not match_field or not value_field:
                value = ""
                values.append(value)
                output_by_field[target_field] = value
                continue

            total = 0.0
            has_numeric = False
            for row in rows:
                if as_text(row.get(match_field)) != match_value:
                    continue
                raw_value = as_text(row.get(value_field))
                if not raw_value or raw_value == "-":
                    continue
                total += parse_number(raw_value, value_field)
                has_numeric = True

            value = format_number(total) if has_numeric else ""
            values.append(value)
            output_by_field[target_field] = value
            continue

        if mode == "dynamic_bucket_sum":
            match_field = as_text(column.get("bucketMatchField"))
            value_field = as_text(column.get("bucketValueField"))
            dynamic_headers = dynamic_column_headers.get(target_field, [])
            dynamic_output_by_target[target_field] = dynamic_headers
            for dynamic_header in dynamic_headers:
                total = 0.0
                has_numeric = False
                for row in rows:
                    if as_text(row.get(match_field)) != dynamic_header:
                        continue
                    raw_value = as_text(row.get(value_field))
                    if not raw_value or raw_value == "-":
                        continue
                    total += parse_number(raw_value, value_field)
                    has_numeric = True
                value = format_number(total) if has_numeric else ""
                values.append(value)
                output_by_field[dynamic_header] = value
            continue

        if mode == "output_sum" or mode == "output_avg":
            source_fields = [as_text(field) for field in column.get("outputSourceFields", []) if as_text(field)]
            total = 0.0
            has_numeric = False
            for source_target in source_fields:
                raw_value = as_text(output_by_field.get(source_target))
                if not raw_value:
                    continue
                total += parse_number(raw_value, source_target)
                has_numeric = True

            if not has_numeric:
                value = ""
            elif mode == "output_avg":
                divisor = len(source_fields)
                value = format_number(total / divisor) if divisor > 0 else ""
            else:
                value = format_number(total)

            values.append(value)
            output_by_field[target_field] = value
            continue

        if mode == "dynamic_output_sum" or mode == "dynamic_output_avg":
            reference_target = as_text(column.get("dynamicReferenceTargetField"))
            source_fields = dynamic_output_by_target.get(reference_target, [])
            total = 0.0
            has_numeric = False
            for source_target in source_fields:
                raw_value = as_text(output_by_field.get(source_target))
                if not raw_value:
                    continue
                total += parse_number(raw_value, source_target)
                has_numeric = True

            if not has_numeric:
                value = ""
            elif mode == "dynamic_output_avg":
                divisor = len(source_fields)
                value = format_number(total / divisor) if divisor > 0 else ""
            else:
                value = format_number(total)

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
                value = normalize_expression_result(
                    evaluate_expression(
                        expression_text,
                        rows,
                        first_row,
                        output_by_field,
                        unmatched_fallback,
                    )
                )
            values.append(value)
            output_by_field[target_field] = value
            continue

        source_field = as_text(column.get("sourceField"))
        value = as_text(first_row.get(source_field))
        values.append(value)
        output_by_field[target_field] = value

    return values, output_by_field


def prune_conditional_empty_columns(
    headers: List[str],
    output_rows: List[List[str]],
    output_columns: List[dict],
    row_is_filled: List[bool] | None = None,
) -> Tuple[List[str], List[List[str]]]:
    if not headers or not output_rows:
        return headers, output_rows

    row_indexes = list(range(len(output_rows)))
    if row_is_filled and len(row_is_filled) == len(output_rows):
        non_filled_indexes = [index for index, is_filled in enumerate(row_is_filled) if not is_filled]
        if non_filled_indexes:
            # Prefer real source rows when deciding whether to keep conditional split columns.
            row_indexes = non_filled_indexes

    drop_indices = set()
    cursor = 0
    for column in output_columns:
        mode = as_text(column.get("valueMode")) or "source"
        if mode == "conditional_target":
            hit_index = cursor
            miss_index = cursor + 1
            hit_has_value = any(
                as_text(output_rows[row_index][hit_index])
                if hit_index < len(output_rows[row_index])
                else ""
                for row_index in row_indexes
            )
            miss_has_value = any(
                as_text(output_rows[row_index][miss_index])
                if miss_index < len(output_rows[row_index])
                else ""
                for row_index in row_indexes
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
