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

const EXPRESSION_SOURCE_FIELD_FUNC_PATTERN =
  /\b(sum|avg|first|num|join|join_unique|count_non_empty)\s*\(\s*(['"])(.*?)\2/gi;
const EXPRESSION_OUTPUT_FUNC_PATTERN = /\boutput\s*\(\s*(['"])(.*?)\1/gi;
const DYNAMIC_DATE_HEADER_PATTERN = /^\d{8}$/;

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

  if (column.valueMode === "bucket_sum") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    if (!column.bucketMatchField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少匹配字段。`);
    }
    if (!column.bucketValueField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少取值字段。`);
    }
    return;
  }

  if (column.valueMode === "dynamic_bucket_sum") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少动态列标识。`);
    }
    if (!column.bucketMatchField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少动态列来源字段。`);
    }
    if (!column.bucketValueField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少动态列取值字段。`);
    }
    return;
  }

  if (column.valueMode === "output_sum" || column.valueMode === "output_avg") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    if (column.outputSourceFields.length === 0) {
      errors.push(`输出列第 ${rowNumber} 行至少选择一个产出来源字段。`);
    }
    return;
  }

  if (column.valueMode === "dynamic_output_sum" || column.valueMode === "dynamic_output_avg") {
    if (!column.targetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少目标字段名。`);
    }
    if (!column.dynamicReferenceTargetField.trim()) {
      errors.push(`输出列第 ${rowNumber} 行缺少动态列来源。`);
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
  EXPRESSION_SOURCE_FIELD_FUNC_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = EXPRESSION_SOURCE_FIELD_FUNC_PATTERN.exec(expressionText);
  while (match) {
    const field = String(match[3] ?? "").trim();
    if (field) {
      result.add(field);
    }
    match = EXPRESSION_SOURCE_FIELD_FUNC_PATTERN.exec(expressionText);
  }
  return Array.from(result);
}

function extractExpressionOutputRefs(expressionText: string): string[] {
  if (!expressionText.trim()) {
    return [];
  }
  const result = new Set<string>();
  EXPRESSION_OUTPUT_FUNC_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = EXPRESSION_OUTPUT_FUNC_PATTERN.exec(expressionText);
  while (match) {
    const field = String(match[2] ?? "").trim();
    if (field) {
      result.add(field);
    }
    match = EXPRESSION_OUTPUT_FUNC_PATTERN.exec(expressionText);
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

function validateDynamicDateColumns(rule: Readonly<RuleDefinition>, errors: string[]): void {
  const { dynamicDateColumns } = rule;
  if (!dynamicDateColumns.enabled) {
    return;
  }

  if (rule.sourceGroupHeaderRowIndex > 0 && !rule.sourceGroupName.trim()) {
    errors.push("启用动态日期列时，请先选择来源指标分组。");
    return;
  }

  const staticOutputFields = new Set(
    rule.outputColumns.flatMap((column) => getColumnTargetFields(column)),
  );
  const matchedDateHeaders = rule.sourceHeaders.filter((header) => DYNAMIC_DATE_HEADER_PATTERN.test(header.trim()));

  if (matchedDateHeaders.length === 0) {
    errors.push("当前来源表头中未识别到日期列（需为 YYYYMMDD）。");
    return;
  }

  if (dynamicDateColumns.factorMode === "mapping") {
    if (!dynamicDateColumns.typeField.trim()) {
      errors.push("动态日期列缺少类型字段。");
    }
    if (!dynamicDateColumns.factorMappingSection.trim()) {
      errors.push("动态日期列缺少系数映射分组。");
    }
  } else if (!dynamicDateColumns.fixedFactor.trim()) {
    errors.push("动态日期列缺少固定系数。");
  }

  if (dynamicDateColumns.outputMode === "append_suffix" && !dynamicDateColumns.outputSuffix.trim()) {
    errors.push("动态日期列追加新列时，输出后缀不能为空。");
  }

  const dynamicOutputHeaders = matchedDateHeaders.map((header) =>
    dynamicDateColumns.outputMode === "append_suffix"
      ? `${header}${dynamicDateColumns.outputSuffix}`
      : header,
  );
  for (const header of dynamicOutputHeaders) {
    if (staticOutputFields.has(header)) {
      errors.push(`动态日期列输出字段与静态输出字段重复：${header}`);
    }
  }
}

function validateSourceFilters(rule: Readonly<RuleDefinition>, errors: string[]): void {
  const seenIds = new Set<string>();
  rule.sourceFilters.forEach((filter, index) => {
    const rowNumber = index + 1;
    if (!filter.id.trim()) {
      errors.push(`源数据筛选第 ${rowNumber} 行缺少标识。`);
    } else if (seenIds.has(filter.id.trim())) {
      errors.push(`源数据筛选存在重复标识：${filter.id.trim()}`);
    } else {
      seenIds.add(filter.id.trim());
    }

    if (!filter.field.trim()) {
      errors.push(`源数据筛选第 ${rowNumber} 行缺少字段。`);
    }

    if (filter.operator === "contains_any" && filter.keywords.length === 0) {
      errors.push(`源数据筛选第 ${rowNumber} 行至少填写一个关键词。`);
    }
  });
}

function collectRequiredHeaders(rule: Readonly<RuleDefinition>): Set<string> {
  const requiredHeaders = new Set<string>();

  for (const filter of rule.sourceFilters) {
    const normalized = filter.field.trim();
    if (normalized) {
      requiredHeaders.add(normalized);
    }
  }

  if (rule.groupByEnabled) {
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
    if (column.valueMode === "bucket_sum") {
      if (column.bucketMatchField.trim()) {
        requiredHeaders.add(column.bucketMatchField.trim());
      }
      if (column.bucketValueField.trim()) {
        requiredHeaders.add(column.bucketValueField.trim());
      }
      continue;
    }
    if (column.valueMode === "dynamic_bucket_sum") {
      if (column.bucketMatchField.trim()) {
        requiredHeaders.add(column.bucketMatchField.trim());
      }
      if (column.bucketValueField.trim()) {
        requiredHeaders.add(column.bucketValueField.trim());
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

  if (rule.resultFill.enabled) {
    if (rule.resultFill.baselineSourceField.trim()) {
      requiredHeaders.add(rule.resultFill.baselineSourceField.trim());
    }

    for (const fieldRule of rule.resultFill.fieldRules) {
      if (fieldRule.valueMode === "mapping" && fieldRule.sourceField.trim()) {
        requiredHeaders.add(fieldRule.sourceField.trim());
      }
      if (fieldRule.valueMode === "mapping_multi") {
        for (const field of fieldRule.mappingSourceFields) {
          const normalized = field.trim();
          if (normalized) {
            requiredHeaders.add(normalized);
          }
        }
      }
    }
  }

  if (rule.dynamicDateColumns.enabled && rule.dynamicDateColumns.factorMode === "mapping") {
    const normalized = rule.dynamicDateColumns.typeField.trim();
    if (normalized) {
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
  if (rule.groupByEnabled && rule.groupByFields.length > 1) {
    errors.push("当前仅支持一个动态 Sheet 分组字段。");
  }
  const resultFillEnabled = rule.resultFill.enabled || rule.summaryFillMissingPrimary;
  if (!rule.groupByEnabled && resultFillEnabled) {
    errors.push("未启用动态 Sheet 分组时，不能启用结果补齐空行。");
  }
  if (rule.outputColumns.length === 0) {
    errors.push("请至少配置一个输出字段。");
  }
  validateSourceFilters(rule, errors);

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

  if (resultFillEnabled && summaryFieldSet.size === 0) {
    errors.push("开启结果补齐空行前，请先选择至少一个汇总分组字段。");
  }

  const outputFieldSet = new Set(
    rule.outputColumns.flatMap((column) => getColumnTargetFields(column)),
  );

  if (resultFillEnabled) {
    if (!rule.resultFill.baselineSourceField.trim()) {
      errors.push("结果补齐空行缺少基线字段。");
    }
    if (!rule.resultFill.baselineMappingSection.trim()) {
      errors.push("结果补齐空行缺少基线映射分组。");
    }

    const seenFillTargetFields = new Set<string>();
    for (const fieldRule of rule.resultFill.fieldRules) {
      const targetField = fieldRule.targetField.trim();
      if (!targetField) {
        continue;
      }
      if (seenFillTargetFields.has(targetField)) {
        errors.push(`结果补齐规则存在重复字段：${targetField}`);
        continue;
      }
      seenFillTargetFields.add(targetField);

      if (!outputFieldSet.has(targetField)) {
        errors.push(`结果补齐规则字段不存在于输出字段：${targetField}`);
      }

      if (fieldRule.valueMode === "mapping") {
        if (!fieldRule.sourceField.trim()) {
          errors.push(`结果补齐字段 ${targetField} 缺少映射来源字段。`);
        }
        if (!fieldRule.mappingSection.trim()) {
          errors.push(`结果补齐字段 ${targetField} 缺少映射分组。`);
        }
      }

      if (fieldRule.valueMode === "mapping_multi") {
        if (fieldRule.mappingSourceFields.length === 0) {
          errors.push(`结果补齐字段 ${targetField} 至少选择一个映射来源字段。`);
        }
        if (!fieldRule.mappingSection.trim()) {
          errors.push(`结果补齐字段 ${targetField} 缺少映射分组。`);
        }
      }

      if (fieldRule.valueMode === "copy_output" && !fieldRule.copyFromTargetField.trim()) {
        errors.push(`结果补齐字段 ${targetField} 缺少复制来源字段。`);
      }
    }
  }

  if (rule.totalRow.enabled) {
    const totalLabelField = rule.totalRow.labelField.trim();
    if (totalLabelField && !outputFieldSet.has(totalLabelField)) {
      errors.push(`总计行标签字段不存在于输出字段：${totalLabelField}`);
    }

    const totalRowSumFieldSet = new Set([
      ...outputFieldSet,
      ...rule.outputColumns
        .filter((column) => column.valueMode === "dynamic_bucket_sum")
        .map((column) => column.targetField.trim())
        .filter(Boolean),
    ]);
    const seenTotalSumFields = new Set<string>();
    for (const field of rule.totalRow.sumFields) {
      const normalized = field.trim();
      if (!normalized) {
        continue;
      }
      if (seenTotalSumFields.has(normalized)) {
        errors.push(`总计行求和字段重复：${normalized}`);
        continue;
      }
      seenTotalSumFields.add(normalized);
      if (!totalRowSumFieldSet.has(normalized)) {
        errors.push(`总计行求和字段不存在于输出字段：${normalized}`);
      }
    }
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

    if ((column.valueMode === "output_sum" || column.valueMode === "output_avg") && column.targetField.trim()) {
      if (column.outputSourceFields.includes(column.targetField.trim())) {
        errors.push(`输出列第 ${index + 1} 行产出来源字段不能包含自身目标字段。`);
      }
    }
    if ((column.valueMode === "dynamic_output_sum" || column.valueMode === "dynamic_output_avg") && column.targetField.trim()) {
      if (column.dynamicReferenceTargetField.trim() === column.targetField.trim()) {
        errors.push(`输出列第 ${index + 1} 行动态列来源不能等于自身目标字段。`);
      }
    }

    if (column.valueMode === "expression") {
      const selfTargets = new Set(getColumnTargetFields(column));
      const allOutputTargets = new Set(rule.outputColumns.flatMap((item) => getColumnTargetFields(item)));
      const previousOutputTargets = new Set(
        rule.outputColumns.slice(0, index).flatMap((item) => getColumnTargetFields(item)),
      );
      for (const field of extractExpressionOutputRefs(column.expressionText)) {
        if (selfTargets.has(field)) {
          errors.push(`输出列第 ${index + 1} 行表达式不能引用自身目标字段：${field}`);
          continue;
        }
        if (!allOutputTargets.has(field)) {
          errors.push(`输出列第 ${index + 1} 行表达式引用的产出字段不存在：${field}`);
          continue;
        }
        if (!previousOutputTargets.has(field)) {
          errors.push(`输出列第 ${index + 1} 行表达式引用字段必须排在当前行之前：${field}`);
        }
      }
    }
  });

  rule.outputColumns.forEach((column, index) => {
    hasColumnErrors(column, index, errors);
  });

  validateDynamicDateColumns(rule, errors);
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

  if (rule.resultFill.enabled && rule.resultFill.baselineMappingSection.trim()) {
    const entries = mappingGroupMap.get(rule.resultFill.baselineMappingSection.trim());
    const hasMappings = Array.isArray(entries) && entries.length > 0;
    if (!hasMappings) {
      errors.push(`结果补齐基线映射 ${rule.resultFill.baselineMappingSection} 为空或不存在。`);
    }
  }

  if (rule.groupByEnabled && rule.groupExcludeMode === "mapping_group_source" && rule.groupExcludeMappingSection.trim()) {
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

    if ((column.valueMode === "output_sum" || column.valueMode === "output_avg") && column.outputSourceFields.length > 0) {
      const outputFields = new Set(rule.outputColumns.flatMap((item) => getColumnTargetFields(item)));
      for (const sourceField of column.outputSourceFields) {
        if (!outputFields.has(sourceField.trim())) {
          errors.push(`字段 ${columnName} 的产出来源不存在：${sourceField}`);
        }
      }
    }

    if (column.valueMode === "dynamic_output_sum" || column.valueMode === "dynamic_output_avg") {
      const dynamicTargets = new Set(
        rule.outputColumns
          .filter((item) => item.valueMode === "dynamic_bucket_sum")
          .map((item) => item.targetField.trim())
          .filter(Boolean),
      );
      if (!dynamicTargets.has(column.dynamicReferenceTargetField.trim())) {
        errors.push(`字段 ${columnName} 的动态列来源不存在：${column.dynamicReferenceTargetField || "(未选择)"}`);
      }
    }

    if (column.valueMode === "expression") {
      const outputFields = new Set(rule.outputColumns.flatMap((item) => getColumnTargetFields(item)));
      for (const outputField of extractExpressionOutputRefs(column.expressionText)) {
        if (!outputFields.has(outputField.trim())) {
          errors.push(`字段 ${columnName} 的表达式引用产出字段不存在：${outputField}`);
        }
      }
    }
  }

  if (rule.resultFill.enabled) {
    const outputTargetSet = new Set(
      rule.outputColumns.flatMap((item) => getColumnTargetFields(item)),
    );

    for (const fieldRule of rule.resultFill.fieldRules) {
      const targetField = fieldRule.targetField.trim();
      if (!targetField || !outputTargetSet.has(targetField)) {
        continue;
      }

      if (fieldRule.valueMode === "mapping" || fieldRule.valueMode === "mapping_multi") {
        const entries = mappingGroupMap.get(fieldRule.mappingSection.trim());
        const hasMappings = Array.isArray(entries) && entries.length > 0;
        if (!hasMappings) {
          errors.push(`结果补齐字段 ${targetField} 的映射分组为空或不存在：${fieldRule.mappingSection || "(未选择)"}`);
        }
      }

      if (fieldRule.valueMode === "copy_output" && fieldRule.copyFromTargetField.trim()) {
        if (!outputTargetSet.has(fieldRule.copyFromTargetField.trim())) {
          errors.push(`结果补齐字段 ${targetField} 的复制来源不存在：${fieldRule.copyFromTargetField}`);
        }
      }
    }
  }

  if (rule.dynamicDateColumns.enabled && rule.dynamicDateColumns.factorMode === "mapping") {
    const entries = mappingGroupMap.get(rule.dynamicDateColumns.factorMappingSection.trim());
    const hasMappings = Array.isArray(entries) && entries.length > 0;
    if (!hasMappings) {
      errors.push(`动态日期列系数映射为空或不存在：${rule.dynamicDateColumns.factorMappingSection || "(未选择)"}`);
    }
  }

  return {
    isCompatible: errors.length === 0,
    errors,
  };
}
