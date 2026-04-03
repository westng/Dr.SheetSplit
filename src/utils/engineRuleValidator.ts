import { i18n } from "../i18n";
import type { EngineRuleDefinition } from "../types/engineRule";
import { extractTitleTemplateVariables } from "./ruleTemplate";

export type EngineRuleValidationResult = {
  isValid: boolean;
  errors: string[];
};

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

export function validateEngineRuleDraft(rule: EngineRuleDefinition): EngineRuleValidationResult {
  const errors: string[] = [];
  const t = i18n.global.t;

  if (!hasText(rule.name)) {
    errors.push(t("engineRules.validation.ruleNameRequired"));
  }

  if (rule.ruleType === "single_table" && rule.sources.length !== 1) {
    errors.push(t("engineRules.validation.singleTableSourceLimit"));
  }

  if (rule.sources.length === 0) {
    errors.push(t("engineRules.validation.sourceRequired"));
  }

  rule.sources.forEach((source, index) => {
    const row = index + 1;
    if (!hasText(source.sourceFileName)) {
      errors.push(t("engineRules.validation.sourceFileRequired", { row }));
    }
    if (!hasText(source.sourceSheetName)) {
      errors.push(t("engineRules.validation.sourceSheetRequired", { row }));
    }
    if (source.sourceHeaderRowIndex < 1) {
      errors.push(t("engineRules.validation.sourceHeaderRowInvalid", { row }));
    }
    if (source.sourceGroupHeaderRowIndex < 0) {
      errors.push(t("engineRules.validation.sourceGroupHeaderRowInvalid", { row }));
    }
    if (
      source.sourceGroupHeaderRowIndex > 0 &&
      source.sourceGroupHeaderRowIndex === source.sourceHeaderRowIndex
    ) {
      errors.push(t("engineRules.validation.sourceHeaderRowConflict", { row }));
    }
  });

  const configuredRelations = rule.relations.filter(
    (relation) =>
      hasText(relation.leftSourceId) ||
      hasText(relation.rightSourceId) ||
      hasText(relation.leftField) ||
      hasText(relation.rightField),
  );
  configuredRelations.forEach((relation, index) => {
    const row = index + 1;
    if (!hasText(relation.leftSourceId)) {
      errors.push(t("engineRules.validation.relationLeftSourceRequired", { row }));
    }
    if (!hasText(relation.rightSourceId)) {
      errors.push(t("engineRules.validation.relationRightSourceRequired", { row }));
    }
    if (!hasText(relation.leftField)) {
      errors.push(t("engineRules.validation.relationLeftFieldRequired", { row }));
    }
    if (!hasText(relation.rightField)) {
      errors.push(t("engineRules.validation.relationRightFieldRequired", { row }));
    }
    if (
      hasText(relation.leftSourceId) &&
      hasText(relation.rightSourceId) &&
      relation.leftSourceId === relation.rightSourceId
    ) {
      errors.push(t("engineRules.validation.relationSourceConflict", { row }));
    }
  });

  const resultFields = rule.result.groupFields.filter(
    (field) => hasText(field.label) || hasText(field.sourceField) || hasText(field.sourceTableId),
  );
  if (resultFields.length === 0) {
    errors.push(t("engineRules.validation.resultGroupFieldRequired"));
  }

  resultFields.forEach((field, index) => {
    const row = index + 1;
    if (!hasText(field.label)) {
      errors.push(t("engineRules.validation.resultFieldLabelRequired", { row }));
    }
    if (!hasText(field.sourceTableId)) {
      errors.push(t("engineRules.validation.resultFieldSourceTableRequired", { row }));
    }
    if (!hasText(field.sourceField)) {
      errors.push(t("engineRules.validation.resultFieldSourceFieldRequired", { row }));
    }
  });

  if (rule.result.rowCompletion.enabled) {
    if (!hasText(rule.result.rowCompletion.targetField)) {
      errors.push(t("engineRules.validation.rowCompletionTargetFieldRequired"));
    }
    if (rule.result.rowCompletion.baselineType === "source_table" && !hasText(rule.result.rowCompletion.sourceTableId)) {
      errors.push(t("engineRules.validation.rowCompletionSourceTableRequired"));
    }
    if (rule.result.rowCompletion.baselineType === "source_table" && !hasText(rule.result.rowCompletion.sourceField)) {
      errors.push(t("engineRules.validation.rowCompletionSourceFieldRequired"));
    }
    if (
      rule.result.rowCompletion.baselineType === "mapping_group" &&
      !hasText(rule.result.rowCompletion.mappingGroupId)
    ) {
      errors.push(t("engineRules.validation.rowCompletionMappingGroupRequired"));
    }
    if (
      rule.result.rowCompletion.baselineType === "manual_values" &&
      !hasText(rule.result.rowCompletion.manualValuesText)
    ) {
      errors.push(t("engineRules.validation.rowCompletionManualValuesRequired"));
    }
  }

  if (rule.result.sheetConfig.mode === "split_field" && !hasText(rule.result.sheetConfig.splitField)) {
    errors.push(t("engineRules.validation.sheetSplitFieldRequired"));
  }
  if (
    rule.result.sheetConfig.mode === "split_field" &&
    rule.result.sheetConfig.splitFieldScope === "source_field" &&
    !hasText(rule.result.sheetConfig.splitSourceTableId)
  ) {
    errors.push(t("engineRules.validation.sheetSplitSourceTableRequired"));
  }

  const templateVariables = Array.from(
    new Set([
      ...rule.sources.flatMap((source) => source.sourceHeaders.map((field) => field.trim()).filter(Boolean)),
      ...rule.result.groupFields.map((field) => field.label.trim()).filter(Boolean),
      ...rule.outputFields.map((field) => field.fieldName.trim()).filter(Boolean),
    ]),
  );
  const templateVariableSet = new Set(templateVariables);
  if (rule.sheetTemplate.titleEnabled) {
    if (!hasText(rule.sheetTemplate.titleTemplate)) {
      errors.push(t("engineRules.validation.sheetTemplateTitleRequired"));
    }
    if (rule.sheetTemplate.headerRowIndex <= 1) {
      errors.push(t("engineRules.validation.sheetTemplateHeaderRowInvalid"));
    }
    if (rule.sheetTemplate.dataStartRowIndex <= rule.sheetTemplate.headerRowIndex) {
      errors.push(t("engineRules.validation.sheetTemplateDataStartInvalid"));
    }

    extractTitleTemplateVariables(rule.sheetTemplate.titleTemplate).forEach((variableKey) => {
      if (!templateVariableSet.has(variableKey)) {
        errors.push(t("engineRules.validation.sheetTemplateVariableInvalid", { variable: variableKey }));
      }
    });
  } else {
    if (rule.sheetTemplate.headerRowIndex < 1) {
      errors.push(t("engineRules.validation.sheetTemplateHeaderRowBaseInvalid"));
    }
    if (rule.sheetTemplate.dataStartRowIndex <= rule.sheetTemplate.headerRowIndex) {
      errors.push(t("engineRules.validation.sheetTemplateDataStartInvalid"));
    }
  }

  const outputFields = rule.outputFields.filter(
    (field) =>
      hasText(field.fieldName) ||
      hasText(field.nameSourceField) ||
      hasText(field.nameExpressionText) ||
      hasText(field.sourceField) ||
      hasText(field.expressionText) ||
      hasText(field.constantValue),
  );
  if (outputFields.length === 0) {
    errors.push(t("engineRules.validation.outputFieldRequired"));
  }

  outputFields.forEach((field, index) => {
    const row = index + 1;
    if (field.nameMode === "fixed" && !hasText(field.fieldName)) {
      errors.push(t("engineRules.validation.outputFieldNameRequired", { row }));
    }
    if ((field.nameMode === "source_field" || field.nameMode === "mapping") && !hasText(field.nameSourceTableId)) {
      errors.push(t("engineRules.validation.outputNameSourceTableRequired", { row }));
    }
    if (field.nameMode === "source_field" && !hasText(field.nameSourceField)) {
      errors.push(t("engineRules.validation.outputNameSourceFieldRequired", { row }));
    }
    if (field.nameMode === "mapping" && !hasText(field.nameMappingGroupId)) {
      errors.push(t("engineRules.validation.outputNameMappingRequired", { row }));
    }
    if (field.nameMode === "mapping" && field.nameMappingSourceFields.length === 0) {
      errors.push(t("engineRules.validation.outputNameMappingSourceFieldsRequired", { row }));
    }
    if (field.nameMode === "expression" && !hasText(field.nameExpressionText)) {
      errors.push(t("engineRules.validation.outputNameExpressionRequired", { row }));
    }
    if (field.valueMode !== "expression" && field.valueMode !== "constant" && !hasText(field.sourceTableId)) {
      errors.push(t("engineRules.validation.outputSourceTableRequired", { row }));
    }
    if (
      field.valueMode !== "expression" &&
      field.valueMode !== "constant" &&
      field.valueMode !== "mapping" &&
      field.valueMode !== "fill" &&
      field.valueMode !== "dynamic_columns" &&
      !hasText(field.sourceField)
    ) {
      errors.push(t("engineRules.validation.outputSourceFieldRequired", { row }));
    }
    if (field.valueMode === "constant" && !hasText(field.constantValue)) {
      errors.push(t("engineRules.validation.outputConstantValueRequired", { row }));
    }
    if (field.valueMode === "expression" && !hasText(field.expressionText)) {
      errors.push(t("engineRules.validation.outputExpressionRequired", { row }));
    }
    if (field.dataType === "date" && !hasText(field.dateOutputFormat)) {
      errors.push(t("engineRules.validation.outputDateFormatRequired", { row }));
    }
    if (field.valueMode === "mapping" && !hasText(field.mappingGroupId)) {
      errors.push(t("engineRules.validation.outputMappingRequired", { row }));
    }
    if (
      field.valueMode === "mapping" &&
      field.mappingSourceFields.length === 0 &&
      !hasText(field.sourceField)
    ) {
      errors.push(t("engineRules.validation.outputMappingSourceFieldsRequired", { row }));
    }
    if (field.valueMode === "fill" && field.fillConfig.enabled) {
      if (!hasText(field.fillConfig.baselineField)) {
        errors.push(t("engineRules.validation.outputFillBaselineRequired", { row }));
      }
      if (
        !hasText(field.fillConfig.baselineField) &&
        !hasText(field.fillConfig.mappingGroupId) &&
        !hasText(field.fillConfig.constantValue)
      ) {
        errors.push(t("engineRules.validation.outputFillConfigRequired", { row }));
      }
    }
    if (field.fallbackConfig.enabled) {
      if (
        (field.fallbackConfig.mode === "baseline" || field.fallbackConfig.mode === "mapping") &&
        !hasText(field.fallbackConfig.baselineField)
      ) {
        errors.push(t("engineRules.validation.outputFallbackBaselineRequired", { row }));
      }
      if (field.fallbackConfig.mode === "constant" && !hasText(field.fallbackConfig.constantValue)) {
        errors.push(t("engineRules.validation.outputFallbackConstantRequired", { row }));
      }
      if (field.fallbackConfig.mode === "mapping" && !hasText(field.fallbackConfig.mappingGroupId)) {
        errors.push(t("engineRules.validation.outputFallbackMappingRequired", { row }));
      }
    }
    if (
      field.valueMode === "text_aggregate" &&
      field.textAggregateConfig.delimiterMode === "custom" &&
      !hasText(field.textAggregateConfig.customDelimiter)
    ) {
      errors.push(t("engineRules.validation.outputTextAggregateDelimiterRequired", { row }));
    }
    if (field.valueMode === "dynamic_columns" && field.dynamicColumnConfig.enabled) {
      if (!hasText(field.dynamicColumnConfig.columnField)) {
        errors.push(t("engineRules.validation.outputDynamicColumnFieldRequired", { row }));
      }
      if (!hasText(field.dynamicColumnConfig.valueField)) {
        errors.push(t("engineRules.validation.outputDynamicValueFieldRequired", { row }));
      }
    }
  });

  if (rule.result.totalRow.enabled) {
    if (!hasText(rule.result.totalRow.label)) {
      errors.push(t("engineRules.validation.totalRowLabelRequired"));
    }
    if (rule.result.totalRow.sumFields.length === 0) {
      errors.push(t("engineRules.validation.totalRowSumFieldsRequired"));
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
