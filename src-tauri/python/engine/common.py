from collections import OrderedDict
from datetime import datetime
import re
from typing import Dict, List

SHEET_INVALID_CHAR_PATTERN = re.compile(r'[:\\/?*\[\]]')


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

