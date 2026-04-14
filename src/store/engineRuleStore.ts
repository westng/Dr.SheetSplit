import Database from "@tauri-apps/plugin-sql";
import { ref } from "vue";
import { i18n } from "../i18n";
import {
  cloneEngineRuleDefinition,
  createEmptyEngineRuleStyleConfig,
  createEmptyEngineResultCompletionConfig,
  createEmptyEngineOutputFallbackConfig,
  createEmptyEngineSheetConfig,
  createEmptyEngineSheetTemplate,
  createEmptyEngineFieldFillConfig,
  createEmptyEngineDynamicGroupAggregateConfig,
  createEmptyEngineRuleDefinition,
  createEmptyEngineTextAggregateConfig,
  createEmptyEngineTotalRowConfig,
  createEmptyEngineTotalRowFieldConfig,
  createEmptyEngineDynamicColumnConfig,
  type EngineEmptyValuePolicy,
  type EngineOutputNameMode,
  type EngineOutputDataType,
  type EngineOutputMatchCondition,
  type EngineOutputFallbackConfig,
  type EngineOutputFallbackMode,
  type EngineNumberPostProcessMode,
  type EngineOutputValueMode,
  type EngineRelationJoinType,
  type EngineRelationMultiMatchStrategy,
  type EngineRuleDefinition,
  type EngineRuleStyleConfig,
  type EngineRuleResultConfig,
  type EngineSheetConfig,
  type EngineSheetSplitScope,
  type EngineSheetValueFilterMode,
  type EngineSheetTemplate,
  type EngineSheetMode,
  type EngineStyleHorizontalAlign,
  type EngineStyleToken,
  type EngineRuleSource,
  type EngineRuleType,
  type EngineTotalRowAggregateMode,
  type EngineTotalRowConfig,
  type EngineTotalRowFieldConfig,
  type EngineResultGroupField,
  type EngineResultCompletionBaselineType,
  type EngineResultCompletionConfig,
  type EngineResultCompletionMappingValueType,
  type EngineResultCompletionMode,
  type EngineResultSortConfig,
  type EngineResultSortField,
  type EngineResultSortMode,
  type EngineTextAggregateConfig,
  type EngineTextAggregateDelimiterMode,
  type EngineRuleOutputField,
  type EngineSourceRelation,
  type EngineSourceFilter,
  type EngineSourceFilterOperator,
  type EngineSortDirection,
} from "../types/engineRule";

const RULE_DB_PATH = "sqlite:rules.db";
const ENGINE_RULE_TABLE_NAME = "engine_rules";
const t = i18n.global.t;

type EngineRuleRow = {
  id: string;
  payload: string;
};

const engineRules = ref<EngineRuleDefinition[]>([]);
const isEngineRuleStoreReady = ref(false);
const engineRuleStoreError = ref("");

let initPromise: Promise<void> | null = null;
let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(RULE_DB_PATH);
  }
  return dbPromise;
}

async function ensureSchema(): Promise<void> {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${ENGINE_RULE_TABLE_NAME} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function normalizeRuleType(value: unknown): EngineRuleType {
  return value === "multi_table" ? "multi_table" : "single_table";
}

function normalizeFilterOperator(value: unknown): EngineSourceFilterOperator {
  if (value === "equals" || value === "not_equals") {
    return value;
  }
  return "contains_any";
}

function normalizeSortDirection(value: unknown): EngineSortDirection {
  return value === "desc" ? "desc" : "asc";
}

function normalizeResultSortMode(value: unknown): EngineResultSortMode {
  return value === "mapping_order" ? "mapping_order" : "value";
}

function normalizeSheetMode(value: unknown): EngineSheetMode {
  return value === "split_field" ? "split_field" : "single";
}

function normalizeSheetSplitScope(value: unknown): EngineSheetSplitScope {
  return value === "source_field" ? "source_field" : "result_field";
}

function normalizeSheetValueFilterMode(value: unknown): EngineSheetValueFilterMode {
  if (value === "exclude_manual" || value === "exclude_mapping_source") {
    return value;
  }
  return "none";
}

function normalizeRelationJoinType(value: unknown): EngineRelationJoinType {
  return value === "inner_join" ? "inner_join" : "left_join";
}

function normalizeRelationMultiMatchStrategy(value: unknown): EngineRelationMultiMatchStrategy {
  if (value === "all" || value === "error") {
    return value;
  }
  return "first";
}

function normalizeResultCompletionMode(value: unknown): EngineResultCompletionMode {
  return value === "baseline_only" ? "baseline_only" : "append_missing";
}

function normalizeResultCompletionBaselineType(value: unknown): EngineResultCompletionBaselineType {
  if (value === "mapping_group" || value === "manual_values") {
    return value;
  }
  return "source_table";
}

function normalizeResultCompletionMappingValueType(value: unknown): EngineResultCompletionMappingValueType {
  return value === "source" ? "source" : "target";
}

function normalizeTextAggregateDelimiterMode(value: unknown): EngineTextAggregateDelimiterMode {
  if (value === "comma" || value === "custom") {
    return value;
  }
  return "newline";
}

function normalizeOutputValueMode(value: unknown): EngineOutputValueMode {
  if (
    value === "constant" ||
    value === "sum" ||
    value === "avg" ||
    value === "count" ||
    value === "count_distinct" ||
    value === "first" ||
    value === "last" ||
    value === "expression" ||
    value === "mapping" ||
    value === "fill" ||
    value === "text_aggregate" ||
    value === "dynamic_columns" ||
    value === "dynamic_group_sum" ||
    value === "dynamic_group_avg"
  ) {
    return value;
  }
  return "source";
}

function normalizeOutputDataType(value: unknown): EngineOutputDataType {
  if (value === "number" || value === "date" || value === "dynamic") {
    return value;
  }
  return "text";
}

function normalizeOutputNameMode(value: unknown): EngineOutputNameMode {
  if (value === "source_field" || value === "mapping" || value === "expression") {
    return value;
  }
  return "fixed";
}

function normalizeOutputFallbackMode(value: unknown): EngineOutputFallbackMode {
  if (value === "constant" || value === "baseline" || value === "mapping") {
    return value;
  }
  return "empty";
}

function normalizeEmptyValuePolicy(value: unknown): EngineEmptyValuePolicy {
  if (value === "zero" || value === "constant" || value === "error") {
    return value;
  }
  return "empty";
}

function normalizeNumberPostProcessMode(value: unknown): EngineNumberPostProcessMode {
  if (value === "round" || value === "fixed_2") {
    return value;
  }
  if (value === "ceil" || value === "floor") {
    return "round";
  }
  return "none";
}

function normalizeStyleHorizontalAlign(value: unknown): EngineStyleHorizontalAlign {
  if (value === "center" || value === "right") {
    return value;
  }
  return "left";
}

function normalizeTotalRowAggregateMode(value: unknown): EngineTotalRowAggregateMode {
  if (
    value === "avg" ||
    value === "single_first" ||
    value === "single_last" ||
    value === "fixed" ||
    value === "expression"
  ) {
    return value;
  }
  return "sum";
}

function normalizeColorValue(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  return text.startsWith("#") ? text : `#${text}`;
}

function normalizeStyleToken(value: unknown, fallback: EngineStyleToken): EngineStyleToken {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const input = value as Partial<EngineStyleToken>;
  const fontSize = Number(input.fontSize);
  return {
    bold: typeof input.bold === "boolean" ? input.bold : fallback.bold,
    fontSize: Number.isFinite(fontSize) && fontSize >= 8 && fontSize <= 72 ? Math.round(fontSize) : fallback.fontSize,
    textColor: normalizeColorValue(input.textColor),
    backgroundColor: normalizeColorValue(input.backgroundColor),
    horizontalAlign: normalizeStyleHorizontalAlign(input.horizontalAlign),
  };
}

function normalizeRuleStyleConfig(value: unknown): EngineRuleStyleConfig {
  const fallback = createEmptyEngineRuleStyleConfig();
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const input = value as Partial<EngineRuleStyleConfig>;
  return {
    title: normalizeStyleToken(input.title, fallback.title),
    header: normalizeStyleToken(input.header, fallback.header),
    data: normalizeStyleToken(input.data, fallback.data),
    totalRow: normalizeStyleToken(input.totalRow, fallback.totalRow),
  };
}

function normalizePositiveInt(value: unknown, fallbackValue: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallbackValue;
  }
  return parsed;
}

function normalizeNonNegativeInt(value: unknown, fallbackValue: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallbackValue;
  }
  return parsed;
}

function normalizeSourceFilter(value: unknown): EngineSourceFilter | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as Partial<EngineSourceFilter>;
  return {
    id: String(input.id ?? "").trim() || crypto.randomUUID(),
    field: String(input.field ?? "").trim(),
    operator: normalizeFilterOperator(input.operator),
    valueText: String(input.valueText ?? ""),
  };
}

function normalizeSource(value: unknown): EngineRuleSource | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<EngineRuleSource>;
  return {
    id: String(input.id ?? "").trim() || crypto.randomUUID(),
    sourceFileName: String((input as { sourceFileName?: unknown }).sourceFileName ?? "").trim(),
    sourceSheetName: String((input as { sourceSheetName?: unknown }).sourceSheetName ?? "").trim(),
    sourceHeaderRowIndex: normalizePositiveInt((input as { sourceHeaderRowIndex?: unknown }).sourceHeaderRowIndex, 1),
    sourceGroupHeaderRowIndex: normalizeNonNegativeInt(
      (input as { sourceGroupHeaderRowIndex?: unknown }).sourceGroupHeaderRowIndex,
      0,
    ),
    sourceHeaders: Array.isArray((input as { sourceHeaders?: unknown[] }).sourceHeaders)
      ? Array.from(
          new Set(
            ((input as { sourceHeaders?: unknown[] }).sourceHeaders ?? [])
              .map((item) => String(item).trim())
              .filter(Boolean),
          ),
        )
      : [],
    preFilters: Array.isArray(input.preFilters)
      ? input.preFilters
          .map(normalizeSourceFilter)
          .filter((item): item is EngineSourceFilter => item !== null)
      : [],
  };
}

function normalizeResultGroupField(value: unknown): EngineResultGroupField | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<EngineResultGroupField>;
  return {
    id: String(input.id ?? "").trim() || crypto.randomUUID(),
    label: String(input.label ?? "").trim(),
    sourceTableId: String(input.sourceTableId ?? "").trim(),
    sourceField: String(input.sourceField ?? "").trim(),
    visible: typeof input.visible === "boolean" ? input.visible : true,
  };
}

function normalizeResultSortField(value: unknown): EngineResultSortField | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<EngineResultSortField>;
  return {
    id: String(input.id ?? "").trim() || crypto.randomUUID(),
    fieldName: String(input.fieldName ?? "").trim(),
    mode: normalizeResultSortMode((input as { mode?: unknown }).mode),
    mappingGroupId: String((input as { mappingGroupId?: unknown }).mappingGroupId ?? "").trim(),
    direction: normalizeSortDirection(input.direction),
  };
}

function normalizeResultSortConfig(value: unknown): EngineResultSortConfig {
  const fallback = createEmptyEngineRuleDefinition().result.sortConfig;
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const input = value as Partial<EngineResultSortConfig>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : fallback.enabled,
    fields: Array.isArray(input.fields)
      ? input.fields.map(normalizeResultSortField).filter((item): item is EngineResultSortField => item !== null)
      : fallback.fields,
  };
}

function normalizeTotalRowFieldConfig(value: unknown): EngineTotalRowFieldConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<EngineTotalRowFieldConfig>;
  return {
    ...createEmptyEngineTotalRowFieldConfig(),
    id: String(input.id ?? "").trim() || crypto.randomUUID(),
    fieldName: String(input.fieldName ?? "").trim(),
    aggregateMode: normalizeTotalRowAggregateMode(input.aggregateMode),
    fixedValue: String(input.fixedValue ?? ""),
    expressionText: String(input.expressionText ?? ""),
  };
}

function normalizeOutputMatchCondition(value: unknown): EngineOutputMatchCondition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<EngineOutputMatchCondition>;
  return {
    id: String(input.id ?? "").trim() || crypto.randomUUID(),
    resultField: String(input.resultField ?? "").trim(),
    sourceField: String(input.sourceField ?? "").trim(),
  };
}

function normalizeSourceRelation(value: unknown): EngineSourceRelation | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<EngineSourceRelation>;
  return {
    id: String(input.id ?? "").trim() || crypto.randomUUID(),
    leftSourceId: String(input.leftSourceId ?? "").trim(),
    rightSourceId: String(input.rightSourceId ?? "").trim(),
    leftField: String(input.leftField ?? "").trim(),
    rightField: String(input.rightField ?? "").trim(),
    joinType: normalizeRelationJoinType(input.joinType),
    multiMatchStrategy: normalizeRelationMultiMatchStrategy(input.multiMatchStrategy),
  };
}

function normalizeTextAggregateConfig(value: unknown): EngineTextAggregateConfig {
  const fallback = createEmptyEngineTextAggregateConfig();
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const input = value as Partial<EngineTextAggregateConfig>;
  return {
    delimiterMode: normalizeTextAggregateDelimiterMode(input.delimiterMode),
    customDelimiter: String(input.customDelimiter ?? fallback.customDelimiter),
    distinct: typeof input.distinct === "boolean" ? input.distinct : fallback.distinct,
    sortField: String(input.sortField ?? "").trim(),
    sortDirection: normalizeSortDirection(input.sortDirection),
  };
}

function normalizeOutputFallbackConfig(value: unknown): EngineOutputFallbackConfig {
  const fallback = createEmptyEngineOutputFallbackConfig();
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const input = value as Partial<EngineOutputFallbackConfig>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : fallback.enabled,
    mode: normalizeOutputFallbackMode(input.mode),
    baselineField: String(input.baselineField ?? "").trim(),
    mappingGroupId: String(input.mappingGroupId ?? "").trim(),
    constantValue: String(input.constantValue ?? ""),
  };
}

function normalizeOutputField(value: unknown): EngineRuleOutputField | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<EngineRuleOutputField>;
  return {
    id: String(input.id ?? "").trim() || crypto.randomUUID(),
    nameMode: normalizeOutputNameMode(input.nameMode),
    fieldName: String(input.fieldName ?? "").trim(),
    nameSourceTableId: String((input as { nameSourceTableId?: unknown }).nameSourceTableId ?? "").trim(),
    nameSourceField: String((input as { nameSourceField?: unknown }).nameSourceField ?? "").trim(),
    nameMappingGroupId: String((input as { nameMappingGroupId?: unknown }).nameMappingGroupId ?? "").trim(),
    nameMappingSourceFields: Array.isArray((input as { nameMappingSourceFields?: unknown[] }).nameMappingSourceFields)
      ? Array.from(
          new Set(
            ((input as { nameMappingSourceFields?: unknown[] }).nameMappingSourceFields ?? [])
              .map((item) => String(item).trim())
              .filter(Boolean),
          ),
        )
      : [],
    nameExpressionText: String((input as { nameExpressionText?: unknown }).nameExpressionText ?? ""),
    sourceTableId: String(input.sourceTableId ?? "").trim(),
    sourceField: String(input.sourceField ?? "").trim(),
    mappingSourceFields: Array.isArray((input as { mappingSourceFields?: unknown[] }).mappingSourceFields)
      ? Array.from(
          new Set(
            ((input as { mappingSourceFields?: unknown[] }).mappingSourceFields ?? [])
              .map((item) => String(item).trim())
              .filter(Boolean),
          ),
        )
      : [],
    valueMode: normalizeOutputValueMode(input.valueMode),
    dataType: normalizeOutputDataType(input.dataType),
    matchConditions: Array.isArray(input.matchConditions)
      ? input.matchConditions
          .map(normalizeOutputMatchCondition)
          .filter((item): item is EngineOutputMatchCondition => item !== null)
      : [],
    filters: Array.isArray(input.filters)
      ? input.filters
          .map(normalizeSourceFilter)
          .filter((item): item is EngineSourceFilter => item !== null)
      : [],
    expressionText: String(input.expressionText ?? ""),
    mappingGroupId: String(input.mappingGroupId ?? "").trim(),
    constantValue: String((input as { constantValue?: unknown }).constantValue ?? ""),
    fillConfig: {
      ...createEmptyEngineFieldFillConfig(),
      ...(input.fillConfig && typeof input.fillConfig === "object" ? input.fillConfig : {}),
      enabled:
        input.fillConfig && typeof input.fillConfig === "object"
          ? Boolean((input.fillConfig as { enabled?: unknown }).enabled)
          : false,
      baselineField:
        input.fillConfig && typeof input.fillConfig === "object"
          ? String((input.fillConfig as { baselineField?: unknown }).baselineField ?? "").trim()
          : "",
      mappingGroupId:
        input.fillConfig && typeof input.fillConfig === "object"
          ? String((input.fillConfig as { mappingGroupId?: unknown }).mappingGroupId ?? "").trim()
          : "",
      constantValue:
        input.fillConfig && typeof input.fillConfig === "object"
          ? String((input.fillConfig as { constantValue?: unknown }).constantValue ?? "")
          : "",
    },
    fallbackConfig: normalizeOutputFallbackConfig(
      input.fallbackConfig && typeof input.fallbackConfig === "object"
        ? input.fallbackConfig
        : undefined,
    ),
    textAggregateConfig: normalizeTextAggregateConfig(
      input.textAggregateConfig && typeof input.textAggregateConfig === "object"
        ? input.textAggregateConfig
        : undefined,
    ),
    dynamicColumnConfig: {
      ...createEmptyEngineDynamicColumnConfig(),
      ...(input.dynamicColumnConfig && typeof input.dynamicColumnConfig === "object"
        ? input.dynamicColumnConfig
        : {}),
      enabled:
        input.dynamicColumnConfig && typeof input.dynamicColumnConfig === "object"
          ? Boolean((input.dynamicColumnConfig as { enabled?: unknown }).enabled)
          : false,
      columnField:
        input.dynamicColumnConfig && typeof input.dynamicColumnConfig === "object"
          ? String((input.dynamicColumnConfig as { columnField?: unknown }).columnField ?? "").trim()
          : "",
      valueField:
        input.dynamicColumnConfig && typeof input.dynamicColumnConfig === "object"
          ? String((input.dynamicColumnConfig as { valueField?: unknown }).valueField ?? "").trim()
          : "",
      namePrefix:
        input.dynamicColumnConfig && typeof input.dynamicColumnConfig === "object"
          ? String((input.dynamicColumnConfig as { namePrefix?: unknown }).namePrefix ?? "")
          : "",
      nameSuffix:
        input.dynamicColumnConfig && typeof input.dynamicColumnConfig === "object"
          ? String((input.dynamicColumnConfig as { nameSuffix?: unknown }).nameSuffix ?? "")
          : "",
    },
    dynamicGroupAggregateConfig: {
      ...createEmptyEngineDynamicGroupAggregateConfig(),
      ...(input.dynamicGroupAggregateConfig && typeof input.dynamicGroupAggregateConfig === "object"
        ? input.dynamicGroupAggregateConfig
        : {}),
      sourceFieldId:
        input.dynamicGroupAggregateConfig && typeof input.dynamicGroupAggregateConfig === "object"
          ? String((input.dynamicGroupAggregateConfig as { sourceFieldId?: unknown }).sourceFieldId ?? "").trim()
          : "",
    },
    numberPostProcessMode: normalizeNumberPostProcessMode(
      (input as { numberPostProcessMode?: unknown }).numberPostProcessMode,
    ),
    emptyValuePolicy: normalizeEmptyValuePolicy(input.emptyValuePolicy),
    defaultValue: String(input.defaultValue ?? ""),
    dateOutputFormat: String((input as { dateOutputFormat?: unknown }).dateOutputFormat ?? "YYYY/M/D"),
  };
}

function normalizeResultCompletionConfig(value: unknown): EngineResultCompletionConfig {
  const fallback = createEmptyEngineResultCompletionConfig();
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const input = value as Partial<EngineResultCompletionConfig>;
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : false,
    targetField: String(input.targetField ?? "").trim(),
    completionMode: normalizeResultCompletionMode(input.completionMode),
    baselineType: normalizeResultCompletionBaselineType(input.baselineType),
    sourceTableId: String(input.sourceTableId ?? "").trim(),
    sourceField: String(input.sourceField ?? "").trim(),
    mappingGroupId: String(input.mappingGroupId ?? "").trim(),
    mappingValueType: normalizeResultCompletionMappingValueType(input.mappingValueType),
    manualValuesText: String(input.manualValuesText ?? fallback.manualValuesText),
  };
}

function normalizeResultConfig(value: unknown): EngineRuleResultConfig {
  const fallback = createEmptyEngineRuleDefinition().result;
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const input = value as Partial<EngineRuleResultConfig>;
  const groupFields = Array.isArray(input.groupFields)
    ? input.groupFields
        .map(normalizeResultGroupField)
        .filter((item): item is EngineResultGroupField => item !== null)
    : [];

  const sheetInput =
    input.sheetConfig && typeof input.sheetConfig === "object" ? (input.sheetConfig as Partial<EngineSheetConfig>) : {};
  const totalRowInput =
    input.totalRow && typeof input.totalRow === "object" ? (input.totalRow as Partial<EngineTotalRowConfig>) : {};
  const normalizedFieldConfigs = Array.isArray((totalRowInput as { fieldConfigs?: unknown }).fieldConfigs)
    ? ((totalRowInput as { fieldConfigs?: unknown[] }).fieldConfigs ?? [])
        .map(normalizeTotalRowFieldConfig)
        .filter((item): item is EngineTotalRowFieldConfig => item !== null)
    : [];
  const legacySumFieldConfigs = Array.isArray((totalRowInput as { sumFields?: unknown }).sumFields)
    ? Array.from(
        new Set(
          ((totalRowInput as { sumFields?: unknown[] }).sumFields ?? []).map((item) => String(item).trim()).filter(Boolean),
        ),
      ).map((fieldName) => ({
        ...createEmptyEngineTotalRowFieldConfig(),
        fieldName,
        aggregateMode: "sum" as const,
      }))
    : [];
  const sortConfig = normalizeResultSortConfig((input as { sortConfig?: unknown }).sortConfig);
  const legacySortFields = Array.isArray((input as { sortFields?: unknown[] }).sortFields)
    ? ((input as { sortFields?: unknown[] }).sortFields ?? [])
        .map(normalizeResultSortField)
        .filter((item): item is EngineResultSortField => item !== null)
    : [];

  return {
    groupFields: Array.isArray(input.groupFields) ? groupFields : fallback.groupFields,
    sortConfig:
      (input as { sortConfig?: unknown }).sortConfig !== undefined
        ? sortConfig
        : {
            enabled: legacySortFields.length > 0,
            fields: legacySortFields,
          },
    rowCompletion: normalizeResultCompletionConfig((input as { rowCompletion?: unknown }).rowCompletion),
    sheetConfig: {
      ...createEmptyEngineSheetConfig(),
      mode: normalizeSheetMode(sheetInput.mode),
      splitFieldScope: normalizeSheetSplitScope(sheetInput.splitFieldScope),
      splitSourceTableId: String(sheetInput.splitSourceTableId ?? "").trim(),
      splitField: String(sheetInput.splitField ?? "").trim(),
      sheetNameTemplate: String(sheetInput.sheetNameTemplate ?? ""),
      sheetValueFilterMode: normalizeSheetValueFilterMode(
        (sheetInput as { sheetValueFilterMode?: unknown }).sheetValueFilterMode,
      ),
      sheetValueFilterValuesText: String(
        (sheetInput as { sheetValueFilterValuesText?: unknown }).sheetValueFilterValuesText ?? "",
      ),
      sheetValueFilterMappingGroupId: String(
        (sheetInput as { sheetValueFilterMappingGroupId?: unknown }).sheetValueFilterMappingGroupId ?? "",
      ).trim(),
    },
    totalRow: {
      ...createEmptyEngineTotalRowConfig(),
      enabled: typeof totalRowInput.enabled === "boolean" ? totalRowInput.enabled : false,
      label: String(totalRowInput.label ?? fallback.totalRow.label ?? t("engineRules.defaults.totalRowLabel")),
      labelField: String(totalRowInput.labelField ?? "").trim(),
      fieldConfigs: normalizedFieldConfigs.length > 0 ? normalizedFieldConfigs : legacySumFieldConfigs,
    },
  };
}

function normalizeSheetTemplate(value: unknown): EngineSheetTemplate {
  const fallback = createEmptyEngineSheetTemplate();
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const input = value as Partial<EngineSheetTemplate>;
  return {
    titleEnabled: Boolean(input.titleEnabled),
    titleTemplate: String(input.titleTemplate ?? ""),
    headerRowIndex: normalizePositiveInt(input.headerRowIndex, fallback.headerRowIndex),
    dataStartRowIndex: normalizePositiveInt(input.dataStartRowIndex, fallback.dataStartRowIndex),
  };
}

function normalizeEngineRule(value: unknown): EngineRuleDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<EngineRuleDefinition>;
  const fallback = createEmptyEngineRuleDefinition();
  const id = String(input.id ?? "").trim();
  if (!id) {
    return null;
  }

  const sources = Array.isArray(input.sources)
    ? input.sources
        .map(normalizeSource)
        .filter((item): item is EngineRuleSource => item !== null)
    : [];
  const outputFields = Array.isArray(input.outputFields)
    ? input.outputFields
        .map(normalizeOutputField)
        .filter((item): item is EngineRuleOutputField => item !== null)
    : [];
  const relations = Array.isArray((input as { relations?: unknown[] }).relations)
    ? ((input as { relations?: unknown[] }).relations ?? [])
        .map(normalizeSourceRelation)
        .filter((item): item is EngineSourceRelation => item !== null)
    : [];

  return {
    id,
    name: String(input.name ?? ""),
    description: String(input.description ?? ""),
    ruleType: normalizeRuleType(input.ruleType),
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    sources: sources.length > 0 ? sources : fallback.sources,
    relations,
    result: normalizeResultConfig(input.result),
    sheetTemplate: normalizeSheetTemplate((input as { sheetTemplate?: unknown }).sheetTemplate),
    styleConfig: normalizeRuleStyleConfig((input as { styleConfig?: unknown }).styleConfig),
    outputFields: outputFields.length > 0 ? outputFields : fallback.outputFields,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : fallback.createdAt,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : fallback.updatedAt,
  };
}

function normalizeImportedRulesPayload(payload: unknown): EngineRuleDefinition[] {
  if (Array.isArray(payload)) {
    return payload
      .map(normalizeEngineRule)
      .filter((item): item is EngineRuleDefinition => item !== null);
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  if (Array.isArray(objectPayload.rules)) {
    return objectPayload.rules
      .map(normalizeEngineRule)
      .filter((item): item is EngineRuleDefinition => item !== null);
  }

  const single = normalizeEngineRule(payload);
  return single ? [single] : [];
}

function ensureImportedRuleIds(items: EngineRuleDefinition[]): EngineRuleDefinition[] {
  const usedIds = new Set<string>();
  return items.map((item) => {
    let nextId = item.id.trim();
    while (!nextId || usedIds.has(nextId)) {
      nextId = crypto.randomUUID();
    }
    usedIds.add(nextId);
    return {
      ...cloneEngineRuleDefinition(item),
      id: nextId,
    };
  });
}

async function reloadEngineRules(): Promise<void> {
  await ensureSchema();
  const db = await getDb();
  const rows = await db.select<EngineRuleRow[]>(
    `SELECT id, payload FROM ${ENGINE_RULE_TABLE_NAME} ORDER BY datetime(updated_at) DESC`,
  );

  engineRules.value = rows
    .map((row) => {
      try {
        return normalizeEngineRule(JSON.parse(row.payload));
      } catch {
        return null;
      }
    })
    .filter((item): item is EngineRuleDefinition => item !== null);
}

export function initializeEngineRuleStore(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await ensureSchema();
      await reloadEngineRules();
      engineRuleStoreError.value = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      engineRuleStoreError.value = message || t("engineRules.messages.initFailed");
    } finally {
      isEngineRuleStoreReady.value = true;
    }
  })();

  return initPromise;
}

export function useEngineRuleStore() {
  void initializeEngineRuleStore();

  async function saveEngineRule(rule: EngineRuleDefinition): Promise<EngineRuleDefinition> {
    await ensureSchema();
    const db = await getDb();
    const now = new Date().toISOString();
    const existing = engineRules.value.find((item) => item.id === rule.id);
    const normalized: EngineRuleDefinition = {
      ...cloneEngineRuleDefinition(rule),
      createdAt: existing?.createdAt ?? rule.createdAt ?? now,
      updatedAt: now,
    };

    await db.execute(
      `
        INSERT INTO ${ENGINE_RULE_TABLE_NAME} (id, name, payload, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `,
      [
        normalized.id,
        normalized.name.trim() || t("engineRules.library.unnamed"),
        JSON.stringify(normalized),
        normalized.createdAt,
        normalized.updatedAt,
      ],
    );

    await reloadEngineRules();
    return normalized;
  }

  async function deleteEngineRule(ruleId: string): Promise<void> {
    await ensureSchema();
    const db = await getDb();
    await db.execute(`DELETE FROM ${ENGINE_RULE_TABLE_NAME} WHERE id = $1`, [ruleId]);
    await reloadEngineRules();
  }

  async function replaceEngineRulesByImport(payload: unknown): Promise<number> {
    await ensureSchema();
    const db = await getDb();
    const imported = ensureImportedRuleIds(normalizeImportedRulesPayload(payload));
    if (imported.length === 0) {
      throw new Error(t("engineRules.messages.importNoValidRules"));
    }

    await db.execute(`DELETE FROM ${ENGINE_RULE_TABLE_NAME}`);
    for (const item of imported) {
      await db.execute(
        `
          INSERT INTO ${ENGINE_RULE_TABLE_NAME} (id, name, payload, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [
          item.id,
          item.name.trim() || t("engineRules.library.unnamed"),
          JSON.stringify(item),
          item.createdAt,
          item.updatedAt,
        ],
      );
    }

    await reloadEngineRules();
    return imported.length;
  }

  function getEngineRuleById(ruleId: string): EngineRuleDefinition | null {
    const hit = engineRules.value.find((item) => item.id === ruleId);
    return hit ? cloneEngineRuleDefinition(hit) : null;
  }

  return {
    engineRules,
    isEngineRuleStoreReady,
    engineRuleStoreError,
    saveEngineRule,
    deleteEngineRule,
    replaceEngineRulesByImport,
    getEngineRuleById,
    reloadEngineRules,
  };
}
