import type {
  RuleOutputColumn,
  RuleSheetTemplateVariableConfig,
  RuleSheetTitleConflictMode,
} from "../types/rule";

const TITLE_TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function extractTitleTemplateVariables(template: string): string[] {
  const variables = new Set<string>();
  let match: RegExpExecArray | null = TITLE_TEMPLATE_VARIABLE_PATTERN.exec(template);

  while (match) {
    const variableKey = match[1]?.trim();
    if (variableKey) {
      variables.add(variableKey);
    }
    match = TITLE_TEMPLATE_VARIABLE_PATTERN.exec(template);
  }

  TITLE_TEMPLATE_VARIABLE_PATTERN.lastIndex = 0;
  return Array.from(variables);
}

export function syncTemplateVariableConfigs(
  variableKeys: string[],
  currentConfigs: RuleSheetTemplateVariableConfig[],
): RuleSheetTemplateVariableConfig[] {
  const nextKeys = new Set(variableKeys);
  const currentMap = new Map(currentConfigs.map((config) => [config.variableKey, config]));

  return variableKeys.map((variableKey) => {
    const existing = currentMap.get(variableKey);
    if (existing) {
      return { ...existing };
    }
    return {
      variableKey,
      conflictMode: "first" as RuleSheetTitleConflictMode,
      placeholderValue: "",
    };
  }).filter((config) => nextKeys.has(config.variableKey));
}

export function collectAvailableTemplateVariableKeys(
  sourceHeaders: string[],
  outputColumns: RuleOutputColumn[],
): string[] {
  const orderedKeys = new Set<string>();

  sourceHeaders
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      orderedKeys.add(item);
    });

  outputColumns
    .forEach((column) => {
      if (column.valueMode === "conditional_target") {
        const hitTarget = column.conditionalHitTargetField.trim();
        const missTarget = column.conditionalMissTargetField.trim();
        if (hitTarget) {
          orderedKeys.add(hitTarget);
        }
        if (missTarget) {
          orderedKeys.add(missTarget);
        }
        return;
      }

      const targetField = column.targetField.trim();
      if (targetField) {
        orderedKeys.add(targetField);
      }
    });

  return Array.from(orderedKeys);
}

export function toExcelColumnLabel(index: number): string {
  if (index < 1) {
    return "A";
  }

  let current = index;
  let result = "";

  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }

  return result;
}
