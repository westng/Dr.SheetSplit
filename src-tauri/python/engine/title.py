import re
from typing import Dict, List

from .common import as_text

TITLE_VARIABLE_PATTERN = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


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

