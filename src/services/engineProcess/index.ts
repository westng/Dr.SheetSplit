import { resolveOutputPath, writeBinaryToPath } from "../process/fileOutput";
import { buildWorkbookBinary } from "../process/workbookBuilder";
import type { EngineOutput, EngineSheetOutput } from "../process/types";
import type {
  EngineRuleDefinition,
  EngineRuleOutputField,
  EngineSourceFilter,
  EngineTotalRowFieldConfig,
} from "../../types/engineRule";
import {
  buildSheetPreview,
  readSpreadsheetSheetRows,
} from "../../utils/spreadsheetParser";

type MappingGroupEntry = {
  source: string;
  target: string;
};

type MappingGroup = {
  id: string;
  name?: string;
  entries: readonly MappingGroupEntry[];
};

export type EngineProcessSourceInput = {
  sourceId: string;
  datasetId: string;
  sheetName: string;
  fileName: string;
};

export type EngineProcessTaskInput = {
  rule: EngineRuleDefinition;
  sources: EngineProcessSourceInput[];
  mappingGroups: readonly MappingGroup[];
  exportDirectory: string;
};

export type EngineProcessTaskStage =
  | "load_sources"
  | "join_sources"
  | "build_result"
  | "build_workbook"
  | "resolve_output_path"
  | "write_output_file";

export type EngineProcessTaskOptions = {
  onStage?: (stage: EngineProcessTaskStage) => void;
  onLog?: (message: string, level?: "info" | "success" | "error") => void;
};

export type EngineProcessTaskResult = {
  outputPath: string;
  sheetCount: number;
  rowCount: number;
  engineOutput: EngineOutput;
};

type SourceRow = Record<string, string>;

export type EngineProcessLoadedSource = {
  id: string;
  fileName: string;
  sheetName: string;
  headers: string[];
  rows: SourceRow[];
};

export type EngineProcessComputationInput = {
  rule: EngineRuleDefinition;
  loadedSources: Record<string, EngineProcessLoadedSource>;
  mappingGroups: readonly MappingGroup[];
};

type EngineProcessWorkerRequest = {
  input: EngineProcessComputationInput;
};

type EngineProcessWorkerSuccess = {
  ok: true;
  engineOutput: EngineOutput;
};

type EngineProcessWorkerFailure = {
  ok: false;
  error: string;
};

type EngineProcessWorkerProgress = {
  ok: null;
  stage?: EngineProcessTaskStage;
  log?: {
    message: string;
    level: "info" | "success" | "error";
  };
};

let workerInstance: Worker | null = null;

function toWorkerSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") {
    return null;
  }
  if (!workerInstance) {
    workerInstance = new Worker(new URL("./engineProcess.worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return workerInstance;
}

type WorkingRecord = {
  sourceRows: Record<string, SourceRow | null | undefined>;
};

type ResultBucket = {
  key: string;
  dimensionValues: Record<string, string>;
  workingRows: WorkingRecord[];
  filled: boolean;
  outputValues: Record<string, string>;
  rowValues: string[];
  mergedSourceValues: Record<string, string>;
};

type MappingIndexes = Record<string, Record<string, string>>;

type DynamicHeaderConfig = {
  fieldId: string;
  baseLabel: string;
  headers: string[];
  headerMap: Record<string, string>;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

const UNKNOWN_FALLBACK = "未知错误";

function asText(value: unknown): string {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function splitKeywords(value: string): string[] {
  return value
    .split(/[\n\r,，]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value: unknown, fieldName: string): number {
  const text = asText(value).replace(/,/g, "");
  if (!text) {
    throw new Error(`字段“${fieldName}”为空，无法进行数值计算。`);
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`字段“${fieldName}”值“${text}”不是合法数字。`);
  }
  return parsed;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (Math.abs(value - Math.round(value)) < 1e-9) {
    return String(Math.round(value));
  }
  return value.toFixed(6).replace(/\.?0+$/, "");
}

function parseDateParts(value: unknown): DateParts | null {
  const text = asText(value);
  if (!text) {
    return null;
  }

  if (/^\d{8}$/.test(text)) {
    return {
      year: Number(text.slice(0, 4)),
      month: Number(text.slice(4, 6)),
      day: Number(text.slice(6, 8)),
    };
  }

  const normalized = text
    .replace(/[年/.]/g, "-")
    .replace(/月/g, "-")
    .replace(/日/g, "")
    .replace(/\s+/g, " ");
  const matched = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (matched) {
    return {
      year: Number(matched[1]),
      month: Number(matched[2]),
      day: Number(matched[3]),
    };
  }

  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const date = new Date(timestamp);
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function formatDateValue(value: string, format: string): string {
  const normalizedValue = asText(value);
  if (!normalizedValue) {
    return "";
  }
  const parts = parseDateParts(normalizedValue);
  if (!parts) {
    return normalizedValue;
  }

  const normalizedFormat = asText(format) || "YYYY/M/D";
  return normalizedFormat
    .replace(/YYYY/g, String(parts.year))
    .replace(/MM/g, String(parts.month).padStart(2, "0"))
    .replace(/DD/g, String(parts.day).padStart(2, "0"))
    .replace(/M/g, String(parts.month))
    .replace(/D/g, String(parts.day));
}

function buildMappingIndexes(mappingGroups: readonly MappingGroup[]): MappingIndexes {
  const result: MappingIndexes = {};
  mappingGroups.forEach((group) => {
    const groupId = asText(group.id);
    if (!groupId) {
      return;
    }
    result[groupId] = {};
    group.entries.forEach((entry) => {
      const key = asText(entry.source);
      if (!key) {
        return;
      }
      result[groupId][key] = asText(entry.target);
    });
  });
  return result;
}

function buildCompositeKey(values: string[]): string {
  return values.map((item) => asText(item)).join("+");
}

function resolveMappingValue(
  mappingIndexes: MappingIndexes,
  mappingGroupId: string,
  sourceValue: string,
): string {
  if (!sourceValue) {
    return "";
  }
  return mappingIndexes[mappingGroupId]?.[sourceValue] ?? UNKNOWN_FALLBACK;
}

function resolveBaselineMappingValue(
  mappingIndexes: MappingIndexes,
  mappingGroups: readonly MappingGroup[],
  mappingGroupId: string,
  baselineValue: string,
): string {
  const normalizedBaseline = asText(baselineValue);
  if (!normalizedBaseline) {
    return "";
  }

  const exactValue = mappingIndexes[mappingGroupId]?.[normalizedBaseline];
  if (exactValue) {
    return exactValue;
  }

  const group = mappingGroups.find((item) => item.id === mappingGroupId);
  if (!group) {
    return UNKNOWN_FALLBACK;
  }

  const prefix = `${normalizedBaseline}+`;
  const matchedTargets = Array.from(
    new Set(
      group.entries
        .filter((entry) => {
          const source = asText(entry.source);
          return source === normalizedBaseline || source.startsWith(prefix);
        })
        .map((entry) => asText(entry.target))
        .filter(Boolean),
    ),
  );

  if (matchedTargets.length === 1) {
    return matchedTargets[0] ?? "";
  }

  return UNKNOWN_FALLBACK;
}

function resolveMultiMappingValue(
  mappingIndexes: MappingIndexes,
  mappingGroupId: string,
  sourceValues: string[],
): string {
  if (sourceValues.some((value) => !asText(value))) {
    return "";
  }
  const key = buildCompositeKey(sourceValues);
  if (!key) {
    return "";
  }
  return mappingIndexes[mappingGroupId]?.[key] ?? UNKNOWN_FALLBACK;
}

function matchesFilterValue(filter: EngineSourceFilter, fieldValue: string): boolean {
  const normalized = asText(fieldValue);
  const valueText = asText(filter.valueText);
  if (!valueText) {
    return true;
  }
  if (filter.operator === "equals") {
    return normalized === valueText;
  }
  if (filter.operator === "not_equals") {
    return normalized !== valueText;
  }
  const keywords = splitKeywords(valueText);
  if (keywords.length === 0) {
    return true;
  }
  return keywords.some((keyword) => normalized.includes(keyword));
}

function applySourceFilters(rows: SourceRow[], filters: EngineSourceFilter[]): SourceRow[] {
  if (filters.length === 0) {
    return rows;
  }
  return rows.filter((row) =>
    filters.every((filter) => matchesFilterValue(filter, asText(row[filter.field]))),
  );
}

function log(
  options: EngineProcessTaskOptions,
  message: string,
  level: "info" | "success" | "error" = "info",
): void {
  options.onLog?.(message, level);
}

async function loadSources(
  input: EngineProcessTaskInput,
  options: EngineProcessTaskOptions,
): Promise<Record<string, EngineProcessLoadedSource>> {
  options.onStage?.("load_sources");
  const result: Record<string, EngineProcessLoadedSource> = {};

  for (const source of input.rule.sources) {
    const runtimeSource = input.sources.find((item) => item.sourceId === source.id);
    if (!runtimeSource) {
      throw new Error(`来源表缺失：${source.id}`);
    }

    log(options, `正在读取来源表：${runtimeSource.fileName || runtimeSource.sheetName} / ${runtimeSource.sheetName}`);
    const sheetData = await readSpreadsheetSheetRows(runtimeSource.datasetId, runtimeSource.sheetName);
    const sheetPreview = buildSheetPreview(sheetData, {
      headerRowIndex: source.sourceHeaderRowIndex,
      groupHeaderRowIndex: source.sourceGroupHeaderRowIndex,
    });
    const filteredRows = applySourceFilters(sheetPreview.rows, source.preFilters);
    result[source.id] = {
      id: source.id,
      fileName: runtimeSource.fileName,
      sheetName: runtimeSource.sheetName,
      headers: sheetPreview.headers,
      rows: filteredRows,
    };
    log(options, `来源表读取完成：${runtimeSource.sheetName}，${filteredRows.length} 行。`);
  }

  return result;
}

function createWorkingRecords(rows: SourceRow[], sourceId: string): WorkingRecord[] {
  return rows.map((row) => ({
    sourceRows: {
      [sourceId]: row,
    },
  }));
}

function joinSources(
  rule: EngineRuleDefinition,
  loadedSources: Record<string, EngineProcessLoadedSource>,
  options: EngineProcessTaskOptions,
): WorkingRecord[] {
  options.onStage?.("join_sources");
  if (rule.sources.length === 0) {
    return [];
  }

  if (rule.ruleType === "single_table" || rule.sources.length === 1) {
    const source = rule.sources[0];
    log(options, `正在构建单表处理数据：${loadedSources[source.id]?.rows.length ?? 0} 行。`);
    return createWorkingRecords(loadedSources[source.id]?.rows ?? [], source.id);
  }

  if (rule.relations.length === 0) {
    throw new Error("多表规则缺少关联配置，无法开始处理。");
  }

  let workingRows: WorkingRecord[] = [];
  const joinedSourceIds = new Set<string>();

  rule.relations.forEach((relation, relationIndex) => {
    const leftSource = loadedSources[relation.leftSourceId];
    const rightSource = loadedSources[relation.rightSourceId];
    if (!leftSource || !rightSource) {
      throw new Error(`关联 #${relationIndex + 1} 引用了不存在的来源表。`);
    }

    if (workingRows.length === 0) {
      workingRows = createWorkingRecords(leftSource.rows, relation.leftSourceId);
      joinedSourceIds.add(relation.leftSourceId);
    }

    if (!joinedSourceIds.has(relation.leftSourceId)) {
      throw new Error(`关联 #${relationIndex + 1} 的左表尚未加入处理链，请按处理顺序调整关联配置。`);
    }

    if (joinedSourceIds.has(relation.rightSourceId)) {
      return;
    }

    log(options, `正在执行关联 #${relationIndex + 1}：${leftSource.sheetName} -> ${rightSource.sheetName}`);
    const index = new Map<string, SourceRow[]>();
    rightSource.rows.forEach((row) => {
      const key = asText(row[relation.rightField]);
      if (!index.has(key)) {
        index.set(key, []);
      }
      index.get(key)?.push(row);
    });

    const nextRows: WorkingRecord[] = [];
    workingRows.forEach((record) => {
      const leftRow = record.sourceRows[relation.leftSourceId];
      const matchKey = asText(leftRow?.[relation.leftField]);
      const matches = matchKey ? (index.get(matchKey) ?? []) : [];
      if (matches.length > 1 && relation.multiMatchStrategy === "error") {
        throw new Error(`关联 #${relationIndex + 1} 命中多条记录：${matchKey}`);
      }
      if (matches.length === 0) {
        if (relation.joinType === "left_join") {
          nextRows.push({
            sourceRows: {
              ...record.sourceRows,
              [relation.rightSourceId]: null,
            },
          });
        }
        return;
      }

      if (relation.multiMatchStrategy === "all" && matches.length > 1) {
        matches.forEach((matchedRow) => {
          nextRows.push({
            sourceRows: {
              ...record.sourceRows,
              [relation.rightSourceId]: matchedRow,
            },
          });
        });
        return;
      }

      nextRows.push({
        sourceRows: {
          ...record.sourceRows,
          [relation.rightSourceId]: matches[0],
        },
      });
    });

    workingRows = nextRows;
    joinedSourceIds.add(relation.rightSourceId);
  });

  const unjoinedSources = rule.sources.filter((source) => !joinedSourceIds.has(source.id));
  if (unjoinedSources.length > 0) {
    throw new Error(`仍有来源表未接入处理链：${unjoinedSources.map((item) => item.sourceSheetName || item.id).join("、")}`);
  }

  log(options, `多表关联完成，当前结果 ${workingRows.length} 行。`);
  return workingRows;
}

function resolveSourceValue(
  record: WorkingRecord,
  sourceTableId: string,
  sourceField: string,
): string {
  if (!sourceTableId || !sourceField) {
    return "";
  }
  const row = record.sourceRows[sourceTableId];
  return asText(row?.[sourceField]);
}

function mergeSourceValues(record: WorkingRecord, sourceOrder: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  sourceOrder.forEach((sourceId) => {
    const row = record.sourceRows[sourceId];
    if (!row) {
      return;
    }
    Object.entries(row).forEach(([key, value]) => {
      if (key && !(key in result)) {
        result[key] = asText(value);
      }
    });
  });
  return result;
}

function buildDimensionValues(rule: EngineRuleDefinition, record: WorkingRecord): Record<string, string> {
  const values: Record<string, string> = {};
  rule.result.groupFields.forEach((field) => {
    values[field.label] = resolveSourceValue(record, field.sourceTableId, field.sourceField);
  });
  return values;
}

function buildGroupKeyByLabels(labels: string[], values: Record<string, string>): string {
  return labels.map((label) => asText(values[label])).join("\u001f");
}

function parseManualValues(text: string): string[] {
  return text
    .split(/[\n\r,，]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveCompletionBaselineValues(
  rule: EngineRuleDefinition,
  loadedSources: Record<string, EngineProcessLoadedSource>,
  mappingGroups: readonly MappingGroup[],
): string[] {
  const config = rule.result.rowCompletion;
  if (!config.enabled) {
    return [];
  }
  if (config.baselineType === "manual_values") {
    return Array.from(new Set(parseManualValues(config.manualValuesText)));
  }
  if (config.baselineType === "mapping_group") {
    const group = mappingGroups.find((item) => item.id === config.mappingGroupId);
    if (!group) {
      return [];
    }
    return Array.from(
      new Set(
        group.entries
          .map((entry) => (config.mappingValueType === "source" ? asText(entry.source) : asText(entry.target)))
          .filter(Boolean),
      ),
    );
  }
  const source = loadedSources[config.sourceTableId];
  if (!source) {
    return [];
  }
  return Array.from(new Set(source.rows.map((row) => asText(row[config.sourceField])).filter(Boolean)));
}

function resolveSheetValueExclusions(
  rule: EngineRuleDefinition,
  mappingGroups: readonly MappingGroup[],
): Set<string> {
  const config = rule.result.sheetConfig;
  if (config.sheetValueFilterMode === "exclude_manual") {
    return new Set(parseManualValues(config.sheetValueFilterValuesText));
  }
  if (config.sheetValueFilterMode === "exclude_mapping_source") {
    const group = mappingGroups.find((item) => item.id === config.sheetValueFilterMappingGroupId);
    return new Set((group?.entries ?? []).map((entry) => asText(entry.source)).filter(Boolean));
  }
  return new Set();
}

function applyRowCompletion(
  rule: EngineRuleDefinition,
  buckets: ResultBucket[],
  baselineValues: string[],
): ResultBucket[] {
  if (!rule.result.rowCompletion.enabled || !rule.result.rowCompletion.targetField || baselineValues.length === 0) {
    return buckets;
  }

  const targetField = rule.result.rowCompletion.targetField;
  const bucketsByTarget = new Map<string, ResultBucket[]>();
  buckets.forEach((bucket) => {
    const key = asText(bucket.dimensionValues[targetField]);
    if (!key) {
      return;
    }
    const group = bucketsByTarget.get(key) ?? [];
    group.push(bucket);
    bucketsByTarget.set(key, group);
  });

  const baselineBuckets = baselineValues.flatMap((value) => {
    const existing = bucketsByTarget.get(value);
    if (existing && existing.length > 0) {
      return existing;
    }
    const dimensionValues = Object.fromEntries(
      rule.result.groupFields.map((field) => [field.label, field.label === targetField ? value : ""]),
    );
    return [{
      key: buildGroupKeyByLabels(rule.result.groupFields.map((field) => field.label), dimensionValues),
      dimensionValues,
      workingRows: [],
      filled: true,
      outputValues: {},
      rowValues: [],
      mergedSourceValues: {},
    } satisfies ResultBucket];
  });

  if (rule.result.rowCompletion.completionMode === "baseline_only") {
    const extras = buckets.filter((bucket) => !baselineValues.includes(asText(bucket.dimensionValues[targetField])));
    return [...baselineBuckets, ...extras];
  }

  const merged = [...baselineBuckets];
  buckets.forEach((bucket) => {
    const targetValue = asText(bucket.dimensionValues[targetField]);
    if (targetValue && baselineValues.includes(targetValue)) {
      return;
    }
    merged.push(bucket);
  });
  return merged;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareMaybeNumber(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return compareText(left, right);
}

function resolveFieldValue(
  bucket: ResultBucket,
  row: SourceRow,
  fieldName: string,
): string {
  return asText(row[fieldName] ?? bucket.dimensionValues[fieldName] ?? bucket.outputValues[fieldName]);
}

function matchesOutputFilters(field: EngineRuleOutputField, row: SourceRow): boolean {
  return field.filters.every((filter) => matchesFilterValue(filter, asText(row[filter.field])));
}

function extractMatchedSourceRows(
  bucket: ResultBucket,
  field: EngineRuleOutputField,
): SourceRow[] {
  if (!field.sourceTableId) {
    return [];
  }
  const uniqueRows = new Set<SourceRow>();
  const matchedRows: SourceRow[] = [];
  bucket.workingRows.forEach((record) => {
    const row = record.sourceRows[field.sourceTableId];
    if (!row || uniqueRows.has(row)) {
      return;
    }
    if (!matchesOutputFilters(field, row)) {
      return;
    }
    const matchAll = field.matchConditions.every((condition) => {
      const expected = asText(bucket.dimensionValues[condition.resultField]);
      const actual = asText(row[condition.sourceField]);
      return expected === actual;
    });
    if (!matchAll) {
      return;
    }
    uniqueRows.add(row);
    matchedRows.push(row);
  });
  return matchedRows;
}

function applyEmptyValuePolicy(field: EngineRuleOutputField, value: string): string {
  const normalized = asText(value);
  if (normalized) {
    return normalized;
  }
  if (field.emptyValuePolicy === "zero") {
    return "0";
  }
  if (field.emptyValuePolicy === "constant") {
    return asText(field.defaultValue);
  }
  if (field.emptyValuePolicy === "error") {
    throw new Error(`字段“${field.fieldName || "未命名字段"}”为空。`);
  }
  return "";
}

function finalizeOutputValue(field: EngineRuleOutputField, value: string): string {
  const normalized = applyEmptyValuePolicy(field, value);
  if (field.dataType === "date") {
    return formatDateValue(normalized, field.dateOutputFormat);
  }
  return normalized;
}

function sortRowsForTextAggregate(rows: SourceRow[], field: EngineRuleOutputField): SourceRow[] {
  const sortField = asText(field.textAggregateConfig.sortField);
  if (!sortField) {
    return rows;
  }
  const direction = field.textAggregateConfig.sortDirection === "desc" ? -1 : 1;
  return [...rows].sort((left, right) =>
    compareText(asText(left[sortField]), asText(right[sortField])) * direction,
  );
}

function aggregateText(rows: SourceRow[], field: EngineRuleOutputField): string {
  const delimiter = field.textAggregateConfig.delimiterMode === "comma"
    ? ","
    : field.textAggregateConfig.delimiterMode === "custom"
      ? field.textAggregateConfig.customDelimiter
      : "\n";
  const sortedRows = sortRowsForTextAggregate(rows, field);
  const values = sortedRows.map((row) => asText(row[field.sourceField])).filter(Boolean);
  const normalizedValues = field.textAggregateConfig.distinct ? Array.from(new Set(values)) : values;
  return normalizedValues.join(delimiter);
}

function getExpressionNumber(value: unknown): number {
  const text = asText(value);
  if (!text || text === UNKNOWN_FALLBACK || text === "-" || text === "未知错误填充") {
    return 0;
  }
  return parseNumber(text, "表达式");
}

function resolveDynamicGroupAggregateValue(
  field: EngineRuleOutputField,
  outputValues: Record<string, string>,
  dynamicHeaderConfigs: Map<string, DynamicHeaderConfig>,
): string {
  const sourceFieldId = asText(field.dynamicGroupAggregateConfig.sourceFieldId);
  if (!sourceFieldId) {
    return "";
  }
  const config = dynamicHeaderConfigs.get(sourceFieldId);
  const headers = config?.headers ?? [];
  if (headers.length === 0) {
    return "";
  }
  const total = headers.reduce((sum, header) => sum + getExpressionNumber(outputValues[header]), 0);
  if (field.valueMode === "dynamic_group_avg") {
    return formatNumber(safeDivide(total, headers.length));
  }
  return formatNumber(total);
}

function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return 0;
  }
  return numerator / denominator;
}

function evaluateExpression(
  expressionText: string,
  rows: SourceRow[],
  firstRow: SourceRow,
  outputValues: Record<string, string>,
): string {
  const expression = asText(expressionText);
  if (!expression) {
    return "";
  }

  const valuesFor = (fieldName: string): string[] =>
    rows.map((row) => asText(row[fieldName])).filter(Boolean);

  const sum = (fieldName: string): number =>
    valuesFor(fieldName).reduce((total, value) => total + parseNumber(value, fieldName), 0);
  const avg = (fieldName: string): number => {
    const values = valuesFor(fieldName);
    if (values.length === 0) {
      return 0;
    }
    return values.reduce((total, value) => total + parseNumber(value, fieldName), 0) / values.length;
  };
  const first = (fieldName: string): string => asText(firstRow[fieldName]);
  const num = (fieldName: string): number => getExpressionNumber(firstRow[fieldName]);
  const output = (fieldName: string): string => asText(outputValues[fieldName]);
  const output_num = (fieldName: string): number => getExpressionNumber(outputValues[fieldName]);
  const join = (fieldName: string, delimiter = "\n"): string => valuesFor(fieldName).join(asText(delimiter) || "\n");
  const join_unique = (fieldName: string, delimiter = "\n"): string =>
    Array.from(new Set(valuesFor(fieldName))).join(asText(delimiter) || "\n");
  const count = (fieldName = ""): number => (fieldName ? valuesFor(fieldName).length : rows.length);
  const count_non_empty = (fieldName: string): number => valuesFor(fieldName).length;
  const count_distinct = (fieldName: string): number => Array.from(new Set(valuesFor(fieldName))).length;
  const sum_latest = (valueField: string, latestField: string): number => {
    const normalizedLatestField = asText(latestField);
    const normalizedValueField = asText(valueField);
    if (!normalizedLatestField || !normalizedValueField || rows.length === 0) {
      return 0;
    }

    const latestValue = rows.reduce((currentLatest, row) => {
      const candidate = asText(row[normalizedLatestField]);
      if (!candidate) {
        return currentLatest;
      }
      if (!currentLatest) {
        return candidate;
      }
      return compareMaybeNumber(candidate, currentLatest) > 0 ? candidate : currentLatest;
    }, "");

    if (!latestValue) {
      return 0;
    }

    return rows.reduce((total, row) => {
      if (asText(row[normalizedLatestField]) !== latestValue) {
        return total;
      }
      const rawValue = asText(row[normalizedValueField]);
      if (!rawValue) {
        return total;
      }
      return total + parseNumber(rawValue, normalizedValueField);
    }, 0);
  };
  const sum_divide = (numeratorField: string, denominatorField: string): number =>
    safeDivide(sum(numeratorField), num(denominatorField));
  const sum_divide_sum = (numeratorField: string, denominatorField: string): number =>
    safeDivide(sum(numeratorField), sum(denominatorField));
  const coalesce = (...values: unknown[]): string => {
    for (const item of values) {
      const text = asText(item);
      if (text) {
        return text;
      }
    }
    return "";
  };

  try {
    const runner = new Function(
      "sum",
      "avg",
      "first",
      "num",
      "output",
      "output_num",
      "join",
      "join_unique",
      "count",
      "count_non_empty",
      "count_distinct",
      "sum_latest",
      "sum_divide",
      "sum_divide_sum",
      "coalesce",
      `return (${expression});`,
    ) as (...args: unknown[]) => unknown;
    const result = runner(
      sum,
      avg,
      first,
      num,
      output,
      output_num,
      join,
      join_unique,
      count,
      count_non_empty,
      count_distinct,
      sum_latest,
      sum_divide,
      sum_divide_sum,
      coalesce,
    );
    if (typeof result === "number") {
      return formatNumber(result);
    }
    return asText(result);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    throw new Error(`表达式执行失败：${expression}${reason ? `，${reason}` : ""}`);
  }
}

function resolveFillValue(
  bucket: ResultBucket,
  field: EngineRuleOutputField,
  mappingIndexes: MappingIndexes,
  mappingGroups: readonly MappingGroup[],
): string {
  if (!field.fillConfig.enabled) {
    return "";
  }
  const baselineField = asText(field.fillConfig.baselineField);
  const baselineValue = asText(bucket.dimensionValues[baselineField] ?? bucket.outputValues[baselineField]);
  if (field.fillConfig.mappingGroupId) {
    return resolveBaselineMappingValue(mappingIndexes, mappingGroups, field.fillConfig.mappingGroupId, baselineValue);
  }
  if (asText(field.fillConfig.constantValue)) {
    return asText(field.fillConfig.constantValue);
  }
  if (baselineValue) {
    return baselineValue;
  }
  return "";
}

function resolveFallbackValue(
  bucket: ResultBucket,
  field: EngineRuleOutputField,
  mappingIndexes: MappingIndexes,
  mappingGroups: readonly MappingGroup[],
): string {
  if (!field.fallbackConfig.enabled) {
    return "";
  }

  if (field.fallbackConfig.mode === "empty") {
    return "";
  }
  if (field.fallbackConfig.mode === "constant") {
    return asText(field.fallbackConfig.constantValue);
  }

  const baselineField = asText(field.fallbackConfig.baselineField);
  const baselineValue = asText(bucket.dimensionValues[baselineField] ?? bucket.outputValues[baselineField]);
  if (field.fallbackConfig.mode === "baseline") {
    return baselineValue;
  }
  if (field.fallbackConfig.mode === "mapping") {
    return resolveBaselineMappingValue(mappingIndexes, mappingGroups, field.fallbackConfig.mappingGroupId, baselineValue);
  }
  return "";
}

function resolveScalarOutputValue(
  bucket: ResultBucket,
  field: EngineRuleOutputField,
  mappingIndexes: MappingIndexes,
  mappingGroups: readonly MappingGroup[],
): string {
  if (field.valueMode === "constant") {
    return applyEmptyValuePolicy(field, asText(field.constantValue));
  }

  const matchedRows = extractMatchedSourceRows(bucket, field);
  const firstRow = matchedRows[0] ?? {};

  let value = "";
  switch (field.valueMode) {
    case "source":
    case "first":
      value = asText(firstRow[field.sourceField]);
      break;
    case "last":
      value = asText(matchedRows[matchedRows.length - 1]?.[field.sourceField]);
      break;
    case "sum":
      value = matchedRows.length > 0
        ? formatNumber(matchedRows.reduce((total, row) => total + parseNumber(row[field.sourceField], field.sourceField), 0))
        : "";
      break;
    case "avg":
      value = matchedRows.length > 0
        ? formatNumber(
            matchedRows.reduce((total, row) => total + parseNumber(row[field.sourceField], field.sourceField), 0) / matchedRows.length,
          )
        : "";
      break;
    case "count":
      value = String(matchedRows.map((row) => asText(row[field.sourceField])).filter(Boolean).length);
      break;
    case "count_distinct":
      value = String(new Set(matchedRows.map((row) => asText(row[field.sourceField])).filter(Boolean)).size);
      break;
    case "mapping": {
      const sourceValues = field.mappingSourceFields.length > 0
        ? field.mappingSourceFields.map((name) => resolveFieldValue(bucket, firstRow, name))
        : [resolveFieldValue(bucket, firstRow, field.sourceField)];
      value = sourceValues.length > 1
        ? resolveMultiMappingValue(mappingIndexes, field.mappingGroupId, sourceValues)
        : resolveMappingValue(mappingIndexes, field.mappingGroupId, sourceValues[0] ?? "");
      if ((!asText(value) || value === UNKNOWN_FALLBACK) && field.fillConfig.enabled) {
        value = resolveFillValue(bucket, field, mappingIndexes, mappingGroups);
      }
      break;
    }
    case "expression":
      value = evaluateExpression(field.expressionText, matchedRows, firstRow, bucket.outputValues);
      break;
    case "fill":
      value = resolveFillValue(bucket, field, mappingIndexes, mappingGroups);
      break;
    case "text_aggregate":
      value = aggregateText(matchedRows, field);
      break;
    default:
      value = asText(firstRow[field.sourceField]);
      break;
  }

  if (!asText(value) || value === UNKNOWN_FALLBACK) {
    const fallbackValue = resolveFallbackValue(bucket, field, mappingIndexes, mappingGroups);
    if (asText(fallbackValue) || field.fallbackConfig.enabled) {
      value = fallbackValue;
    }
  }

  return finalizeOutputValue(field, value);
}

function resolveOutputFieldHeaderName(
  field: EngineRuleOutputField,
  sheetRows: WorkingRecord[],
  mappingIndexes: MappingIndexes,
): string {
  if (field.nameMode === "fixed") {
    return asText(field.fieldName) || "未命名字段";
  }

  const firstRecord = sheetRows.find((record) => record.sourceRows[field.nameSourceTableId]);
  const sourceRow = firstRecord?.sourceRows[field.nameSourceTableId] ?? {};
  if (field.nameMode === "source_field") {
    return asText(sourceRow?.[field.nameSourceField]) || asText(field.fieldName) || "未命名字段";
  }
  if (field.nameMode === "mapping") {
    const sourceValues = field.nameMappingSourceFields.map((name) => asText(sourceRow?.[name]));
    const mappedValue = sourceValues.length > 1
      ? resolveMultiMappingValue(mappingIndexes, field.nameMappingGroupId, sourceValues)
      : resolveMappingValue(mappingIndexes, field.nameMappingGroupId, sourceValues[0] ?? "");
    return mappedValue || asText(field.fieldName) || "未命名字段";
  }
  if (field.nameMode === "expression") {
    return evaluateExpression(field.nameExpressionText, sourceRow ? [sourceRow] : [], sourceRow, {}) || asText(field.fieldName) || "未命名字段";
  }
  return asText(field.fieldName) || "未命名字段";
}

function resolveOutputFieldSelectionLabel(
  field: EngineRuleOutputField,
  index: number,
  mappingGroups: readonly MappingGroup[],
): string {
  if (field.nameMode === "source_field") {
    return field.nameSourceField.trim() ? `{{${field.nameSourceField.trim()}}}` : `字段_${index + 1}`;
  }
  if (field.nameMode === "mapping") {
    const mappingName = mappingGroups.find((item) => item.id === field.nameMappingGroupId)?.name ?? "";
    return asText(mappingName) || `字段_${index + 1}`;
  }
  if (field.nameMode === "expression") {
    return field.nameExpressionText.trim() ? `=${field.nameExpressionText.trim()}` : `字段_${index + 1}`;
  }
  return asText(field.fieldName) || `字段_${index + 1}`;
}

function buildDynamicHeaderConfig(
  field: EngineRuleOutputField,
  baseLabel: string,
  sheetRows: WorkingRecord[],
): DynamicHeaderConfig {
  const values = new Set<string>();
  sheetRows.forEach((record) => {
    const row = record.sourceRows[field.sourceTableId];
    if (!row || !matchesOutputFilters(field, row)) {
      return;
    }
    const rawValue = asText(row[field.dynamicColumnConfig.columnField]);
    if (rawValue) {
      values.add(rawValue);
    }
  });

  const headerMap: Record<string, string> = {};
  const headers = Array.from(values)
    .sort((left, right) => compareText(left, right))
    .map((rawValue) => {
      const header = `${field.dynamicColumnConfig.namePrefix || ""}${rawValue}${field.dynamicColumnConfig.nameSuffix || ""}`;
      headerMap[rawValue] = header;
      return header;
    });

  return {
    fieldId: field.id,
    baseLabel,
    headers,
    headerMap,
  };
}

function buildUniqueHeaders(headers: string[]): { headers: string[]; headerMap: Record<string, string> } {
  const used = new Set<string>();
  const headerMap: Record<string, string> = {};
  const uniqueHeaders = headers.map((header) => {
    const baseHeader = asText(header) || "未命名字段";
    let candidate = baseHeader;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${baseHeader}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    headerMap[baseHeader] = candidate;
    return candidate;
  });
  return {
    headers: uniqueHeaders,
    headerMap,
  };
}

function renderTemplate(template: string, values: Record<string, string>): string {
  const normalized = asText(template);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => asText(values[asText(key)]));
}

function sanitizeSheetName(value: string): string {
  const normalized = asText(value).replace(/[:\\/?*\[\]]/g, "_").replace(/^'+|'+$/g, "");
  return (normalized || "Sheet").slice(0, 31);
}

function uniqueSheetName(name: string, usedNames: Set<string>): string {
  let candidate = sanitizeSheetName(name);
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }
  let index = 2;
  while (true) {
    const suffix = `_${index}`;
    candidate = `${sanitizeSheetName(name).slice(0, Math.max(0, 31 - suffix.length))}${suffix}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function appendTotalRow(
  headers: string[],
  rows: string[][],
  rule: EngineRuleDefinition,
  totalFieldGroups: Record<string, string[]>,
): string[][] {
  if (!rule.result.totalRow.enabled || headers.length === 0) {
    return rows;
  }

  const headerIndexMap = new Map(headers.map((header, index) => [header, index]));
  const totalRow = new Array<string>(headers.length).fill("");
  const totalRowOutputValues: Record<string, string> = {};
  const label = asText(rule.result.totalRow.label) || "总计";
  const labelField = asText(rule.result.totalRow.labelField);
  const labelCandidates = labelField ? [labelField, ...(totalFieldGroups[labelField] ?? [])] : [];
  const resolvedLabelField = labelCandidates.find((field) => headerIndexMap.has(field));
  if (resolvedLabelField && headerIndexMap.has(resolvedLabelField)) {
    totalRow[headerIndexMap.get(resolvedLabelField) ?? 0] = label;
    totalRowOutputValues[resolvedLabelField] = label;
  } else {
    totalRow[0] = label;
    if (headers[0]) {
      totalRowOutputValues[headers[0]] = label;
    }
  }

  const resolveTargetFields = (fieldName: string): string[] => {
    if (headerIndexMap.has(fieldName)) {
      return [fieldName];
    }
    return (totalFieldGroups[fieldName] ?? []).filter((candidateField) => headerIndexMap.has(candidateField));
  };

  const aggregateColumnValue = (columnIndex: number, config: EngineTotalRowFieldConfig): string => {
    if (config.aggregateMode === "fixed") {
      return asText(config.fixedValue);
    }
    if (config.aggregateMode === "expression") {
      return evaluateExpression(config.expressionText, [], {}, totalRowOutputValues);
    }

    const values = rows.map((row) => asText(row[columnIndex])).filter(Boolean);
    if (values.length === 0) {
      return "";
    }

    if (config.aggregateMode === "single_first") {
      return values[0] ?? "";
    }
    if (config.aggregateMode === "single_last") {
      return values[values.length - 1] ?? "";
    }

    let total = 0;
    let count = 0;
    values.forEach((cellValue) => {
      const parsed = Number(cellValue.replace(/,/g, ""));
      if (!Number.isFinite(parsed)) {
        return;
      }
      total += parsed;
      count += 1;
    });

    if (count === 0) {
      return "";
    }
    if (config.aggregateMode === "avg") {
      return formatNumber(total / count);
    }
    return formatNumber(total);
  };

  rule.result.totalRow.fieldConfigs.forEach((config) => {
    resolveTargetFields(config.fieldName).forEach((field) => {
      const columnIndex = headerIndexMap.get(field);
      if (columnIndex == null) {
        return;
      }
      totalRow[columnIndex] = aggregateColumnValue(columnIndex, config);
      totalRowOutputValues[field] = totalRow[columnIndex] ?? "";
    });
  });

  return [...rows, totalRow];
}

function buildEngineOutput(
  input: Pick<EngineProcessTaskInput, "rule" | "mappingGroups">,
  loadedSources: Record<string, EngineProcessLoadedSource>,
  workingRows: WorkingRecord[],
  mappingIndexes: MappingIndexes,
  options: EngineProcessTaskOptions,
): EngineOutput {
  options.onStage?.("build_result");
  log(options, "正在构建结果数据...");

  const dimensionLabels = input.rule.result.groupFields.map((field) => field.label);
  const visibleDimensionLabels = input.rule.result.groupFields
    .filter((field) => field.visible)
    .map((field) => field.label);
  const sourceOrder = input.rule.sources.map((source) => source.id);
  const baselineValues = resolveCompletionBaselineValues(input.rule, loadedSources, input.mappingGroups);
  const excludedSheetValues = resolveSheetValueExclusions(input.rule, input.mappingGroups);

  const sheetBuckets = new Map<string, WorkingRecord[]>();
  workingRows.forEach((record) => {
    const dimensionValues = buildDimensionValues(input.rule, record);
    let rawSheetName = "Sheet1";
    let splitValue = "";
    if (input.rule.result.sheetConfig.mode === "split_field") {
      if (input.rule.result.sheetConfig.splitFieldScope === "result_field") {
        splitValue = asText(dimensionValues[input.rule.result.sheetConfig.splitField]);
      } else {
        splitValue = resolveSourceValue(
          record,
          input.rule.result.sheetConfig.splitSourceTableId,
          input.rule.result.sheetConfig.splitField,
        );
      }
      if (splitValue && excludedSheetValues.has(splitValue)) {
        return;
      }
      rawSheetName = splitValue || "未命名Sheet";
      if (input.rule.result.sheetConfig.sheetNameTemplate.trim()) {
        rawSheetName = renderTemplate(input.rule.result.sheetConfig.sheetNameTemplate, dimensionValues) || rawSheetName;
      }
    } else {
      rawSheetName = input.rule.name.trim() || "Sheet1";
    }

    if (!sheetBuckets.has(rawSheetName)) {
      sheetBuckets.set(rawSheetName, []);
    }
    sheetBuckets.get(rawSheetName)?.push(record);
  });

  if (sheetBuckets.size === 0) {
    const defaultName = input.rule.name.trim() || "Sheet1";
    sheetBuckets.set(defaultName, []);
  }

  const sheets: EngineSheetOutput[] = [];
  const usedSheetNames = new Set<string>();
  let totalRowCount = 0;

  for (const [rawSheetName, recordsInSheet] of sheetBuckets.entries()) {
    const grouped = new Map<string, ResultBucket>();
    recordsInSheet.forEach((record) => {
      const dimensionValues = buildDimensionValues(input.rule, record);
      const key = buildGroupKeyByLabels(dimensionLabels, dimensionValues);
      const existing = grouped.get(key);
      if (existing) {
        existing.workingRows.push(record);
        return;
      }
      grouped.set(key, {
        key,
        dimensionValues,
        workingRows: [record],
        filled: false,
        outputValues: {},
        rowValues: [],
        mergedSourceValues: mergeSourceValues(record, sourceOrder),
      });
    });

    let resultBuckets = applyRowCompletion(input.rule, Array.from(grouped.values()), baselineValues);

    const dynamicHeaderConfigs = new Map<string, DynamicHeaderConfig>();
    const outputFieldLabelMap = new Map<string, string>();
    input.rule.outputFields.forEach((field, index) => {
      const baseLabel = resolveOutputFieldHeaderName(field, recordsInSheet, mappingIndexes) || `字段_${index + 1}`;
      outputFieldLabelMap.set(field.id, baseLabel);
      if (field.valueMode === "dynamic_columns" && field.dynamicColumnConfig.enabled) {
        dynamicHeaderConfigs.set(field.id, buildDynamicHeaderConfig(field, baseLabel, recordsInSheet));
      }
    });

    const headerSeeds = [...visibleDimensionLabels];
    const totalFieldGroups: Record<string, string[]> = {};
    input.rule.outputFields.forEach((field, index) => {
      const baseLabel = outputFieldLabelMap.get(field.id) ?? (field.fieldName || "未命名字段");
      const selectionLabel = resolveOutputFieldSelectionLabel(field, index, input.mappingGroups);
      if (field.valueMode === "dynamic_columns" && field.dynamicColumnConfig.enabled) {
        const config = dynamicHeaderConfigs.get(field.id);
        const headers = config?.headers ?? [];
        totalFieldGroups[baseLabel] = headers;
        totalFieldGroups[selectionLabel] = headers;
        headerSeeds.push(...headers);
        return;
      }
      totalFieldGroups[baseLabel] = [baseLabel];
      totalFieldGroups[selectionLabel] = [baseLabel];
      headerSeeds.push(baseLabel);
    });

    const { headers } = buildUniqueHeaders(headerSeeds);
    const finalTotalFieldGroups: Record<string, string[]> = {};
    Object.entries(totalFieldGroups).forEach(([groupName, values]) => {
      finalTotalFieldGroups[groupName] = values.map((header) => {
        const directHit = headers.find((item) => item === header);
        return directHit ?? header;
      });
    });

    resultBuckets.forEach((bucket) => {
      const outputValues: Record<string, string> = {};
      const maxPasses = Math.max(input.rule.outputFields.length, 1);
      for (let passIndex = 0; passIndex < maxPasses; passIndex += 1) {
        let changed = false;
        input.rule.outputFields.forEach((field, index) => {
          const baseLabel = outputFieldLabelMap.get(field.id) ?? (field.fieldName || "未命名字段");
          const selectionLabel = resolveOutputFieldSelectionLabel(field, index, input.mappingGroups);
          if (field.valueMode === "dynamic_columns" && field.dynamicColumnConfig.enabled) {
            const config = dynamicHeaderConfigs.get(field.id);
            (config?.headers ?? []).forEach((dynamicHeader) => {
              if (!(dynamicHeader in outputValues)) {
                outputValues[dynamicHeader] = "";
                changed = true;
              }
            });
            const matchedRows = extractMatchedSourceRows(bucket, field);
            const totals = new Map<string, number>();
            const hasNumber = new Set<string>();
            matchedRows.forEach((row) => {
              const rawKey = asText(row[field.dynamicColumnConfig.columnField]);
              if (!rawKey) {
                return;
              }
              const dynamicHeader = config?.headerMap[rawKey];
              if (!dynamicHeader) {
                return;
              }
              const rawValue = row[field.dynamicColumnConfig.valueField];
              const normalizedValue = asText(rawValue);
              if (!normalizedValue || normalizedValue === UNKNOWN_FALLBACK || normalizedValue === "-" || normalizedValue === "未知错误填充") {
                return;
              }
              const nextValue = parseNumber(rawValue, field.dynamicColumnConfig.valueField);
              totals.set(dynamicHeader, (totals.get(dynamicHeader) ?? 0) + nextValue);
              hasNumber.add(dynamicHeader);
            });
            Array.from(totals.entries()).forEach(([dynamicHeader, total]) => {
              if (hasNumber.has(dynamicHeader)) {
                const nextValue = formatNumber(total);
                if (outputValues[dynamicHeader] !== nextValue) {
                  outputValues[dynamicHeader] = nextValue;
                  changed = true;
                }
              }
            });
            totalFieldGroups[baseLabel] = config?.headers ?? [];
            totalFieldGroups[selectionLabel] = config?.headers ?? [];
            return;
          }
          if (field.valueMode === "dynamic_group_sum" || field.valueMode === "dynamic_group_avg") {
            let nextValue = resolveDynamicGroupAggregateValue(field, outputValues, dynamicHeaderConfigs);
            if (!asText(nextValue) || nextValue === UNKNOWN_FALLBACK) {
              const fallbackValue = resolveFallbackValue(
                { ...bucket, outputValues: { ...bucket.outputValues, ...outputValues } },
                field,
                mappingIndexes,
                input.mappingGroups,
              );
              if (asText(fallbackValue) || field.fallbackConfig.enabled) {
                nextValue = fallbackValue;
              }
            }
            nextValue = finalizeOutputValue(field, nextValue);
            if (outputValues[baseLabel] !== nextValue) {
              outputValues[baseLabel] = nextValue;
              changed = true;
            }
            return;
          }
          const nextValue = resolveScalarOutputValue(
            { ...bucket, outputValues: { ...bucket.outputValues, ...outputValues } },
            field,
            mappingIndexes,
            input.mappingGroups,
          );
          if (outputValues[baseLabel] !== nextValue) {
            outputValues[baseLabel] = nextValue;
            changed = true;
          }
        });
        if (!changed) {
          break;
        }
      }
      bucket.outputValues = outputValues;
      bucket.rowValues = headers.map((header) => {
        if (header in bucket.dimensionValues && visibleDimensionLabels.includes(header)) {
          return asText(bucket.dimensionValues[header]);
        }
        return asText(outputValues[header]);
      });
    });

    resultBuckets = [...resultBuckets].sort((left, right) => {
      for (const sortField of input.rule.result.sortFields) {
        const leftValue = asText(left.dimensionValues[sortField.fieldName] ?? left.outputValues[sortField.fieldName]);
        const rightValue = asText(right.dimensionValues[sortField.fieldName] ?? right.outputValues[sortField.fieldName]);
        const result = compareMaybeNumber(leftValue, rightValue);
        if (result !== 0) {
          return sortField.direction === "desc" ? -result : result;
        }
      }
      return compareText(left.key, right.key);
    });

    let rowMatrix = resultBuckets.map((bucket) => bucket.rowValues);
    rowMatrix = appendTotalRow(headers, rowMatrix, input.rule, finalTotalFieldGroups);

    const titleValues: Record<string, string[]> = {};
    resultBuckets.forEach((bucket) => {
      Object.entries(bucket.dimensionValues).forEach(([key, value]) => {
        if (!titleValues[key]) {
          titleValues[key] = [];
        }
        if (value) {
          titleValues[key].push(value);
        }
      });
      Object.entries(bucket.outputValues).forEach(([key, value]) => {
        if (!titleValues[key]) {
          titleValues[key] = [];
        }
        if (value) {
          titleValues[key].push(value);
        }
      });
      Object.entries(bucket.mergedSourceValues).forEach(([key, value]) => {
        if (!titleValues[key]) {
          titleValues[key] = [];
        }
        if (value) {
          titleValues[key].push(value);
        }
      });
    });

    const titleContext = Object.fromEntries(
      Object.entries(titleValues).map(([key, values]) => [key, Array.from(new Set(values)).join(" / ")]),
    );
    const sheetTitle = input.rule.sheetTemplate.titleEnabled
      ? renderTemplate(input.rule.sheetTemplate.titleTemplate, titleContext)
      : "";

    const sheetName = uniqueSheetName(rawSheetName, usedSheetNames);
    totalRowCount += rowMatrix.length;
    sheets.push({
      name: sheetName,
      title: sheetTitle,
      titleEnabled: input.rule.sheetTemplate.titleEnabled,
      totalRowEnabled: input.rule.result.totalRow.enabled,
      groupHeaderEnabled: false,
      groupHeaderLabel: "",
      groupHeaderStartColumnIndex: 0,
      headerRowIndex: input.rule.sheetTemplate.headerRowIndex,
      dataStartRowIndex: input.rule.sheetTemplate.dataStartRowIndex,
      reservedFooterRows: 0,
      headers,
      rows: rowMatrix,
      styleConfig: JSON.parse(JSON.stringify(input.rule.styleConfig)),
    });
  }

  log(options, `结果构建完成：${sheets.length} 个 Sheet，${totalRowCount} 行数据。`, "success");
  return {
    ok: true,
    sheetCount: sheets.length,
    rowCount: totalRowCount,
    sheets,
  };
}

export function runEngineProcessComputation(
  input: EngineProcessComputationInput,
  options: EngineProcessTaskOptions = {},
): EngineOutput {
  const mappingIndexes = buildMappingIndexes(input.mappingGroups);
  const workingRows = joinSources(input.rule, input.loadedSources, options);
  return buildEngineOutput(
    {
      rule: input.rule,
      mappingGroups: input.mappingGroups,
    },
    input.loadedSources,
    workingRows,
    mappingIndexes,
    options,
  );
}

async function computeEngineOutput(
  input: EngineProcessComputationInput,
  options: EngineProcessTaskOptions,
): Promise<EngineOutput> {
  const worker = getWorker();
  const workerInput = toWorkerSerializable(input);
  if (!worker) {
    return runEngineProcessComputation(workerInput, options);
  }

  return new Promise<EngineOutput>((resolve, reject) => {
    const handleMessage = (
      event: MessageEvent<EngineProcessWorkerSuccess | EngineProcessWorkerFailure | EngineProcessWorkerProgress>,
    ) => {
      if (event.data.ok === null) {
        if (event.data.stage) {
          options.onStage?.(event.data.stage);
        }
        if (event.data.log) {
          options.onLog?.(event.data.log.message, event.data.log.level);
        }
        return;
      }

      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);

      if (!event.data.ok) {
        reject(new Error(event.data.error || "结果构建失败。"));
        return;
      }

      resolve(event.data.engineOutput);
    };

    const handleError = (event: ErrorEvent) => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      reject(new Error(event.message || "结果构建失败。"));
    };

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({
      input: workerInput,
    } satisfies EngineProcessWorkerRequest);
  });
}

export async function runEngineProcessTask(
  input: EngineProcessTaskInput,
  options: EngineProcessTaskOptions = {},
): Promise<EngineProcessTaskResult> {
  const loadedSources = await loadSources(input, options);
  const engineOutput = await computeEngineOutput(
    {
      rule: input.rule,
      loadedSources,
      mappingGroups: input.mappingGroups,
    },
    options,
  );

  options.onStage?.("build_workbook");
  log(options, "正在生成输出工作簿...");
  const workbookBinary = await buildWorkbookBinary(engineOutput);

  options.onStage?.("resolve_output_path");
  log(options, "正在确定导出文件路径...");
  const outputSourceName = input.sources[0]?.fileName || input.rule.name || "output.xlsx";
  const outputPath = await resolveOutputPath(outputSourceName, input.rule.name, input.exportDirectory);

  options.onStage?.("write_output_file");
  log(options, "正在写入输出文件...");
  await writeBinaryToPath(outputPath, workbookBinary);

  return {
    outputPath,
    sheetCount: engineOutput.sheetCount,
    rowCount: engineOutput.rowCount,
    engineOutput,
  };
}
