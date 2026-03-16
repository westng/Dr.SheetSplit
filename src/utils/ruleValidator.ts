import type { RuleDefinition, RuleOutputColumn } from "../types/rule";
import { collectAvailableTemplateVariableKeys, extractTitleTemplateVariables } from "./ruleTemplate";

type MappingDataLike = readonly {
  id: string;
  entries: readonly { source: string; target: string }[];
}[];

export type RuleDraftValidationResult = {
  isValid: boolean;
  errors: string[];
};

export type RuleCompatibilityResult = {
  isCompatible: boolean;
  errors: string[];
};

const EXPRESSION_FIELD_FUNC_PATTERN = /\b(sum|avg|first|num|join|join_unique|count_non_empty)\s*\(\s*(['"])(.*?)\2/gi;

function getColumnTargetFields(column: RuleOutputColumn): string[] {
  if (column.valueMode === "conditional_target") {
    return [column.conditionalHitTargetField.trim(), column.conditionalMissTargetField.trim()].filter(Boolean);
  }
  return [column.targetField.trim()].filter(Boolean);
}

function getColumnDisplayName(column: RuleOutputColumn, fallbackIndex: number): string {
  const targets = getColumnTargetFields(column);
  return targets.join("/") || `第 ${fallbackIndex + 1} 行`;
}

function hasColumnErrors(column: RuleOutputColumn, index: number, errors: string[]): void {
  const rowNumber = index + 1;

  if (column.valueMode === "source") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    return;
  }

  if (column.valueMode === "constant") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    return;
  }

  if (column.valueMode === "mapping") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    return;
  }

  if (column.valueMode === "mapping_multi") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    if (column.mappingSourceFields.length === 0) {
      errors.push(`输出列第 ${rowNumber} 行至少选择一个映射来源字段。`);
    }
    return;
  }

  if (column.valueMode === "conditional_target") {
    if (!column.conditionalHitTargetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少命中目标字段。`);
    }
    if (!column.conditionalMissTargetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少未命中目标字段。`);
    }
    if (
      column.conditionalHitTargetField.trim() &&
      column.conditionalMissTargetField.trim() &&
      column.conditionalHitTargetField.trim() === column.conditionalMissTargetField.trim()
    ) {
      errors.push(`输出列第 ${rowNumber} 行命中与未命中目标字段不能相同。`);
    }
    return;
  }

  if (column.valueMode === "aggregate_sum") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    return;
  }

  if (column.valueMode === "aggregate_sum_divide") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    return;
  }

  if (column.valueMode === "aggregate_join") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    return;
  }

  if (column.valueMode === "copy_output") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    return;
  }

  if (column.valueMode === "expression") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    if (!column.expressionText.trim()) {
      errors.push(`输出列第 ${rowNumber} 行表达式不能为空。`);
    }
    return;
  }

  if (!column.targetField.trim()) {
    errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
  }
}

function extractExpressionFieldRefs(expressionText: string): string[] {
  if (!expressionText.trim()) {
    return [];
  }
  const result = new Set<string>();
  EXPRESSION_FIELD_FUNC_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = EXPRESSION_FIELD_FUNC_PATTERN.exec(expressionText);
  while (match) {
    const field = String(match[3] ?? "").trim();
    if (field) {
      result.add(field);
    }
    match = EXPRESSION_FIELD_FUNC_PATTERN.exec(expressionText);
  }
  return Array.from(result);
}

function validateSheetTemplate(rule: Readonly<RuleDefinition>, errors: string[]): void {
  const { sheetTemplate } = rule;
  const availableVariables = new Set(
    collectAvailableTemplateVariableKeys(rule.sourceHeaders, rule.outputColumns),
  );
  const usedVariables = extractTitleTemplateVariables(sheetTemplate.titleTemplate);

  if (!sheetTemplate.titleEnabled) {
    if (sheetTemplate.headerRowIndex < 1) {
      errors.push("表头行号至少为 1。");
    }
    if (sheetTemplate.dataStartRowIndex <= sheetTemplate.headerRowIndex) {
      errors.push("数据起始行必须大于表头行号。");
    }
    return;
  }

  if (!sheetTemplate.titleTemplate.trim()) {
    errors.push("启用 Sheet 标题行后，标题模板不能为空。");
  }

  if (sheetTemplate.headerRowIndex <= 1) {
    errors.push("启用 Sheet 标题行后，表头行号必须大于 1。");
  }

  if (sheetTemplate.dataStartRowIndex <= sheetTemplate.headerRowIndex) {
    errors.push("数据起始行必须大于表头行号。");
  }

  usedVariables.forEach((variableKey) => {
    if (!availableVariables.has(variableKey)) {
      errors.push(`Sheet 标题模板使用了未定义变量：${variableKey}`);
    }
  });

  const configuredVariables = new Set(
    sheetTemplate.variableConfigs.map((config) => config.variableKey.trim()).filter(Boolean),
  );
  usedVariables.forEach((variableKey) => {
    if (!configuredVariables.has(variableKey)) {
      errors.push(`Sheet 标题变量缺少冲突处理配置：${variableKey}`);
    }
  });
}

function collectRequiredHeaders(rule: Readonly<RuleDefinition>): Set<string> {
  const requiredHeaders = new Set<string>();

  for (const field of rule.groupByFields) {
    const normalized = field.trim();
    if (normalized) {
      requiredHeaders.add(normalized);
    }
  }
  for (const field of rule.summaryGroupByFields) {
    const normalized = field.trim();
    if (normalized) {
      requiredHeaders.add(normalized);
    }
  }

  for (const column of rule.outputColumns) {
    if (column.valueMode === "source" || column.valueMode === "mapping") {
      if (column.sourceField.trim()) {
        requiredHeaders.add(column.sourceField.trim());
      }
      continue;
    }
    if (column.valueMode === "mapping_multi") {
      for (const field of column.mappingSourceFields) {
        const normalized = field.trim();
        if (normalized) {
          requiredHeaders.add(normalized);
        }
      }
      continue;
    }
    if (column.valueMode === "conditional_target") {
      if (column.conditionalJudgeField.trim()) {
        requiredHeaders.add(column.conditionalJudgeField.trim());
      }
      if (column.conditionalValueSourceField.trim()) {
        requiredHeaders.add(column.conditionalValueSourceField.trim());
      }
      continue;
    }
    if (column.valueMode === "aggregate_sum") {
      if (column.aggregateSourceField.trim()) {
        requiredHeaders.add(column.aggregateSourceField.trim());
      }
      continue;
    }
    if (column.valueMode === "aggregate_sum_divide") {
      if (column.aggregateNumeratorField.trim()) {
        requiredHeaders.add(column.aggregateNumeratorField.trim());
      }
      if (column.aggregateDenominatorField.trim()) {
        requiredHeaders.add(column.aggregateDenominatorField.trim());
      }
      continue;
    }
    if (column.valueMode === "aggregate_join") {
      if (column.aggregateJoinSourceField.trim()) {
        requiredHeaders.add(column.aggregateJoinSourceField.trim());
      }
      continue;
    }
    if (column.valueMode === "format_date" && column.dateSourceField.trim()) {
      requiredHeaders.add(column.dateSourceField.trim());
    }
    if (column.valueMode === "expression") {
      for (const field of extractExpressionFieldRefs(column.expressionText)) {
        requiredHeaders.add(field);
      }
    }
  }

  const templateVariables = extractTitleTemplateVariables(rule.sheetTemplate.titleTemplate);
  const outputFieldSet = new Set(
    rule.outputColumns.flatMap((column) => getColumnTargetFields(column)),
  );
  for (const variableKey of templateVariables) {
    const normalized = variableKey.trim();
    if (normalized && !outputFieldSet.has(normalized)) {
      requiredHeaders.add(normalized);
    }
  }

  return requiredHeaders;
}

export function validateRuleDraft(rule: Readonly<RuleDefinition>): RuleDraftValidationResult {
  const errors: string[] = [];

  if (!rule.name.trim()) {
    errors.push("规则名称不能为空。");
  }
  if (!rule.sourceSheetName.trim()) {
    errors.push("请先选择来源工作表。");
  }
  if (rule.sourceHeaders.length === 0) {
    errors.push("请先上传并解析来源表头。");
  }
  if (rule.groupByFields.length > 1) {
    errors.push("当前仅支持一个动态 Sheet 分组字段。");
  }
  if (rule.outputColumns.length === 0) {
    errors.push("请至少配置一个输出字段。");
  }

  const summaryFieldSet = new Set<string>();
  for (const field of rule.summaryGroupByFields) {
    const normalized = field.trim();
    if (!normalized) {
      continue;
    }
    if (summaryFieldSet.has(normalized)) {
      errors.push(`汇总分组字段重复：${normalized}`);
      continue;
    }
    summaryFieldSet.add(normalized);
  }

  const targetFieldSet = new Set<string>();
  rule.outputColumns.forEach((column, index) => {
    for (const targetField of getColumnTargetFields(column)) {
      if (targetFieldSet.has(targetField)) {
        errors.push(`输出字段存在重复目标字段名：${targetField}`);
      } else {
        targetFieldSet.add(targetField);
      }
    }

    if (column.valueMode === "copy_output" && column.copyFromTargetField.trim()) {
      const columnTargets = getColumnTargetFields(column);
      if (columnTargets.includes(column.copyFromTargetField.trim())) {
        errors.push(`输出列第 ${index + 1} 行复制来源字段不能等于自身目标字段。`);
      }
    }
  });

  rule.outputColumns.forEach((column, index) => {
    hasColumnErrors(column, index, errors);
  });

  validateSheetTemplate(rule, errors);

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validateRuleCompatibility(
  rule: Readonly<RuleDefinition>,
  headers: string[],
  mappingData: MappingDataLike,
): RuleCompatibilityResult {
  const headerSet = new Set(headers.map((item) => item.trim()).filter(Boolean));
  const errors: string[] = [];

  for (const requiredHeader of collectRequiredHeaders(rule)) {
    if (!headerSet.has(requiredHeader)) {
      errors.push(`缺少必需字段：${requiredHeader}`);
    }
  }

  const availableVariables = new Set(
    collectAvailableTemplateVariableKeys(headers, rule.outputColumns),
  );
  const templateVariables = extractTitleTemplateVariables(rule.sheetTemplate.titleTemplate);
  for (const variableKey of templateVariables) {
    if (!availableVariables.has(variableKey)) {
      errors.push(`Sheet 标题模板变量不可用：${variableKey}`);
    }
  }

  const mappingGroupMap = new Map(
    mappingData.map((group) => [group.id, group.entries] as const),
  );

  if (rule.groupExcludeMode === "mapping_group_source" && rule.groupExcludeMappingSection.trim()) {
    const entries = mappingGroupMap.get(rule.groupExcludeMappingSection.trim());
    const hasMappings = Array.isArray(entries) && entries.length > 0;
    if (!hasMappings) {
      errors.push(`动态分组排除映射 ${rule.groupExcludeMappingSection} 为空或不存在。`);
    }
  }

  for (let index = 0; index < rule.outputColumns.length; index += 1) {
    const column = rule.outputColumns[index];
    const columnName = getColumnDisplayName(column, index);

    if (column.valueMode === "mapping") {
      if (!column.mappingSection.trim()) {
        continue;
      }
      const entries = mappingGroupMap.get(column.mappingSection);
      const hasMappings = Array.isArray(entries) && entries.length > 0;
      if (!hasMappings) {
        errors.push(`映射分组 ${column.mappingSection || "(未选择)"} 为空，无法用于字段 ${columnName}`);
      }
      continue;
    }

    if (column.valueMode === "mapping_multi") {
      if (!column.mappingSection.trim()) {
        continue;
      }
      const entries = mappingGroupMap.get(column.mappingSection);
      const hasMappings = Array.isArray(entries) && entries.length > 0;
      if (!hasMappings) {
        errors.push(`映射分组 ${column.mappingSection || "(未选择)"} 为空，无法用于字段 ${columnName}`);
      }
      continue;
    }

    if (column.valueMode === "conditional_target") {
      if (!column.conditionalMappingSection.trim()) {
        continue;
      }
      const entries = mappingGroupMap.get(column.conditionalMappingSection);
      const hasMappings = Array.isArray(entries) && entries.length > 0;
      if (!hasMappings) {
        errors.push(
          `条件映射分组 ${column.conditionalMappingSection || "(未选择)"} 为空，无法用于字段 ${columnName}`,
        );
      }
      continue;
    }

    if (column.valueMode === "copy_output" && column.copyFromTargetField.trim()) {
      const hasOutputField = rule.outputColumns
        .flatMap((item) => getColumnTargetFields(item))
        .includes(column.copyFromTargetField.trim());
      if (!hasOutputField) {
        errors.push(`字段 ${columnName} 复制来源不存在：${column.copyFromTargetField}`);
      }
    }
  }

  return {
    isCompatible: errors.length === 0,
    errors,
  };
}
