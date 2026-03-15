from typing import Dict, List

from .common import as_text


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

