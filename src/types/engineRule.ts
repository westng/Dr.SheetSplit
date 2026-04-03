export type EngineRuleType = "single_table" | "multi_table";
export type EngineSourceFilterOperator = "contains_any" | "equals" | "not_equals";
export type EngineSortDirection = "asc" | "desc";
export type EngineSheetMode = "single" | "split_field";
export type EngineSheetSplitScope = "result_field" | "source_field";
export type EngineRelationJoinType = "left_join" | "inner_join";
export type EngineRelationMultiMatchStrategy = "first" | "error";
export type EngineResultCompletionMode = "append_missing" | "baseline_only";
export type EngineResultCompletionBaselineType = "source_table" | "mapping_group" | "manual_values";
export type EngineResultCompletionMappingValueType = "source" | "target";
export type EngineTextAggregateDelimiterMode = "newline" | "comma" | "custom";
export type EngineOutputFallbackMode = "empty" | "constant" | "baseline" | "mapping";
export type EngineOutputValueMode =
  | "source"
  | "constant"
  | "sum"
  | "avg"
  | "count"
  | "count_distinct"
  | "first"
  | "last"
  | "expression"
  | "mapping"
  | "fill"
  | "text_aggregate"
  | "dynamic_columns";
export type EngineOutputDataType = "text" | "number" | "date" | "dynamic";
export type EngineEmptyValuePolicy = "empty" | "zero" | "constant" | "error";
export type EngineOutputNameMode = "fixed" | "source_field" | "mapping" | "expression";

export type EngineSourceFilter = {
  id: string;
  field: string;
  operator: EngineSourceFilterOperator;
  valueText: string;
};

export type EngineRuleSource = {
  id: string;
  sourceFileName: string;
  sourceSheetName: string;
  sourceHeaderRowIndex: number;
  sourceGroupHeaderRowIndex: number;
  sourceHeaders: string[];
  preFilters: EngineSourceFilter[];
};

export type EngineResultGroupField = {
  id: string;
  label: string;
  sourceTableId: string;
  sourceField: string;
  visible: boolean;
};

export type EngineResultSortField = {
  id: string;
  fieldName: string;
  direction: EngineSortDirection;
};

export type EngineSourceRelation = {
  id: string;
  leftSourceId: string;
  rightSourceId: string;
  leftField: string;
  rightField: string;
  joinType: EngineRelationJoinType;
  multiMatchStrategy: EngineRelationMultiMatchStrategy;
};

export type EngineSheetConfig = {
  mode: EngineSheetMode;
  splitFieldScope: EngineSheetSplitScope;
  splitSourceTableId: string;
  splitField: string;
  sheetNameTemplate: string;
};

export type EngineSheetTemplate = {
  titleEnabled: boolean;
  titleTemplate: string;
  headerRowIndex: number;
  dataStartRowIndex: number;
};

export type EngineTotalRowConfig = {
  enabled: boolean;
  label: string;
  labelField: string;
  sumFields: string[];
};

export type EngineResultCompletionConfig = {
  enabled: boolean;
  targetField: string;
  completionMode: EngineResultCompletionMode;
  baselineType: EngineResultCompletionBaselineType;
  sourceTableId: string;
  sourceField: string;
  mappingGroupId: string;
  mappingValueType: EngineResultCompletionMappingValueType;
  manualValuesText: string;
};

export type EngineOutputMatchCondition = {
  id: string;
  resultField: string;
  sourceField: string;
};

export type EngineDynamicColumnConfig = {
  enabled: boolean;
  columnField: string;
  valueField: string;
  namePrefix: string;
  nameSuffix: string;
};

export type EngineFieldFillConfig = {
  enabled: boolean;
  baselineField: string;
  mappingGroupId: string;
  constantValue: string;
};

export type EngineTextAggregateConfig = {
  delimiterMode: EngineTextAggregateDelimiterMode;
  customDelimiter: string;
  distinct: boolean;
  sortField: string;
  sortDirection: EngineSortDirection;
};

export type EngineOutputFallbackConfig = {
  enabled: boolean;
  mode: EngineOutputFallbackMode;
  baselineField: string;
  mappingGroupId: string;
  constantValue: string;
};

export type EngineRuleOutputField = {
  id: string;
  nameMode: EngineOutputNameMode;
  fieldName: string;
  nameSourceTableId: string;
  nameSourceField: string;
  nameMappingGroupId: string;
  nameMappingSourceFields: string[];
  nameExpressionText: string;
  sourceTableId: string;
  sourceField: string;
  mappingSourceFields: string[];
  valueMode: EngineOutputValueMode;
  dataType: EngineOutputDataType;
  matchConditions: EngineOutputMatchCondition[];
  filters: EngineSourceFilter[];
  expressionText: string;
  mappingGroupId: string;
  constantValue: string;
  fillConfig: EngineFieldFillConfig;
  fallbackConfig: EngineOutputFallbackConfig;
  textAggregateConfig: EngineTextAggregateConfig;
  dynamicColumnConfig: EngineDynamicColumnConfig;
  emptyValuePolicy: EngineEmptyValuePolicy;
  defaultValue: string;
  dateOutputFormat: string;
};

export type EngineRuleResultConfig = {
  groupFields: EngineResultGroupField[];
  sortFields: EngineResultSortField[];
  rowCompletion: EngineResultCompletionConfig;
  sheetConfig: EngineSheetConfig;
  totalRow: EngineTotalRowConfig;
};

export type EngineRuleDefinition = {
  id: string;
  name: string;
  description: string;
  ruleType: EngineRuleType;
  enabled: boolean;
  sources: EngineRuleSource[];
  relations: EngineSourceRelation[];
  result: EngineRuleResultConfig;
  sheetTemplate: EngineSheetTemplate;
  outputFields: EngineRuleOutputField[];
  createdAt: string;
  updatedAt: string;
};

export const ENGINE_RULE_TYPES: EngineRuleType[] = ["single_table", "multi_table"];
export const ENGINE_SOURCE_FILTER_OPERATORS: EngineSourceFilterOperator[] = [
  "contains_any",
  "equals",
  "not_equals",
];
export const ENGINE_SORT_DIRECTIONS: EngineSortDirection[] = ["asc", "desc"];
export const ENGINE_SHEET_MODES: EngineSheetMode[] = ["single", "split_field"];
export const ENGINE_SHEET_SPLIT_SCOPES: EngineSheetSplitScope[] = ["result_field", "source_field"];
export const ENGINE_RELATION_JOIN_TYPES: EngineRelationJoinType[] = ["left_join", "inner_join"];
export const ENGINE_RELATION_MULTI_MATCH_STRATEGIES: EngineRelationMultiMatchStrategy[] = ["first", "error"];
export const ENGINE_RESULT_COMPLETION_MODES: EngineResultCompletionMode[] = ["append_missing", "baseline_only"];
export const ENGINE_RESULT_COMPLETION_BASELINE_TYPES: EngineResultCompletionBaselineType[] = [
  "source_table",
  "mapping_group",
  "manual_values",
];
export const ENGINE_RESULT_COMPLETION_MAPPING_VALUE_TYPES: EngineResultCompletionMappingValueType[] = [
  "source",
  "target",
];
export const ENGINE_TEXT_AGGREGATE_DELIMITER_MODES: EngineTextAggregateDelimiterMode[] = [
  "newline",
  "comma",
  "custom",
];
export const ENGINE_OUTPUT_FALLBACK_MODES: EngineOutputFallbackMode[] = [
  "empty",
  "constant",
  "baseline",
  "mapping",
];
export const ENGINE_OUTPUT_VALUE_MODES: EngineOutputValueMode[] = [
  "source",
  "constant",
  "sum",
  "avg",
  "count",
  "count_distinct",
  "first",
  "last",
  "expression",
  "mapping",
  "fill",
  "text_aggregate",
  "dynamic_columns",
];
export const ENGINE_OUTPUT_DATA_TYPES: EngineOutputDataType[] = ["text", "number", "date", "dynamic"];
export const ENGINE_EMPTY_VALUE_POLICIES: EngineEmptyValuePolicy[] = [
  "empty",
  "zero",
  "constant",
  "error",
];
export const ENGINE_OUTPUT_NAME_MODES: EngineOutputNameMode[] = ["fixed", "source_field", "mapping", "expression"];

export function createEmptyEngineSourceFilter(): EngineSourceFilter {
  return {
    id: crypto.randomUUID(),
    field: "",
    operator: "contains_any",
    valueText: "",
  };
}

export function createEmptyEngineRuleSource(): EngineRuleSource {
  return {
    id: crypto.randomUUID(),
    sourceFileName: "",
    sourceSheetName: "",
    sourceHeaderRowIndex: 1,
    sourceGroupHeaderRowIndex: 0,
    sourceHeaders: [],
    preFilters: [],
  };
}

export function createEmptyEngineResultGroupField(): EngineResultGroupField {
  return {
    id: crypto.randomUUID(),
    label: "",
    sourceTableId: "",
    sourceField: "",
    visible: true,
  };
}

export function createEmptyEngineResultSortField(): EngineResultSortField {
  return {
    id: crypto.randomUUID(),
    fieldName: "",
    direction: "asc",
  };
}

export function createEmptyEngineSourceRelation(): EngineSourceRelation {
  return {
    id: crypto.randomUUID(),
    leftSourceId: "",
    rightSourceId: "",
    leftField: "",
    rightField: "",
    joinType: "left_join",
    multiMatchStrategy: "first",
  };
}

export function createEmptyEngineOutputMatchCondition(): EngineOutputMatchCondition {
  return {
    id: crypto.randomUUID(),
    resultField: "",
    sourceField: "",
  };
}

export function createEmptyEngineDynamicColumnConfig(): EngineDynamicColumnConfig {
  return {
    enabled: false,
    columnField: "",
    valueField: "",
    namePrefix: "",
    nameSuffix: "",
  };
}

export function createEmptyEngineFieldFillConfig(): EngineFieldFillConfig {
  return {
    enabled: false,
    baselineField: "",
    mappingGroupId: "",
    constantValue: "",
  };
}

export function createEmptyEngineTextAggregateConfig(): EngineTextAggregateConfig {
  return {
    delimiterMode: "newline",
    customDelimiter: "",
    distinct: true,
    sortField: "",
    sortDirection: "asc",
  };
}

export function createEmptyEngineOutputFallbackConfig(): EngineOutputFallbackConfig {
  return {
    enabled: false,
    mode: "empty",
    baselineField: "",
    mappingGroupId: "",
    constantValue: "",
  };
}

export function createEmptyEngineRuleOutputField(): EngineRuleOutputField {
  return {
    id: crypto.randomUUID(),
    nameMode: "fixed",
    fieldName: "",
    nameSourceTableId: "",
    nameSourceField: "",
    nameMappingGroupId: "",
    nameMappingSourceFields: [],
    nameExpressionText: "",
    sourceTableId: "",
    sourceField: "",
    mappingSourceFields: [],
    valueMode: "source",
    dataType: "text",
    matchConditions: [],
    filters: [],
    expressionText: "",
    mappingGroupId: "",
    constantValue: "",
    fillConfig: createEmptyEngineFieldFillConfig(),
    fallbackConfig: createEmptyEngineOutputFallbackConfig(),
    textAggregateConfig: createEmptyEngineTextAggregateConfig(),
    dynamicColumnConfig: createEmptyEngineDynamicColumnConfig(),
    emptyValuePolicy: "empty",
    defaultValue: "",
    dateOutputFormat: "YYYY/M/D",
  };
}

export function createEmptyEngineSheetConfig(): EngineSheetConfig {
  return {
    mode: "single",
    splitFieldScope: "result_field",
    splitSourceTableId: "",
    splitField: "",
    sheetNameTemplate: "",
  };
}

export function createEmptyEngineTotalRowConfig(): EngineTotalRowConfig {
  return {
    enabled: false,
    label: "",
    labelField: "",
    sumFields: [],
  };
}

export function createEmptyEngineResultCompletionConfig(): EngineResultCompletionConfig {
  return {
    enabled: false,
    targetField: "",
    completionMode: "append_missing",
    baselineType: "source_table",
    sourceTableId: "",
    sourceField: "",
    mappingGroupId: "",
    mappingValueType: "target",
    manualValuesText: "",
  };
}

export function createEmptyEngineSheetTemplate(): EngineSheetTemplate {
  return {
    titleEnabled: false,
    titleTemplate: "",
    headerRowIndex: 2,
    dataStartRowIndex: 3,
  };
}

export function createEmptyEngineRuleResultConfig(): EngineRuleResultConfig {
  return {
    groupFields: [createEmptyEngineResultGroupField()],
    sortFields: [],
    rowCompletion: createEmptyEngineResultCompletionConfig(),
    sheetConfig: createEmptyEngineSheetConfig(),
    totalRow: createEmptyEngineTotalRowConfig(),
  };
}

export function createEmptyEngineRuleDefinition(): EngineRuleDefinition {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    ruleType: "single_table",
    enabled: true,
    sources: [createEmptyEngineRuleSource()],
    relations: [],
    result: createEmptyEngineRuleResultConfig(),
    sheetTemplate: createEmptyEngineSheetTemplate(),
    outputFields: [createEmptyEngineRuleOutputField()],
    createdAt: now,
    updatedAt: now,
  };
}

export function cloneEngineRuleDefinition(rule: EngineRuleDefinition): EngineRuleDefinition {
  return JSON.parse(JSON.stringify(rule)) as EngineRuleDefinition;
}
