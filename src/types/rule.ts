export type RuleValueMode =
  | "source"
  | "constant"
  | "mapping"
  | "mapping_multi"
  | "conditional_target"
  | "aggregate_sum"
  | "aggregate_sum_divide"
  | "aggregate_join"
  | "copy_output"
  | "format_date"
  | "expression";
export type RuleSheetTitleConflictMode = "first" | "last" | "join_unique" | "error" | "placeholder";
export type RuleConditionalAggregateMode = "first" | "sum" | "join_newline";
export type RuleJoinDelimiter = "newline" | "space";
export type RuleGroupExcludeMode = "none" | "manual_values" | "mapping_group_source";

export type RuleOutputColumn = {
  id: string;
  targetField: string;
  valueMode: RuleValueMode;
  sourceField: string;
  mappingSourceFields: string[];
  constantValue: string;
  mappingSection: string;
  conditionalJudgeField: string;
  conditionalMappingSection: string;
  conditionalHitTargetField: string;
  conditionalMissTargetField: string;
  conditionalValueSourceField: string;
  conditionalAggregateMode: RuleConditionalAggregateMode;
  aggregateSourceField: string;
  aggregateNumeratorField: string;
  aggregateDenominatorField: string;
  aggregateJoinSourceField: string;
  aggregateJoinDelimiter: RuleJoinDelimiter;
  copyFromTargetField: string;
  dateSourceField: string;
  dateOutputFormat: string;
  expressionText: string;
};

export type RuleSheetTemplateVariableConfig = {
  variableKey: string;
  conflictMode: RuleSheetTitleConflictMode;
  placeholderValue: string;
};

export type RuleSheetTemplate = {
  titleEnabled: boolean;
  titleTemplate: string;
  variableConfigs: RuleSheetTemplateVariableConfig[];
  headerRowIndex: number;
  dataStartRowIndex: number;
  reservedFooterRows: number;
};

export type RuleDefinition = {
  id: string;
  name: string;
  description: string;
  sourceFileName: string;
  sourceSheetName: string;
  sourceHeaders: string[];
  groupByFields: string[];
  groupExcludeMode: RuleGroupExcludeMode;
  groupExcludeValuesText: string;
  groupExcludeMappingSection: string;
  summaryGroupByFields: string[];
  outputColumns: RuleOutputColumn[];
  sheetTemplate: RuleSheetTemplate;
  createdAt: string;
  updatedAt: string;
};

export type RuleSummary = Pick<RuleDefinition, "id" | "name" | "updatedAt">;

export const RULE_VALUE_MODES: RuleValueMode[] = [
  "source",
  "constant",
  "mapping",
  "mapping_multi",
  "conditional_target",
  "aggregate_sum",
  "aggregate_sum_divide",
  "aggregate_join",
  "copy_output",
  "format_date",
  "expression",
];
export const RULE_SHEET_TITLE_CONFLICT_MODES: RuleSheetTitleConflictMode[] = [
  "first",
  "last",
  "join_unique",
  "error",
  "placeholder",
];

export function createEmptyRuleOutputColumn(): RuleOutputColumn {
  return {
    id: crypto.randomUUID(),
    targetField: "",
    valueMode: "source",
    sourceField: "",
    mappingSourceFields: [],
    constantValue: "",
    mappingSection: "",
    conditionalJudgeField: "",
    conditionalMappingSection: "",
    conditionalHitTargetField: "",
    conditionalMissTargetField: "",
    conditionalValueSourceField: "",
    conditionalAggregateMode: "first",
    aggregateSourceField: "",
    aggregateNumeratorField: "",
    aggregateDenominatorField: "",
    aggregateJoinSourceField: "",
    aggregateJoinDelimiter: "newline",
    copyFromTargetField: "",
    dateSourceField: "",
    dateOutputFormat: "YYYY/M/D",
    expressionText: "",
  };
}

export function createEmptyRuleSheetTemplateVariableConfig(
  variableKey = "",
): RuleSheetTemplateVariableConfig {
  return {
    variableKey,
    conflictMode: "first",
    placeholderValue: "",
  };
}

export function createEmptyRuleSheetTemplate(): RuleSheetTemplate {
  return {
    titleEnabled: false,
    titleTemplate: "",
    variableConfigs: [],
    headerRowIndex: 2,
    dataStartRowIndex: 3,
    reservedFooterRows: 0,
  };
}

export function createEmptyRuleDefinition(): RuleDefinition {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    sourceFileName: "",
    sourceSheetName: "",
    sourceHeaders: [],
    groupByFields: [],
    groupExcludeMode: "none",
    groupExcludeValuesText: "",
    groupExcludeMappingSection: "",
    summaryGroupByFields: [],
    outputColumns: [createEmptyRuleOutputColumn()],
    sheetTemplate: createEmptyRuleSheetTemplate(),
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneRuleDefinition(rule: RuleDefinition): RuleDefinition {
  return {
    ...rule,
    sourceHeaders: [...rule.sourceHeaders],
    groupByFields: [...rule.groupByFields],
    groupExcludeMode: rule.groupExcludeMode,
    groupExcludeValuesText: rule.groupExcludeValuesText,
    groupExcludeMappingSection: rule.groupExcludeMappingSection,
    summaryGroupByFields: [...rule.summaryGroupByFields],
    outputColumns: rule.outputColumns.map((column) => ({
      ...column,
      mappingSourceFields: [...column.mappingSourceFields],
    })),
    sheetTemplate: {
      ...rule.sheetTemplate,
      variableConfigs: rule.sheetTemplate.variableConfigs.map((config) => ({ ...config })),
    },
  };
}
