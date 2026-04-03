<script setup lang="ts">
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { confirm } from "@tauri-apps/plugin-dialog";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useEngineRuleStore, useMappingStore } from "../store";
import {
  ENGINE_EMPTY_VALUE_POLICIES,
  ENGINE_OUTPUT_FALLBACK_MODES,
  ENGINE_OUTPUT_DATA_TYPES,
  ENGINE_OUTPUT_NAME_MODES,
  ENGINE_OUTPUT_VALUE_MODES,
  ENGINE_RELATION_JOIN_TYPES,
  ENGINE_RELATION_MULTI_MATCH_STRATEGIES,
  ENGINE_RESULT_COMPLETION_BASELINE_TYPES,
  ENGINE_RESULT_COMPLETION_MAPPING_VALUE_TYPES,
  ENGINE_RESULT_COMPLETION_MODES,
  ENGINE_TEXT_AGGREGATE_DELIMITER_MODES,
  ENGINE_RULE_TYPES,
  ENGINE_SHEET_MODES,
  ENGINE_SHEET_SPLIT_SCOPES,
  ENGINE_SORT_DIRECTIONS,
  ENGINE_SOURCE_FILTER_OPERATORS,
  cloneEngineRuleDefinition,
  createEmptyEngineOutputMatchCondition,
  createEmptyEngineResultGroupField,
  createEmptyEngineResultSortField,
  createEmptyEngineRuleDefinition,
  createEmptyEngineRuleOutputField,
  createEmptyEngineRuleSource,
  createEmptyEngineSourceRelation,
  createEmptyEngineSourceFilter,
  type EngineRuleDefinition,
  type EngineRuleOutputField,
  type EngineRuleSource,
  type EngineSourceRelation,
} from "../types/engineRule";
import { validateEngineRuleDraft } from "../utils/engineRuleValidator";
import { extractTitleTemplateVariables, toExcelColumnLabel } from "../utils/ruleTemplate";
import {
  buildSheetPreview,
  inferSheetHeaderLayout,
  parseSpreadsheetPath,
  readSpreadsheetSheetHeader,
  type SpreadsheetPreview,
  type SpreadsheetSheetData,
  type SpreadsheetSheetPreview,
} from "../utils/spreadsheetParser";

type EngineRuleEditorPayload = {
  ruleId: string | null;
};

type EditorPanelKey =
  | "basic"
  | "sources"
  | "relations"
  | "dimensions"
  | "rowCompletion"
  | "outputs"
  | "sheet"
  | "sheetTemplate"
  | "totalRow"
  | `source:${string}`
  | `relation:${string}`
  | `dimension:${string}`
  | `output:${string}`;

const MAIN_WINDOW_LABEL = "main";

const appWindow = getCurrentWindow();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { mappingGroups } = useMappingStore();
const { saveEngineRule, deleteEngineRule, getEngineRuleById, reloadEngineRules } = useEngineRuleStore();

const activeRuleId = ref("");
const draftRule = ref<EngineRuleDefinition>(createEmptyEngineRuleDefinition());
const validationErrors = ref<string[]>([]);
const actionMessage = ref("");
const isSaving = ref(false);
const activePanelKey = ref<EditorPanelKey>("basic");
const collapsedSidebarSections = ref<Record<string, boolean>>({
  sources: false,
  relations: false,
  dimensions: false,
  outputs: false,
  sheet: false,
});
const draggingOutputFieldId = ref("");
const dragOverOutputFieldId = ref("");
const dragOverOutputFieldPosition = ref<"before" | "after">("before");
const sourcePreviewMap = ref<Record<string, SpreadsheetPreview>>({});
const sourceSheetDataMap = ref<Record<string, SpreadsheetSheetData>>({});
const sourceSheetPreviewMap = ref<Record<string, SpreadsheetSheetPreview>>({});
const sourceLoadingMap = ref<Record<string, boolean>>({});

let unlistenSetRule: UnlistenFn | undefined;
let outputFieldDragCleanup: (() => void) | null = null;

const mappingOptions = computed(() =>
  mappingGroups.value.map((group) => ({
    id: group.id,
    name: group.name,
  })),
);

function formatSourceOptionLabel(source: EngineRuleSource, index: number): string {
  const normalizedIndex = index >= 0 ? index : 0;
  const parts = [t("engineRules.labels.sourceCard", { index: normalizedIndex + 1 })];
  if (source.sourceFileName.trim()) {
    parts.push(source.sourceFileName.trim());
  }
  if (source.sourceSheetName.trim()) {
    parts.push(source.sourceSheetName.trim());
  }
  return parts.join(" / ");
}

const sourceOptions = computed(() =>
  draftRule.value.sources.map((source, index) => ({
    id: source.id,
    label: formatSourceOptionLabel(source, index),
  })),
);

const resultFieldOptions = computed(() =>
  draftRule.value.result.groupFields
    .map((field) => field.label.trim())
    .filter(Boolean),
);

const splitFieldOptions = computed(() => {
  if (draftRule.value.result.sheetConfig.splitFieldScope === "source_field") {
    return fieldsForSourceId(draftRule.value.result.sheetConfig.splitSourceTableId);
  }
  return resultFieldOptions.value;
});

const rowCompletionSourceFieldOptions = computed(() =>
  fieldsForSourceId(draftRule.value.result.rowCompletion.sourceTableId),
);

const splitFieldDisplayLabel = computed(() => {
  if (draftRule.value.result.sheetConfig.mode !== "split_field") {
    return t("engineRules.sheetModes.single");
  }
  return draftRule.value.result.sheetConfig.splitField.trim() || t("engineRules.messages.selectSplitField");
});

type OutputFieldView = {
  id: string;
  label: string;
  status: "empty" | "partial" | "ready";
  valueMode: EngineRuleOutputField["valueMode"];
};

const outputFieldViews = computed<OutputFieldView[]>(() =>
  draftRule.value.outputFields.map((field, index) => ({
    id: field.id,
    label: resolveOutputFieldDisplayName(field, index),
    status: outputStatus(field),
    valueMode: field.valueMode,
  })),
);

const outputFieldLabelMap = computed(() =>
  Object.fromEntries(outputFieldViews.value.map((field) => [field.id, field.label])),
);

const outputFieldNameOptions = computed(() =>
  outputFieldViews.value.map((field) => field.label.trim()).filter(Boolean),
);

const sourceTemplateVariables = computed(() =>
  Array.from(
    new Set(
      draftRule.value.sources.flatMap((source) =>
        source.sourceHeaders.map((field) => field.trim()).filter(Boolean),
      ),
    ),
  ),
);

const resultTemplateVariables = computed(() =>
  Array.from(new Set([...resultFieldOptions.value, ...outputFieldNameOptions.value])),
);

const availableTemplateVariables = computed(() =>
  Array.from(new Set([...sourceTemplateVariables.value, ...resultTemplateVariables.value])),
);

const usedTemplateVariables = computed(() =>
  extractTitleTemplateVariables(draftRule.value.sheetTemplate.titleTemplate),
);

const previewOutputHeaders = computed(() =>
  outputFieldViews.value.map((field) => field.label),
);

const previewHeaders = computed(() => {
  const headers = [...previewOutputHeaders.value];
  return headers.length > 0 ? headers : [t("engineRules.fields.fieldName")];
});

const mergeRangeEndCell = computed(() => `${toExcelColumnLabel(Math.max(previewHeaders.value.length, 1))}1`);

const totalRowLabelFieldOptions = computed(() => outputFieldNameOptions.value);

const previewColumnCount = computed(() =>
  Math.max(previewHeaders.value.length, 13),
);

const sheetColumns = computed(() =>
  Array.from({ length: previewColumnCount.value }, (_, index) => toExcelColumnLabel(index + 1)),
);

const sheetBoardStyle = computed(() => ({
  "--sheet-column-count": `${previewColumnCount.value}`,
  "--sheet-row-count": `${sheetRows.value.length}`,
}));

const previewHeaderRowIndex = computed(() => {
  const value = Number(draftRule.value.sheetTemplate.headerRowIndex);
  if (!Number.isInteger(value) || value < 1) {
    return 2;
  }
  return draftRule.value.sheetTemplate.titleEnabled ? Math.max(value, 2) : value;
});

const previewDataRowIndex = computed(() => {
  const value = Number(draftRule.value.sheetTemplate.dataStartRowIndex);
  if (!Number.isInteger(value) || value < 1) {
    return previewHeaderRowIndex.value + 1;
  }
  return Math.max(value, previewHeaderRowIndex.value + 1);
});

const previewTotalRowIndex = computed(() => {
  if (!draftRule.value.result.totalRow.enabled) {
    return null;
  }
  return previewDataRowIndex.value + 1;
});

const sheetRows = computed(() => {
  const lastRow = Math.max(previewTotalRowIndex.value ?? 0, previewDataRowIndex.value + 4, 20);
  return Array.from({ length: lastRow }, (_, index) => index + 1);
});

const previewTitleText = computed(() =>
  draftRule.value.sheetTemplate.titleTemplate.trim() || draftRule.value.name.trim() || t("engineRules.library.unnamed"),
);

const previewTabs = computed(() => {
  if (draftRule.value.result.sheetConfig.mode === "split_field" && draftRule.value.result.sheetConfig.splitField.trim()) {
    return [
      draftRule.value.result.sheetConfig.sheetNameTemplate.trim() || `{{${splitFieldDisplayLabel.value}}}`,
      t("engineRules.editor.sheetTemplateTitle"),
      t("engineRules.editor.totalRowTitle"),
    ];
  }
  return ["Sheet1", t("engineRules.editor.sheetTemplateTitle"), t("engineRules.editor.totalRowTitle")];
});

type PreviewCell = {
  key: string;
  row: number;
  col: number;
  colSpan?: number;
  value: string;
  kind: "title" | "header" | "sample" | "total";
  panelKey?: EditorPanelKey;
  active?: boolean;
};

const previewCells = computed<PreviewCell[]>(() => {
  const cells: PreviewCell[] = [];
  const headerCount = previewHeaders.value.length;
  const titleSpan = Math.max(headerCount, 1);

  if (draftRule.value.sheetTemplate.titleEnabled) {
    cells.push({
      key: "title",
      row: 1,
      col: 1,
      colSpan: titleSpan,
      value: previewTitleText.value,
      kind: "title",
      panelKey: "sheetTemplate",
      active: panelMatches("sheetTemplate"),
    });
  }

  previewHeaders.value.forEach((header, index) => {
    const outputField = draftRule.value.outputFields[index] ?? null;
    const panelKey = outputField ? outputPanelKey(outputField.id) : "outputs";
    cells.push({
      key: `header-${index}`,
      row: previewHeaderRowIndex.value,
      col: index + 1,
      value: header,
      kind: "header",
      panelKey,
      active: panelMatches(panelKey),
    });
  });

  previewHeaders.value.forEach((_, index) => {
    const outputField = draftRule.value.outputFields[index] ?? null;
    let value = "--";
    if (outputField && outputField.dataType === "number") {
      value = "0";
    }
    if (outputField && outputField.dataType === "date") {
      value = formatPreviewDateValue(outputField.dateOutputFormat);
    }
    if (outputField && outputField.valueMode === "constant") {
      value = outputField.constantValue.trim() || "--";
    }
    if (outputField && outputField.valueMode === "text_aggregate") {
      value = "{文本聚合}";
    }
    if (outputField && outputField.valueMode === "dynamic_columns") {
      value = outputField.dynamicColumnConfig.columnField.trim()
        ? `{${outputField.dynamicColumnConfig.columnField.trim()}}`
        : "{动态列}";
    }
    cells.push({
      key: `sample-${index}`,
      row: previewDataRowIndex.value,
      col: index + 1,
      value,
      kind: "sample",
      panelKey: outputField ? outputPanelKey(outputField.id) : undefined,
      active: outputField ? panelMatches(outputPanelKey(outputField.id)) : false,
    });
  });

  if (previewTotalRowIndex.value) {
    const labelFieldIndex = draftRule.value.result.totalRow.labelField
      ? previewHeaders.value.findIndex((header) => header === draftRule.value.result.totalRow.labelField)
      : 0;
    const labelColumnIndex = labelFieldIndex >= 0 ? labelFieldIndex : 0;
    const totalLabel = draftRule.value.result.totalRow.label.trim() || t("engineRules.defaults.totalRowLabel");

    cells.push({
      key: "total-label",
      row: previewTotalRowIndex.value,
      col: labelColumnIndex + 1,
      value: totalLabel,
      kind: "total",
      panelKey: "totalRow",
      active: panelMatches("totalRow"),
    });

    previewHeaders.value.forEach((header, index) => {
      if (index === labelColumnIndex) {
        return;
      }
      if (draftRule.value.result.totalRow.sumFields.includes(header)) {
        cells.push({
          key: `total-sum-${index}`,
          row: previewTotalRowIndex.value as number,
          col: index + 1,
          value: "0",
          kind: "total",
          panelKey: "totalRow",
          active: panelMatches("totalRow"),
        });
      }
    });
  }

  return cells;
});

const activeSource = computed(() => {
  if (!activePanelKey.value.startsWith("source:")) {
    return null;
  }
  const sourceId = activePanelKey.value.slice("source:".length);
  return draftRule.value.sources.find((source) => source.id === sourceId) ?? null;
});

const activeRelation = computed(() => {
  if (!activePanelKey.value.startsWith("relation:")) {
    return null;
  }
  const relationId = activePanelKey.value.slice("relation:".length);
  return draftRule.value.relations.find((relation) => relation.id === relationId) ?? null;
});

const activeDimension = computed(() => {
  if (!activePanelKey.value.startsWith("dimension:")) {
    return null;
  }
  const fieldId = activePanelKey.value.slice("dimension:".length);
  return draftRule.value.result.groupFields.find((field) => field.id === fieldId) ?? null;
});

const activeOutput = computed(() => {
  if (!activePanelKey.value.startsWith("output:")) {
    return null;
  }
  const fieldId = activePanelKey.value.slice("output:".length);
  return draftRule.value.outputFields.find((field) => field.id === fieldId) ?? null;
});

function resetFeedback(): void {
  validationErrors.value = [];
  actionMessage.value = "";
}

function setActivePanel(key: EditorPanelKey): void {
  activePanelKey.value = key;
}

function isSidebarSectionCollapsed(sectionKey: string): boolean {
  return Boolean(collapsedSidebarSections.value[sectionKey]);
}

function toggleSidebarSection(sectionKey: string): void {
  collapsedSidebarSections.value[sectionKey] = !collapsedSidebarSections.value[sectionKey];
}

function panelMatches(key: EditorPanelKey): boolean {
  return activePanelKey.value === key;
}

function handlePreviewCellClick(cell: PreviewCell): void {
  if (!cell.panelKey) {
    return;
  }
  setActivePanel(cell.panelKey);
}

function sourcePanelKey(sourceId: string): EditorPanelKey {
  return `source:${sourceId}`;
}

function relationPanelKey(relationId: string): EditorPanelKey {
  return `relation:${relationId}`;
}

function dimensionPanelKey(fieldId: string): EditorPanelKey {
  return `dimension:${fieldId}`;
}

function outputPanelKey(fieldId: string): EditorPanelKey {
  return `output:${fieldId}`;
}

function setDraftRule(rule: EngineRuleDefinition): void {
  draftRule.value = cloneEngineRuleDefinition(rule);
  activePanelKey.value = "basic";
  if (draftRule.value.sources.length === 0) {
    draftRule.value.sources = [createEmptyEngineRuleSource()];
  }
  if (draftRule.value.result.groupFields.length === 0) {
    draftRule.value.result.groupFields = [createEmptyEngineResultGroupField()];
  }
  if (draftRule.value.outputFields.length === 0) {
    draftRule.value.outputFields = [createEmptyEngineRuleOutputField()];
  }
}

function rowCompletionStatus(): "empty" | "partial" | "ready" {
  const config = draftRule.value.result.rowCompletion;
  if (!config.enabled) {
    return "empty";
  }
  if (!config.targetField.trim()) {
    return "partial";
  }
  if (config.baselineType === "source_table") {
    return config.sourceTableId.trim() && config.sourceField.trim() ? "ready" : "partial";
  }
  if (config.baselineType === "mapping_group") {
    return config.mappingGroupId.trim() ? "ready" : "partial";
  }
  if (config.baselineType === "manual_values") {
    return config.manualValuesText.trim() ? "ready" : "partial";
  }
  return "partial";
}

function sheetSectionStatus(): "empty" | "partial" | "ready" {
  const sheetReady =
    draftRule.value.result.sheetConfig.mode !== "split_field" || Boolean(draftRule.value.result.sheetConfig.splitField.trim());
  const templateStatus = draftRule.value.sheetTemplate.titleEnabled ? "ready" : "empty";
  if (sheetReady && templateStatus === "ready") {
    return "ready";
  }
  if (sheetReady || templateStatus !== "empty") {
    return "partial";
  }
  return "empty";
}

const currentPanelTitle = computed(() => {
  if (activePanelKey.value === "basic") {
    return t("engineRules.editor.basicTitle");
  }
  if (activePanelKey.value === "sources") {
    return t("engineRules.editor.sourcesTitle");
  }
  if (activePanelKey.value === "relations") {
    return t("engineRules.editor.relationsTitle");
  }
  if (activePanelKey.value === "dimensions") {
    return t("engineRules.editor.resultTitle");
  }
  if (activePanelKey.value === "rowCompletion") {
    return t("engineRules.editor.rowCompletionTitle");
  }
  if (activePanelKey.value === "outputs") {
    return t("engineRules.editor.outputTitle");
  }
  if (activePanelKey.value === "sheet") {
    return t("engineRules.editor.sheetTitle");
  }
  if (activePanelKey.value === "sheetTemplate") {
    return t("engineRules.editor.sheetTemplateTitle");
  }
  if (activePanelKey.value === "totalRow") {
    return t("engineRules.editor.totalRowTitle");
  }
  if (activeSource.value) {
    return formatSourceOptionLabel(
      activeSource.value,
      draftRule.value.sources.findIndex((item) => item.id === activeSource.value?.id),
    );
  }
  if (activeRelation.value) {
    return relationLabel(
      activeRelation.value,
      draftRule.value.relations.findIndex((item) => item.id === activeRelation.value?.id),
    );
  }
  if (activeDimension.value) {
    return activeDimension.value.label.trim() || t("engineRules.labels.dimensionFallback", {
      index: draftRule.value.result.groupFields.findIndex((item) => item.id === activeDimension.value?.id) + 1,
    });
  }
  if (activeOutput.value) {
    return outputFieldLabelMap.value[activeOutput.value.id] ?? t("engineRules.editor.windowTitle");
  }
  return t("engineRules.editor.windowTitle");
});

const currentPanelDescription = computed(() => {
  if (activePanelKey.value === "sources") {
    return t("engineRules.messages.sourcesHint");
  }
  if (activePanelKey.value === "relations") {
    return t("engineRules.messages.relationsHint");
  }
  if (activePanelKey.value === "dimensions") {
    return t("engineRules.messages.resultHint");
  }
  if (activePanelKey.value === "rowCompletion") {
    return t("engineRules.messages.rowCompletionHint");
  }
  if (activePanelKey.value === "outputs") {
    return t("engineRules.messages.outputHint");
  }
  if (activePanelKey.value === "sheet") {
    return t("engineRules.messages.sheetHint");
  }
  if (activePanelKey.value === "sheetTemplate") {
    return t("engineRules.messages.sheetTemplateHint");
  }
  if (activePanelKey.value === "totalRow") {
    return t("engineRules.messages.totalRowHint");
  }
  return "";
});

function parseFieldsText(value: string): string[] {
  return Array.from(new Set(value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean)));
}

function insertTitleVariable(variableKey: string): void {
  const token = `{{${variableKey}}}`;
  const current = draftRule.value.sheetTemplate.titleTemplate.trimEnd();
  draftRule.value.sheetTemplate.titleTemplate = current ? `${current} ${token}` : token;
}

function fieldsForSourceId(sourceId: string): string[] {
  const source = draftRule.value.sources.find((item) => item.id === sourceId);
  if (!source) {
    return [];
  }
  return source.sourceHeaders;
}

function fieldsForOutputField(field: EngineRuleOutputField): string[] {
  return fieldsForSourceId(field.sourceTableId);
}

function fieldsForOutputName(field: EngineRuleOutputField): string[] {
  return fieldsForSourceId(field.nameSourceTableId);
}

function fieldsForRelationSource(sourceId: string): string[] {
  return fieldsForSourceId(sourceId);
}

function resolveOutputFieldDisplayName(field: EngineRuleOutputField, index: number): string {
  if (field.nameMode === "source_field") {
    return field.nameSourceField.trim() ? `{{${field.nameSourceField.trim()}}}` : t("engineRules.labels.outputCard", { index: index + 1 });
  }
  if (field.nameMode === "mapping") {
    const mappingName = mappingOptions.value.find((item) => item.id === field.nameMappingGroupId)?.name ?? "";
    return mappingName ? `${mappingName}` : t("engineRules.labels.outputCard", { index: index + 1 });
  }
  if (field.nameMode === "expression") {
    return field.nameExpressionText.trim() ? `=${field.nameExpressionText.trim()}` : t("engineRules.labels.outputCard", { index: index + 1 });
  }
  return field.fieldName.trim() || t("engineRules.labels.outputCard", { index: index + 1 });
}

function relationSourceLabel(sourceId: string): string {
  const index = draftRule.value.sources.findIndex((source) => source.id === sourceId);
  if (index < 0) {
    return t("engineRules.labels.unset");
  }
  return formatSourceOptionLabel(draftRule.value.sources[index], index);
}

function formatPreviewDateValue(format: string): string {
  const normalized = format.trim() || "YYYY/M/D";
  return normalized
    .replace(/YYYY/g, "2026")
    .replace(/MM/g, "03")
    .replace(/DD/g, "26")
    .replace(/M/g, "3")
    .replace(/D/g, "26");
}

function dimensionLabel(fieldId: string): string {
  const field = draftRule.value.result.groupFields.find((item) => item.id === fieldId);
  if (!field) {
    return t("engineRules.labels.unset");
  }
  return field.label.trim() || t("engineRules.labels.dimensionFallback", {
    index: draftRule.value.result.groupFields.findIndex((item) => item.id === fieldId) + 1,
  });
}

function dimensionVisibilityLabel(visible: boolean): string {
  return visible ? t("engineRules.labels.visible") : t("engineRules.labels.hidden");
}

function relationLabel(relation: EngineSourceRelation, index: number): string {
  if (relation.leftSourceId && relation.rightSourceId) {
    return `${relationSourceLabel(relation.leftSourceId)} -> ${relationSourceLabel(relation.rightSourceId)}`;
  }
  return t("engineRules.labels.relationCard", { index: index + 1 });
}

function sourceStatus(source: EngineRuleSource): "empty" | "partial" | "ready" {
  if (!source.sourceFileName && !source.sourceSheetName && source.sourceHeaders.length === 0) {
    return "empty";
  }
  if (source.sourceFileName && source.sourceSheetName && source.sourceHeaders.length > 0) {
    return "ready";
  }
  return "partial";
}

function relationStatus(relation: EngineSourceRelation): "empty" | "partial" | "ready" {
  if (!relation.leftSourceId && !relation.rightSourceId && !relation.leftField && !relation.rightField) {
    return "empty";
  }
  if (relation.leftSourceId && relation.rightSourceId && relation.leftField && relation.rightField) {
    return "ready";
  }
  return "partial";
}

function dimensionStatus(fieldId: string): "empty" | "partial" | "ready" {
  const field = draftRule.value.result.groupFields.find((item) => item.id === fieldId);
  if (!field) {
    return "empty";
  }
  if (!field.label && !field.sourceTableId && !field.sourceField) {
    return "empty";
  }
  if (field.label && field.sourceTableId && field.sourceField) {
    return "ready";
  }
  return "partial";
}

function outputStatus(field: EngineRuleOutputField): "empty" | "partial" | "ready" {
  if (
    !field.fieldName &&
    !field.nameSourceField &&
    !field.nameExpressionText &&
    !field.sourceTableId &&
    !field.sourceField &&
    !field.expressionText &&
    !field.constantValue
  ) {
    return "empty";
  }
  const nameConfigured =
    (field.nameMode === "fixed" && field.fieldName.trim()) ||
    (field.nameMode === "source_field" && field.nameSourceTableId.trim() && field.nameSourceField.trim()) ||
    (field.nameMode === "mapping" &&
      field.nameSourceTableId.trim() &&
      field.nameMappingGroupId.trim() &&
      field.nameMappingSourceFields.length > 0) ||
    (field.nameMode === "expression" && field.nameExpressionText.trim());
  if (!nameConfigured) {
    return "partial";
  }
  if (field.valueMode === "expression") {
    if (!field.expressionText.trim()) {
      return "partial";
    }
    if (field.dataType === "date" && !field.dateOutputFormat.trim()) {
      return "partial";
    }
    return fallbackStatus(field);
  }
  if (field.valueMode === "constant") {
    if (!field.constantValue.trim()) {
      return "partial";
    }
    if (field.dataType === "date" && !field.dateOutputFormat.trim()) {
      return "partial";
    }
    return fallbackStatus(field);
  }
  if (!field.sourceTableId) {
    return "partial";
  }
  if (field.valueMode === "mapping") {
    const ready = field.mappingGroupId && (field.mappingSourceFields.length > 0 || field.sourceField.trim());
    if (!ready) {
      return "partial";
    }
    if (field.dataType === "date" && !field.dateOutputFormat.trim()) {
      return "partial";
    }
    return fallbackStatus(field);
  }
  if (field.valueMode === "fill") {
    if (field.dataType === "date" && !field.dateOutputFormat.trim()) {
      return "partial";
    }
    return fallbackStatus(field);
  }
  if (field.valueMode === "text_aggregate") {
    if (
      field.textAggregateConfig.delimiterMode === "custom" &&
      !field.textAggregateConfig.customDelimiter.trim()
    ) {
      return "partial";
    }
    if (!field.sourceField.trim()) {
      return "partial";
    }
    if (field.dataType === "date" && !field.dateOutputFormat.trim()) {
      return "partial";
    }
    return fallbackStatus(field);
  }
  if (field.valueMode === "dynamic_columns") {
    if (!(field.dynamicColumnConfig.columnField && field.dynamicColumnConfig.valueField)) {
      return "partial";
    }
    return fallbackStatus(field);
  }
  if (!field.sourceField.trim()) {
    return "partial";
  }
  if (field.dataType === "date" && !field.dateOutputFormat.trim()) {
    return "partial";
  }
  return fallbackStatus(field);
}

function fallbackStatus(field: EngineRuleOutputField): "partial" | "ready" {
  if (!field.fallbackConfig.enabled) {
    return "ready";
  }
  if (field.fallbackConfig.mode === "empty") {
    return "ready";
  }
  if (field.fallbackConfig.mode === "constant") {
    return field.fallbackConfig.constantValue.trim() ? "ready" : "partial";
  }
  if (field.fallbackConfig.mode === "baseline") {
    return field.fallbackConfig.baselineField.trim() ? "ready" : "partial";
  }
  if (field.fallbackConfig.mode === "mapping") {
    return field.fallbackConfig.baselineField.trim() && field.fallbackConfig.mappingGroupId.trim()
      ? "ready"
      : "partial";
  }
  return "ready";
}

function sectionStatus(count: number, readyCount: number): "empty" | "partial" | "ready" {
  if (count === 0 || readyCount === 0) {
    return count === 0 ? "empty" : "partial";
  }
  return readyCount === count ? "ready" : "partial";
}

const sourceReadyCount = computed(() =>
  draftRule.value.sources.filter((source) => sourceStatus(source) === "ready").length,
);

const relationReadyCount = computed(() =>
  draftRule.value.relations.filter((relation) => relationStatus(relation) === "ready").length,
);

const dimensionReadyCount = computed(() =>
  draftRule.value.result.groupFields.filter((field) => dimensionStatus(field.id) === "ready").length,
);

const outputReadyCount = computed(() =>
  outputFieldViews.value.filter((field) => field.status === "ready").length,
);

function toggleMappingSourceField(field: EngineRuleOutputField, fieldName: string): void {
  if (field.mappingSourceFields.includes(fieldName)) {
    field.mappingSourceFields = field.mappingSourceFields.filter((item) => item !== fieldName);
    return;
  }
  field.mappingSourceFields = [...field.mappingSourceFields, fieldName];
}

function toggleOutputNameMappingSourceField(field: EngineRuleOutputField, fieldName: string): void {
  if (field.nameMappingSourceFields.includes(fieldName)) {
    field.nameMappingSourceFields = field.nameMappingSourceFields.filter((item) => item !== fieldName);
    return;
  }
  field.nameMappingSourceFields = [...field.nameMappingSourceFields, fieldName];
}

function ensureSingleTableLimit(): void {
  if (draftRule.value.ruleType === "single_table" && draftRule.value.sources.length > 1) {
    draftRule.value.sources = [draftRule.value.sources[0]];
  }
  if (draftRule.value.ruleType === "single_table" && draftRule.value.relations.length > 0) {
    draftRule.value.relations = [];
  }
}

function addSource(): void {
  if (draftRule.value.ruleType === "single_table" && draftRule.value.sources.length >= 1) {
    return;
  }
  const nextSource = createEmptyEngineRuleSource();
  draftRule.value.sources = [...draftRule.value.sources, nextSource];
  setActivePanel(sourcePanelKey(nextSource.id));
}

function removeSource(sourceId: string): void {
  const next = draftRule.value.sources.filter((source) => source.id !== sourceId);
  draftRule.value.sources = next.length > 0 ? next : [createEmptyEngineRuleSource()];
  draftRule.value.relations = draftRule.value.relations.filter(
    (relation) => relation.leftSourceId !== sourceId && relation.rightSourceId !== sourceId,
  );
  draftRule.value.result.groupFields = draftRule.value.result.groupFields.map((field) => ({
    ...field,
    sourceTableId: field.sourceTableId === sourceId ? "" : field.sourceTableId,
  }));
  if (draftRule.value.result.rowCompletion.sourceTableId === sourceId) {
    draftRule.value.result.rowCompletion.sourceTableId = "";
    draftRule.value.result.rowCompletion.sourceField = "";
  }
  draftRule.value.outputFields = draftRule.value.outputFields.map((field) => ({
    ...field,
    sourceTableId: field.sourceTableId === sourceId ? "" : field.sourceTableId,
    nameSourceTableId: field.nameSourceTableId === sourceId ? "" : field.nameSourceTableId,
  }));
  delete sourcePreviewMap.value[sourceId];
  delete sourceSheetDataMap.value[sourceId];
  delete sourceSheetPreviewMap.value[sourceId];
  delete sourceLoadingMap.value[sourceId];
  if (activePanelKey.value === sourcePanelKey(sourceId)) {
    setActivePanel("sources");
  }
}

function addSourceFilter(source: EngineRuleSource): void {
  source.preFilters = [...source.preFilters, createEmptyEngineSourceFilter()];
}

function removeSourceFilter(source: EngineRuleSource, filterId: string): void {
  source.preFilters = source.preFilters.filter((filter) => filter.id !== filterId);
}

function addResultGroupField(): void {
  const nextField = createEmptyEngineResultGroupField();
  draftRule.value.result.groupFields = [
    ...draftRule.value.result.groupFields,
    nextField,
  ];
  setActivePanel(dimensionPanelKey(nextField.id));
}

function removeResultGroupField(fieldId: string): void {
  const next = draftRule.value.result.groupFields.filter((field) => field.id !== fieldId);
  draftRule.value.result.groupFields = next.length > 0 ? next : [createEmptyEngineResultGroupField()];
  if (activePanelKey.value === dimensionPanelKey(fieldId)) {
    setActivePanel("dimensions");
  }
}

function addSortField(): void {
  draftRule.value.result.sortFields = [
    ...draftRule.value.result.sortFields,
    createEmptyEngineResultSortField(),
  ];
}

function removeSortField(fieldId: string): void {
  draftRule.value.result.sortFields = draftRule.value.result.sortFields.filter((field) => field.id !== fieldId);
}

function addRelation(): void {
  const nextRelation = createEmptyEngineSourceRelation();
  draftRule.value.relations = [...draftRule.value.relations, nextRelation];
  setActivePanel(relationPanelKey(nextRelation.id));
}

function removeRelation(relationId: string): void {
  draftRule.value.relations = draftRule.value.relations.filter((relation) => relation.id !== relationId);
  if (activePanelKey.value === relationPanelKey(relationId)) {
    setActivePanel("relations");
  }
}

function addOutputField(): void {
  const nextField = createEmptyEngineRuleOutputField();
  draftRule.value.outputFields.push(nextField);
  setActivePanel(outputPanelKey(nextField.id));
}

function removeOutputField(fieldId: string): void {
  const targetIndex = draftRule.value.outputFields.findIndex((field) => field.id === fieldId);
  if (targetIndex >= 0) {
    draftRule.value.outputFields.splice(targetIndex, 1);
  }
  if (draftRule.value.outputFields.length === 0) {
    draftRule.value.outputFields.push(createEmptyEngineRuleOutputField());
  }
  if (activePanelKey.value === outputPanelKey(fieldId)) {
    setActivePanel("outputs");
  }
}

function moveOutputField(fromId: string, toId: string, position: "before" | "after"): void {
  if (!fromId || !toId || fromId === toId) {
    return;
  }
  const fields = draftRule.value.outputFields;
  const fromIndex = fields.findIndex((field) => field.id === fromId);
  const toIndex = fields.findIndex((field) => field.id === toId);
  if (fromIndex < 0 || toIndex < 0) {
    return;
  }

  const [movedField] = fields.splice(fromIndex, 1);
  const adjustedTargetIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
  const insertIndex = position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex;
  fields.splice(insertIndex, 0, movedField);
}

function resetOutputFieldDragState(): void {
  draggingOutputFieldId.value = "";
  dragOverOutputFieldId.value = "";
  dragOverOutputFieldPosition.value = "before";
}

function finishOutputFieldDrag(): void {
  outputFieldDragCleanup?.();
  outputFieldDragCleanup = null;
  resetOutputFieldDragState();
}

function handleOutputFieldDragMove(event: MouseEvent): void {
  if (!draggingOutputFieldId.value) {
    return;
  }
  const hoveredElement = document.elementFromPoint(event.clientX, event.clientY);
  const targetCard = hoveredElement instanceof HTMLElement ? hoveredElement.closest<HTMLElement>("[data-output-field-id]") : null;
  const targetFieldId = targetCard?.dataset.outputFieldId ?? "";

  if (!targetFieldId || targetFieldId === draggingOutputFieldId.value || !targetCard) {
    dragOverOutputFieldId.value = "";
    return;
  }

  const { top, height } = targetCard.getBoundingClientRect();
  const nextPosition = event.clientY - top > height / 2 ? "after" : "before";

  if (
    dragOverOutputFieldId.value === targetFieldId &&
    dragOverOutputFieldPosition.value === nextPosition
  ) {
    return;
  }

  dragOverOutputFieldId.value = targetFieldId;
  dragOverOutputFieldPosition.value = nextPosition;
  moveOutputField(draggingOutputFieldId.value, targetFieldId, nextPosition);
}

function handleOutputFieldDragStart(event: MouseEvent, fieldId: string): void {
  event.preventDefault();
  event.stopPropagation();

  finishOutputFieldDrag();
  draggingOutputFieldId.value = fieldId;
  dragOverOutputFieldId.value = "";
  dragOverOutputFieldPosition.value = "before";

  const handleMouseMove = (moveEvent: MouseEvent) => {
    handleOutputFieldDragMove(moveEvent);
  };

  const handleMouseUp = () => {
    setActivePanel(outputPanelKey(fieldId));
    finishOutputFieldDrag();
  };

  window.addEventListener("mousemove", handleMouseMove);
  window.addEventListener("mouseup", handleMouseUp, { once: true });
  outputFieldDragCleanup = () => {
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", handleMouseUp);
  };
}

function handleOutputFieldCardClick(fieldId: string): void {
  if (draggingOutputFieldId.value) {
    return;
  }
  setActivePanel(outputPanelKey(fieldId));
}

function addOutputMatchCondition(field: EngineRuleOutputField): void {
  field.matchConditions = [...field.matchConditions, createEmptyEngineOutputMatchCondition()];
}

function removeOutputMatchCondition(field: EngineRuleOutputField, conditionId: string): void {
  field.matchConditions = field.matchConditions.filter((condition) => condition.id !== conditionId);
}

function addOutputFilter(field: EngineRuleOutputField): void {
  field.filters = [...field.filters, createEmptyEngineSourceFilter()];
}

function removeOutputFilter(field: EngineRuleOutputField, filterId: string): void {
  field.filters = field.filters.filter((filter) => filter.id !== filterId);
}

function toggleTotalRowSumField(fieldName: string): void {
  if (draftRule.value.result.totalRow.sumFields.includes(fieldName)) {
    draftRule.value.result.totalRow.sumFields = draftRule.value.result.totalRow.sumFields.filter((item) => item !== fieldName);
    return;
  }
  draftRule.value.result.totalRow.sumFields = [...draftRule.value.result.totalRow.sumFields, fieldName];
}

function handleValueModeChange(field: EngineRuleOutputField): void {
  if (field.valueMode !== "constant") {
    field.constantValue = "";
  }
  if (field.valueMode !== "expression") {
    field.expressionText = "";
  }
  if (field.valueMode !== "mapping") {
    field.mappingGroupId = "";
    field.mappingSourceFields = [];
  }
  if (field.valueMode !== "fill") {
    field.fillConfig.enabled = false;
    field.fillConfig.baselineField = "";
    field.fillConfig.mappingGroupId = "";
    field.fillConfig.constantValue = "";
  } else {
    field.fillConfig.enabled = true;
  }
  if (field.valueMode !== "text_aggregate") {
    field.textAggregateConfig.delimiterMode = "newline";
    field.textAggregateConfig.customDelimiter = "";
    field.textAggregateConfig.distinct = true;
    field.textAggregateConfig.sortField = "";
    field.textAggregateConfig.sortDirection = "asc";
  }
  if (field.valueMode !== "dynamic_columns") {
    field.dynamicColumnConfig.enabled = false;
    field.dynamicColumnConfig.columnField = "";
    field.dynamicColumnConfig.valueField = "";
    field.dynamicColumnConfig.namePrefix = "";
    field.dynamicColumnConfig.nameSuffix = "";
  } else {
    field.dynamicColumnConfig.enabled = true;
  }
}

function handleFallbackModeChange(field: EngineRuleOutputField): void {
  if (field.fallbackConfig.mode !== "constant") {
    field.fallbackConfig.constantValue = "";
  }
  if (field.fallbackConfig.mode !== "baseline" && field.fallbackConfig.mode !== "mapping") {
    field.fallbackConfig.baselineField = "";
  }
  if (field.fallbackConfig.mode !== "mapping") {
    field.fallbackConfig.mappingGroupId = "";
  }
}

function handleOutputNameModeChange(field: EngineRuleOutputField): void {
  if (field.nameMode !== "fixed") {
    field.fieldName = "";
  }
  if (field.nameMode !== "source_field") {
    field.nameSourceField = "";
  }
  if (field.nameMode !== "mapping") {
    field.nameMappingGroupId = "";
    field.nameMappingSourceFields = [];
  }
  if (field.nameMode !== "expression") {
    field.nameExpressionText = "";
  }
}

function setSourceLoading(sourceId: string, loading: boolean): void {
  sourceLoadingMap.value = {
    ...sourceLoadingMap.value,
    [sourceId]: loading,
  };
}

function getSourcePreview(sourceId: string): SpreadsheetPreview | null {
  return sourcePreviewMap.value[sourceId] ?? null;
}

function getSourceSheetPreview(sourceId: string): SpreadsheetSheetPreview | null {
  return sourceSheetPreviewMap.value[sourceId] ?? null;
}

function normalizeSourceLayout(source: EngineRuleSource): {
  headerRowIndex: number;
  groupHeaderRowIndex: number;
} {
  const parsedHeaderRowIndex = Number(source.sourceHeaderRowIndex);
  const parsedGroupHeaderRowIndex = Number(source.sourceGroupHeaderRowIndex);
  return {
    headerRowIndex:
      Number.isInteger(parsedHeaderRowIndex) && parsedHeaderRowIndex > 0 ? parsedHeaderRowIndex : 1,
    groupHeaderRowIndex:
      Number.isInteger(parsedGroupHeaderRowIndex) && parsedGroupHeaderRowIndex >= 0
        ? parsedGroupHeaderRowIndex
        : 0,
  };
}

function refreshSourceSheetPreview(source: EngineRuleSource, sheetData?: SpreadsheetSheetData | null): void {
  const targetSheetData = sheetData ?? sourceSheetDataMap.value[source.id] ?? null;
  if (!targetSheetData) {
    return;
  }

  const layout = normalizeSourceLayout(source);
  source.sourceHeaderRowIndex = layout.headerRowIndex;
  source.sourceGroupHeaderRowIndex = layout.groupHeaderRowIndex;

  const sheetPreview = buildSheetPreview(targetSheetData, {
    headerRowIndex: layout.headerRowIndex,
    groupHeaderRowIndex: layout.groupHeaderRowIndex,
  });

  source.sourceHeaders = [...sheetPreview.headers];
  sourceSheetDataMap.value = {
    ...sourceSheetDataMap.value,
    [source.id]: targetSheetData,
  };
  sourceSheetPreviewMap.value = {
    ...sourceSheetPreviewMap.value,
    [source.id]: sheetPreview,
  };
}

async function applySourceSheet(source: EngineRuleSource, sheetName: string): Promise<void> {
  const preview = getSourcePreview(source.id);
  if (!preview) {
    return;
  }
  const sheetHeader = await readSpreadsheetSheetHeader(preview.datasetId, sheetName);
  const inferredLayout = inferSheetHeaderLayout(sheetHeader);

  source.sourceSheetName = sheetName;
  source.sourceHeaderRowIndex = inferredLayout.headerRowIndex;
  source.sourceGroupHeaderRowIndex = inferredLayout.groupHeaderRowIndex;
  refreshSourceSheetPreview(source, sheetHeader);
}

async function handleUploadSource(source: EngineRuleSource): Promise<void> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Spreadsheet",
        extensions: ["xlsx", "xls", "csv"],
      },
    ],
  });
  if (!selected || Array.isArray(selected)) {
    return;
  }

  setSourceLoading(source.id, true);
  try {
    const preview = await parseSpreadsheetPath(selected);
    source.sourceFileName = preview.fileName;
    source.sourceSheetName = "";
    source.sourceHeaderRowIndex = 1;
    source.sourceGroupHeaderRowIndex = 0;
    source.sourceHeaders = [];
    sourcePreviewMap.value = {
      ...sourcePreviewMap.value,
      [source.id]: preview,
    };
    delete sourceSheetDataMap.value[source.id];
    delete sourceSheetPreviewMap.value[source.id];

    if (preview.sheets.length > 0) {
      await applySourceSheet(source, preview.sheets[0].name);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    validationErrors.value = [t("engineRules.messages.sourceUploadFailed", {
      name: formatSourceOptionLabel(
        source,
        draftRule.value.sources.findIndex((item) => item.id === source.id),
      ),
      reason,
    })];
  } finally {
    setSourceLoading(source.id, false);
  }
}

async function loadRule(ruleId: string | null): Promise<void> {
  resetFeedback();

  try {
    if (!ruleId) {
      activeRuleId.value = "";
      setDraftRule(createEmptyEngineRuleDefinition());
      return;
    }

    await reloadEngineRules();
    const selected = getEngineRuleById(ruleId);
    if (!selected) {
      activeRuleId.value = "";
      setDraftRule(createEmptyEngineRuleDefinition());
      validationErrors.value = [t("engineRules.messages.ruleNotFound")];
      return;
    }

    activeRuleId.value = selected.id;
    setDraftRule(selected);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    activeRuleId.value = "";
    setDraftRule(createEmptyEngineRuleDefinition());
    validationErrors.value = [t("engineRules.messages.ruleLoadFailed", { reason })];
  }
}

async function handleSaveRule(closeAfterSave = false): Promise<void> {
  if (isSaving.value) {
    return;
  }

  resetFeedback();
  const validation = validateEngineRuleDraft(draftRule.value);
  if (!validation.isValid) {
    validationErrors.value = validation.errors;
    return;
  }

  isSaving.value = true;
  try {
    const saved = await saveEngineRule(cloneEngineRuleDefinition(draftRule.value));
    activeRuleId.value = saved.id;
    setDraftRule(saved);
    actionMessage.value = t("engineRules.messages.saved");
    await emitTo(MAIN_WINDOW_LABEL, "engine-rule-data-updated", { ruleId: saved.id });

    if (closeAfterSave) {
      await closeWindow();
    }
  } catch {
    validationErrors.value = [t("engineRules.messages.saveFailed")];
  } finally {
    isSaving.value = false;
  }
}

async function handleDeleteCurrentRule(): Promise<void> {
  if (!activeRuleId.value || isSaving.value) {
    return;
  }

  const targetName = draftRule.value.name || t("engineRules.library.unnamed");
  const confirmed = await confirm(t("engineRules.messages.deleteConfirm", { name: targetName }));
  if (!confirmed) {
    return;
  }

  try {
    await deleteEngineRule(activeRuleId.value);
    await emitTo(MAIN_WINDOW_LABEL, "engine-rule-data-updated", { ruleId: null });
    await closeWindow();
  } catch {
    validationErrors.value = [t("engineRules.messages.saveFailed")];
  }
}

async function closeWindow(): Promise<void> {
  const isMainWindow = appWindow.label === MAIN_WINDOW_LABEL;
  try {
    if (isMainWindow) {
      await router.replace({ name: "main" });
      return;
    }
    await appWindow.close();
  } catch {
    if (!isMainWindow) {
      validationErrors.value = [t("engineRules.messages.closeFailed")];
    }
  }
}

watch(
  () => draftRule.value.ruleType,
  () => {
    ensureSingleTableLimit();
    if (activePanelKey.value.startsWith("relation:") && draftRule.value.ruleType === "single_table") {
      setActivePanel("relations");
    }
  },
);

watch(
  () => route.query.ruleId,
  (value) => {
    const ruleId = typeof value === "string" && value.trim() ? value : null;
    void loadRule(ruleId);
  },
  { immediate: true },
);

watch(
  () => [
    resultFieldOptions.value.join("|"),
    draftRule.value.result.sheetConfig.splitFieldScope,
    draftRule.value.result.sheetConfig.splitSourceTableId,
    draftRule.value.sources.map((item) => item.id).join("|"),
    draftRule.value.sources.map((item) => item.sourceHeaders.join("|")).join("||"),
  ],
  () => {
    if (
      draftRule.value.result.sheetConfig.splitFieldScope === "source_field" &&
      draftRule.value.result.sheetConfig.splitSourceTableId &&
      !draftRule.value.sources.some((item) => item.id === draftRule.value.result.sheetConfig.splitSourceTableId)
    ) {
      draftRule.value.result.sheetConfig.splitSourceTableId = "";
      draftRule.value.result.sheetConfig.splitField = "";
    }

    if (
      draftRule.value.result.sheetConfig.splitField &&
      !splitFieldOptions.value.includes(draftRule.value.result.sheetConfig.splitField)
    ) {
      draftRule.value.result.sheetConfig.splitField = "";
    }

    if (
      draftRule.value.result.rowCompletion.targetField &&
      !resultFieldOptions.value.includes(draftRule.value.result.rowCompletion.targetField)
    ) {
      draftRule.value.result.rowCompletion.targetField = "";
    }
    if (
      draftRule.value.result.rowCompletion.sourceField &&
      !rowCompletionSourceFieldOptions.value.includes(draftRule.value.result.rowCompletion.sourceField)
    ) {
      draftRule.value.result.rowCompletion.sourceField = "";
    }
  },
  { immediate: true },
);

watch(
  () => `${outputFieldNameOptions.value.join("|")}__${totalRowLabelFieldOptions.value.join("|")}`,
  () => {
    if (
      draftRule.value.result.totalRow.labelField &&
      !totalRowLabelFieldOptions.value.includes(draftRule.value.result.totalRow.labelField)
    ) {
      draftRule.value.result.totalRow.labelField = "";
    }
    draftRule.value.result.totalRow.sumFields = draftRule.value.result.totalRow.sumFields.filter((item) =>
      outputFieldNameOptions.value.includes(item),
    );
  },
  { immediate: true },
);

watch(
  () => [
    draftRule.value.sources.map((item) => item.id).join("|"),
    draftRule.value.relations.map((item) => item.id).join("|"),
    draftRule.value.result.groupFields.map((item) => item.id).join("|"),
    draftRule.value.outputFields.map((item) => item.id).join("|"),
  ],
  () => {
    if (activePanelKey.value.startsWith("source:") && !activeSource.value) {
      setActivePanel("sources");
    }
    if (activePanelKey.value.startsWith("relation:") && !activeRelation.value) {
      setActivePanel("relations");
    }
    if (activePanelKey.value.startsWith("dimension:") && !activeDimension.value) {
      setActivePanel("dimensions");
    }
    if (activePanelKey.value.startsWith("output:") && !activeOutput.value) {
      setActivePanel("outputs");
    }
  },
);

watch(
  () => [
    draftRule.value.sources.map((item) => `${item.id}:${item.sourceHeaders.join("|")}`).join("||"),
    draftRule.value.outputFields.map((item) => `${item.id}:${item.nameSourceTableId}`).join("||"),
  ],
  () => {
    draftRule.value.outputFields.forEach((field) => {
      const availableNameFields = fieldsForSourceId(field.nameSourceTableId);
      if (field.nameSourceField && !availableNameFields.includes(field.nameSourceField)) {
        field.nameSourceField = "";
      }
      const filteredNameMappingSourceFields = field.nameMappingSourceFields.filter((item) =>
        availableNameFields.includes(item),
      );
      if (filteredNameMappingSourceFields.length !== field.nameMappingSourceFields.length) {
        field.nameMappingSourceFields = filteredNameMappingSourceFields;
      }
    });
  },
  { immediate: true },
);

onMounted(async () => {
  unlistenSetRule = await listen<EngineRuleEditorPayload>("engine-rule-editor:set-rule", (event) => {
    const nextRuleId = event.payload?.ruleId ?? null;
    void loadRule(nextRuleId);
  });
});

onUnmounted(() => {
  finishOutputFieldDrag();
  unlistenSetRule?.();
});
</script>

<template>
  <main class="engine-editor-page">
    <header class="engine-editor-header">
      <div class="engine-editor-title-block">
        <p class="engine-editor-eyebrow">{{ $t("engineRules.editor.windowTitle") }}</p>
        <h1>{{ draftRule.name.trim() || $t("engineRules.library.unnamed") }}</h1>
        <p class="hint-text">{{ $t("engineRules.messages.editorHint") }}</p>
      </div>
      <div class="engine-editor-header-actions">
        <button
          v-if="activeRuleId"
          type="button"
          class="secondary-btn danger-outline"
          :disabled="isSaving"
          @click="handleDeleteCurrentRule"
        >
          {{ $t("engineRules.actions.delete") }}
        </button>
        <button type="button" class="secondary-btn" :disabled="isSaving" @click="handleSaveRule(false)">
          {{ isSaving ? $t("engineRules.actions.saving") : $t("engineRules.actions.save") }}
        </button>
        <button type="button" class="primary-btn" :disabled="isSaving" @click="handleSaveRule(true)">
          {{ isSaving ? $t("engineRules.actions.saving") : $t("engineRules.actions.saveAndClose") }}
        </button>
        <button type="button" class="secondary-btn" @click="closeWindow">
          {{ $t("engineRules.actions.close") }}
        </button>
      </div>
    </header>

    <section class="engine-editor-shell">
      <aside class="engine-editor-sidebar">
        <div class="sidebar-section">
          <button
            type="button"
            class="tree-item tree-item-root"
            :class="{ active: panelMatches('basic') }"
            @click="setActivePanel('basic')"
          >
            <span class="status-dot" :class="draftRule.name.trim() ? 'ready' : 'partial'" />
            <span class="tree-item-label">{{ $t("engineRules.editor.basicTitle") }}</span>
          </button>
        </div>

        <div class="sidebar-section">
          <div class="tree-section-head">
            <button
              type="button"
              class="tree-item tree-item-root"
              :class="{ active: panelMatches('sources') || activePanelKey.startsWith('source:') }"
              @click="setActivePanel('sources')"
            >
              <span class="status-dot" :class="sectionStatus(draftRule.sources.length, sourceReadyCount)" />
              <span class="tree-item-label">{{ $t("engineRules.editor.sourcesTitle") }}</span>
            </button>
            <div class="tree-section-actions">
              <button
                type="button"
                class="icon-btn collapse-btn"
                :aria-expanded="!isSidebarSectionCollapsed('sources')"
                @click.stop="toggleSidebarSection('sources')"
              >
                {{ isSidebarSectionCollapsed("sources") ? "▸" : "▾" }}
              </button>
              <button
                type="button"
                class="icon-btn"
                :disabled="draftRule.ruleType === 'single_table' && draftRule.sources.length >= 1"
                @click="addSource"
              >
                +
              </button>
            </div>
          </div>
          <div v-if="!isSidebarSectionCollapsed('sources')" class="tree-list">
            <button
              v-for="(source, sourceIndex) in draftRule.sources"
              :key="source.id"
              type="button"
              class="tree-item tree-item-child"
              :class="{ active: panelMatches(sourcePanelKey(source.id)) }"
              @click="setActivePanel(sourcePanelKey(source.id))"
            >
              <span class="status-dot" :class="sourceStatus(source)" />
              <span class="tree-item-label">{{ formatSourceOptionLabel(source, sourceIndex) }}</span>
            </button>
          </div>
        </div>

        <div v-if="draftRule.ruleType === 'multi_table'" class="sidebar-section">
          <div class="tree-section-head">
            <button
              type="button"
              class="tree-item tree-item-root"
              :class="{ active: panelMatches('relations') || activePanelKey.startsWith('relation:') }"
              @click="setActivePanel('relations')"
            >
              <span class="status-dot" :class="sectionStatus(draftRule.relations.length, relationReadyCount)" />
              <span class="tree-item-label">{{ $t("engineRules.editor.relationsTitle") }}</span>
            </button>
            <div class="tree-section-actions">
              <button
                type="button"
                class="icon-btn collapse-btn"
                :aria-expanded="!isSidebarSectionCollapsed('relations')"
                @click.stop="toggleSidebarSection('relations')"
              >
                {{ isSidebarSectionCollapsed("relations") ? "▸" : "▾" }}
              </button>
              <button
                type="button"
                class="icon-btn"
                :disabled="draftRule.sources.length < 2"
                @click="addRelation"
              >
                +
              </button>
            </div>
          </div>
          <div v-if="!isSidebarSectionCollapsed('relations')" class="tree-list">
            <button
              v-for="(relation, relationIndex) in draftRule.relations"
              :key="relation.id"
              type="button"
              class="tree-item tree-item-child"
              :class="{ active: panelMatches(relationPanelKey(relation.id)) }"
              @click="setActivePanel(relationPanelKey(relation.id))"
            >
              <span class="status-dot" :class="relationStatus(relation)" />
              <span class="tree-item-label">{{ relationLabel(relation, relationIndex) }}</span>
            </button>
          </div>
        </div>

        <div class="sidebar-section">
          <div class="tree-section-head">
            <button
              type="button"
              class="tree-item tree-item-root"
              :class="{ active: panelMatches('dimensions') || panelMatches('rowCompletion') || activePanelKey.startsWith('dimension:') }"
              @click="setActivePanel('dimensions')"
            >
              <span class="status-dot" :class="sectionStatus(draftRule.result.groupFields.length, dimensionReadyCount)" />
              <span class="tree-item-label">{{ $t("engineRules.editor.resultTitle") }}</span>
            </button>
            <div class="tree-section-actions">
              <button
                type="button"
                class="icon-btn collapse-btn"
                :aria-expanded="!isSidebarSectionCollapsed('dimensions')"
                @click.stop="toggleSidebarSection('dimensions')"
              >
                {{ isSidebarSectionCollapsed("dimensions") ? "▸" : "▾" }}
              </button>
              <button type="button" class="icon-btn" @click="addResultGroupField">+</button>
            </div>
          </div>
          <div v-if="!isSidebarSectionCollapsed('dimensions')" class="tree-list">
            <button
              v-for="field in draftRule.result.groupFields"
              :key="field.id"
              type="button"
              class="tree-item tree-item-child"
              :class="{ active: panelMatches(dimensionPanelKey(field.id)) }"
              @click="setActivePanel(dimensionPanelKey(field.id))"
            >
              <span class="status-dot" :class="dimensionStatus(field.id)" />
              <span class="tree-item-label">{{ dimensionLabel(field.id) }}</span>
            </button>
            <button
              type="button"
              class="tree-item tree-item-child"
              :class="{ active: panelMatches('rowCompletion') }"
              @click="setActivePanel('rowCompletion')"
            >
              <span class="status-dot" :class="rowCompletionStatus()" />
              <span class="tree-item-label">{{ $t("engineRules.editor.rowCompletionTitle") }}</span>
            </button>
          </div>
        </div>

        <div class="sidebar-section">
          <div class="tree-section-head">
            <button
              type="button"
              class="tree-item tree-item-root"
              :class="{ active: panelMatches('outputs') || activePanelKey.startsWith('output:') }"
              @click="setActivePanel('outputs')"
            >
              <span class="status-dot" :class="sectionStatus(draftRule.outputFields.length, outputReadyCount)" />
              <span class="tree-item-label">{{ $t("engineRules.editor.outputTitle") }}</span>
            </button>
            <div class="tree-section-actions">
              <button
                type="button"
                class="icon-btn collapse-btn"
                :aria-expanded="!isSidebarSectionCollapsed('outputs')"
                @click.stop="toggleSidebarSection('outputs')"
              >
                {{ isSidebarSectionCollapsed("outputs") ? "▸" : "▾" }}
              </button>
              <button type="button" class="icon-btn" @click="addOutputField">+</button>
            </div>
          </div>
          <div v-if="!isSidebarSectionCollapsed('outputs')" class="tree-list">
            <button
              v-for="field in outputFieldViews"
              :key="field.id"
              type="button"
              class="tree-item tree-item-child"
              :class="{ active: panelMatches(outputPanelKey(field.id)) }"
              @click="setActivePanel(outputPanelKey(field.id))"
            >
              <span class="status-dot" :class="field.status" />
              <span class="tree-item-label">{{ field.label }}</span>
            </button>
          </div>
        </div>

        <div class="sidebar-section">
          <div class="tree-section-head">
            <button
              type="button"
              class="tree-item tree-item-root"
              :class="{ active: panelMatches('sheet') || panelMatches('sheetTemplate') }"
              @click="setActivePanel('sheet')"
            >
              <span class="status-dot" :class="sheetSectionStatus()" />
              <span class="tree-item-label">{{ $t("engineRules.editor.sheetGroupTitle") }}</span>
            </button>
            <div class="tree-section-actions">
              <button
                type="button"
                class="icon-btn collapse-btn"
                :aria-expanded="!isSidebarSectionCollapsed('sheet')"
                @click.stop="toggleSidebarSection('sheet')"
              >
                {{ isSidebarSectionCollapsed("sheet") ? "▸" : "▾" }}
              </button>
            </div>
          </div>
          <div v-if="!isSidebarSectionCollapsed('sheet')" class="tree-list">
            <button
              type="button"
              class="tree-item tree-item-child"
              :class="{ active: panelMatches('sheet') }"
              @click="setActivePanel('sheet')"
            >
              <span
                class="status-dot"
                :class="draftRule.result.sheetConfig.mode === 'split_field' && !draftRule.result.sheetConfig.splitField ? 'partial' : 'ready'"
              />
              <span class="tree-item-label">{{ $t("engineRules.editor.sheetTitle") }}</span>
            </button>
            <button
              type="button"
              class="tree-item tree-item-child"
              :class="{ active: panelMatches('sheetTemplate') }"
              @click="setActivePanel('sheetTemplate')"
            >
              <span class="status-dot" :class="draftRule.sheetTemplate.titleEnabled ? 'ready' : 'empty'" />
              <span class="tree-item-label">{{ $t("engineRules.editor.sheetTemplateTitle") }}</span>
            </button>
          </div>
          <button
            type="button"
            class="tree-item tree-item-root"
            :class="{ active: panelMatches('totalRow') }"
            @click="setActivePanel('totalRow')"
          >
            <span class="status-dot" :class="draftRule.result.totalRow.enabled ? 'ready' : 'empty'" />
            <span class="tree-item-label">{{ $t("engineRules.editor.totalRowTitle") }}</span>
          </button>
        </div>
      </aside>

      <section class="engine-editor-canvas">
        <section v-if="validationErrors.length > 0" class="banner-card error-banner">
          <p v-for="error in validationErrors" :key="error">{{ error }}</p>
        </section>
        <section v-if="actionMessage" class="banner-card success-banner">
          <p>{{ actionMessage }}</p>
        </section>
        <section class="sheet-canvas">
          <div class="sheet-toolbar">
            <div class="sheet-toolbar-meta">
              <span class="sheet-toolbar-title">{{ draftRule.name.trim() || $t("engineRules.library.unnamed") }}</span>
              <span class="sheet-toolbar-badge">{{ $t(`engineRules.ruleTypes.${draftRule.ruleType}`) }}</span>
            </div>
            <div class="sheet-toolbar-stats">
              <span class="sheet-toolbar-stat">{{ $t("engineRules.editor.sourcesTitle") }} {{ sourceReadyCount }}/{{ draftRule.sources.length }}</span>
              <span v-if="draftRule.ruleType === 'multi_table'" class="sheet-toolbar-stat">{{ $t("engineRules.editor.relationsTitle") }} {{ relationReadyCount }}/{{ draftRule.relations.length }}</span>
              <span class="sheet-toolbar-stat">{{ $t("engineRules.editor.resultTitle") }} {{ dimensionReadyCount }}/{{ draftRule.result.groupFields.length }}</span>
              <span class="sheet-toolbar-stat">{{ $t("engineRules.editor.outputTitle") }} {{ outputReadyCount }}/{{ draftRule.outputFields.length }}</span>
            </div>
          </div>

          <div class="sheet-formula-bar">
            <span class="sheet-formula-label">fx</span>
            <div class="sheet-formula-input">{{ currentPanelTitle }}</div>
          </div>

          <div class="sheet-board" :style="sheetBoardStyle">
            <div class="sheet-corner" />
            <div
              v-for="(column, columnIndex) in sheetColumns"
              :key="`sheet-column-${column}`"
              class="sheet-column-header"
              :style="{ gridColumn: `${columnIndex + 2}`, gridRow: '1' }"
            >
              {{ column }}
            </div>
            <template v-for="row in sheetRows" :key="`sheet-row-${row}`">
              <div class="sheet-row-header" :style="{ gridColumn: '1', gridRow: `${row + 1}` }">{{ row }}</div>
            </template>

            <div class="sheet-grid-surface" :style="sheetBoardStyle">
              <div
                v-for="cell in previewCells"
                :key="cell.key"
                class="sheet-cell"
                :class="[
                  `sheet-cell-${cell.kind}`,
                  { clickable: Boolean(cell.panelKey) },
                  { active: cell.active }
                ]"
                :role="cell.panelKey ? 'button' : undefined"
                :tabindex="cell.panelKey ? 0 : undefined"
                :style="{
                  gridColumn: `${cell.col} / span ${cell.colSpan ?? 1}`,
                  gridRow: `${cell.row}`
                }"
                @click="handlePreviewCellClick(cell)"
                @keydown.enter.prevent="handlePreviewCellClick(cell)"
                @keydown.space.prevent="handlePreviewCellClick(cell)"
              >
                {{ cell.value }}
              </div>
            </div>
          </div>

          <div class="sheet-tabs">
            <button
              v-for="(tab, tabIndex) in previewTabs"
              :key="`preview-tab-${tabIndex}`"
              type="button"
              class="sheet-tab"
              :class="{ active: tabIndex === 0 }"
              @click="setActivePanel(tabIndex === 1 ? 'sheetTemplate' : tabIndex === 2 ? 'totalRow' : 'sheet')"
            >
              {{ tab }}
            </button>
          </div>
        </section>
      </section>

      <aside class="engine-editor-inspector">
        <div class="inspector-head">
          <div>
            <p class="inspector-caption">{{ $t("engineRules.editor.windowTitle") }}</p>
            <h2>{{ currentPanelTitle }}</h2>
          </div>
          <p v-if="currentPanelDescription" class="hint-text">{{ currentPanelDescription }}</p>
        </div>

        <div class="inspector-body">
          <template v-if="panelMatches('basic')">
            <section class="inspector-section">
              <label class="field-block">
                <span>{{ $t("engineRules.fields.name") }}</span>
                <input v-model="draftRule.name" type="text" />
              </label>
              <label class="field-block">
                <span>{{ $t("engineRules.fields.description") }}</span>
                <textarea v-model="draftRule.description" rows="3" />
              </label>
              <label class="field-block">
                <span>{{ $t("engineRules.fields.ruleType") }}</span>
                <select v-model="draftRule.ruleType">
                  <option v-for="ruleType in ENGINE_RULE_TYPES" :key="ruleType" :value="ruleType">
                    {{ $t(`engineRules.ruleTypes.${ruleType}`) }}
                  </option>
                </select>
              </label>
              <div class="switch-row">
                <span>{{ $t("engineRules.fields.enabled") }}</span>
                <label class="switch" :aria-label="$t('engineRules.fields.enabled')">
                  <input v-model="draftRule.enabled" type="checkbox" />
                  <span class="switch-track">
                    <span class="switch-thumb" />
                  </span>
                </label>
              </div>
            </section>
          </template>

          <template v-else-if="panelMatches('sources')">
            <section class="inspector-section">
              <div class="inspector-inline-head">
                <h3>{{ $t("engineRules.editor.sourcesTitle") }}</h3>
                <button
                  type="button"
                  class="secondary-btn"
                  :disabled="draftRule.ruleType === 'single_table' && draftRule.sources.length >= 1"
                  @click="addSource"
                >
                  {{ $t("engineRules.actions.addSource") }}
                </button>
              </div>
              <div class="stack-list">
                <button
                  v-for="(source, sourceIndex) in draftRule.sources"
                  :key="`inspector-source-${source.id}`"
                  type="button"
                  class="stack-card stack-card-compact"
                  @click="setActivePanel(sourcePanelKey(source.id))"
                >
                  <div class="stack-card-main">
                    <div class="mini-card-head">
                      <span>{{ formatSourceOptionLabel(source, sourceIndex) }}</span>
                    </div>
                    <span class="mini-card-meta">{{ source.sourceFileName || $t("engineRules.messages.noSourceFile") }}</span>
                  </div>
                  <span class="status-dot" :class="sourceStatus(source)" />
                </button>
              </div>
            </section>
          </template>

          <template v-else-if="activeSource">
            <section class="inspector-section">
              <div class="inspector-inline-head">
                <h3>{{ currentPanelTitle }}</h3>
                <button type="button" class="text-btn danger" @click="removeSource(activeSource.id)">
                  {{ $t("engineRules.actions.remove") }}
                </button>
              </div>

              <div class="source-upload-row">
                <div class="source-upload-meta">
                  <span class="field-block-label">{{ $t("engineRules.fields.sourceFile") }}</span>
                  <strong>{{ activeSource.sourceFileName || $t("engineRules.messages.noSourceFile") }}</strong>
                </div>
                <button
                  type="button"
                  class="secondary-btn"
                  :disabled="sourceLoadingMap[activeSource.id]"
                  @click="handleUploadSource(activeSource)"
                >
                  {{
                    sourceLoadingMap[activeSource.id]
                      ? $t("engineRules.messages.uploading")
                      : $t("engineRules.actions.uploadSource")
                  }}
                </button>
              </div>

              <label class="field-block">
                <span>{{ $t("engineRules.fields.sourceSheet") }}</span>
                <select
                  :value="activeSource.sourceSheetName"
                  :disabled="!getSourcePreview(activeSource.id) || sourceLoadingMap[activeSource.id]"
                  @change="applySourceSheet(activeSource, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ $t("engineRules.messages.selectSheet") }}</option>
                  <option
                    v-for="sheet in getSourcePreview(activeSource.id)?.sheets ?? []"
                    :key="`${activeSource.id}-${sheet.name}`"
                    :value="sheet.name"
                  >
                    {{ sheet.name }}
                  </option>
                </select>
              </label>

              <div class="field-grid field-grid-two">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.headerRowIndex") }}</span>
                  <input
                    v-model.number="activeSource.sourceHeaderRowIndex"
                    type="number"
                    min="1"
                    :disabled="!activeSource.sourceSheetName || sourceLoadingMap[activeSource.id]"
                    @input="refreshSourceSheetPreview(activeSource)"
                  />
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.groupHeaderRowIndex") }}</span>
                  <input
                    v-model.number="activeSource.sourceGroupHeaderRowIndex"
                    type="number"
                    min="0"
                    :disabled="!activeSource.sourceSheetName || sourceLoadingMap[activeSource.id]"
                    @input="refreshSourceSheetPreview(activeSource)"
                  />
                </label>
              </div>

              <label class="field-block">
                <span>{{ $t("engineRules.messages.availableFields") }}</span>
                <textarea
                  :value="activeSource.sourceHeaders.join('\n')"
                  rows="6"
                  @change="activeSource.sourceHeaders = parseFieldsText(($event.target as HTMLTextAreaElement).value)"
                />
              </label>

              <div v-if="activeSource.sourceHeaders.length > 0" class="header-wrap">
                <span
                  v-for="header in activeSource.sourceHeaders"
                  :key="`${activeSource.id}-${header}`"
                  class="header-chip"
                >
                  {{ header }}
                </span>
              </div>
              <p v-else class="hint-text">{{ $t("engineRules.messages.noHeaders") }}</p>

              <div v-if="getSourceSheetPreview(activeSource.id)?.sampleRows.length" class="sample-table-wrap">
                <table class="sample-table">
                  <thead>
                    <tr>
                      <th
                        v-for="header in activeSource.sourceHeaders.slice(0, 6)"
                        :key="`${activeSource.id}-sample-head-${header}`"
                      >
                        {{ header }}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(row, rowIndex) in getSourceSheetPreview(activeSource.id)?.sampleRows.slice(0, 5) ?? []"
                      :key="`${activeSource.id}-sample-row-${rowIndex}`"
                    >
                      <td
                        v-for="header in activeSource.sourceHeaders.slice(0, 6)"
                        :key="`${activeSource.id}-${rowIndex}-${header}`"
                      >
                        {{ row[header] }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="inspector-subsection">
                <div class="inspector-inline-head">
                  <h4>{{ $t("engineRules.fields.preFilters") }}</h4>
                  <button type="button" class="secondary-btn" @click="addSourceFilter(activeSource)">
                    {{ $t("engineRules.actions.addFilter") }}
                  </button>
                </div>
                <table v-if="activeSource.preFilters.length > 0" class="rule-table compact-table">
                  <thead>
                    <tr>
                      <th>{{ $t("engineRules.fields.field") }}</th>
                      <th>{{ $t("engineRules.fields.valueMode") }}</th>
                      <th>{{ $t("engineRules.fields.filterValue") }}</th>
                      <th class="operation-col">{{ $t("engineRules.actions.remove") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="filter in activeSource.preFilters" :key="filter.id">
                      <td>
                        <select v-model="filter.field">
                          <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                          <option
                            v-for="name in fieldsForSourceId(activeSource.id)"
                            :key="`${filter.id}-${name}`"
                            :value="name"
                          >
                            {{ name }}
                          </option>
                        </select>
                      </td>
                      <td>
                        <select v-model="filter.operator">
                          <option v-for="operator in ENGINE_SOURCE_FILTER_OPERATORS" :key="operator" :value="operator">
                            {{ $t(`engineRules.filterOperators.${operator}`) }}
                          </option>
                        </select>
                      </td>
                      <td><input v-model="filter.valueText" type="text" /></td>
                      <td>
                        <button
                          type="button"
                          class="text-btn danger"
                          @click="removeSourceFilter(activeSource, filter.id)"
                        >
                          {{ $t("engineRules.actions.remove") }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-else class="hint-text">{{ $t("engineRules.messages.noFilters") }}</p>
              </div>
            </section>
          </template>

          <template v-else-if="panelMatches('relations')">
            <section class="inspector-section">
              <div class="inspector-inline-head">
                <h3>{{ $t("engineRules.editor.relationsTitle") }}</h3>
                <button
                  type="button"
                  class="secondary-btn"
                  :disabled="draftRule.sources.length < 2"
                  @click="addRelation"
                >
                  {{ $t("engineRules.actions.addRelation") }}
                </button>
              </div>
              <div class="stack-list">
                <button
                  v-for="(relation, relationIndex) in draftRule.relations"
                  :key="`inspector-relation-${relation.id}`"
                  type="button"
                  class="stack-card stack-card-compact"
                  @click="setActivePanel(relationPanelKey(relation.id))"
                >
                  <div class="stack-card-main">
                    <div class="mini-card-head">
                      <span>{{ relationLabel(relation, relationIndex) }}</span>
                    </div>
                    <span class="mini-card-meta">{{ $t(`engineRules.relationJoinTypes.${relation.joinType}`) }}</span>
                  </div>
                  <span class="status-dot" :class="relationStatus(relation)" />
                </button>
              </div>
              <p v-if="draftRule.relations.length === 0" class="hint-text">{{ $t("engineRules.messages.noRelations") }}</p>
            </section>
          </template>

          <template v-else-if="activeRelation">
            <section class="inspector-section">
              <div class="inspector-inline-head">
                <h3>{{ currentPanelTitle }}</h3>
                <button type="button" class="text-btn danger" @click="removeRelation(activeRelation.id)">
                  {{ $t("engineRules.actions.remove") }}
                </button>
              </div>
              <div class="field-grid field-grid-two">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.relationLeftSource") }}</span>
                  <select v-model="activeRelation.leftSourceId">
                    <option value="">{{ $t("engineRules.messages.selectSource") }}</option>
                    <option v-for="source in sourceOptions" :key="`relation-left-${source.id}`" :value="source.id">
                      {{ source.label }}
                    </option>
                  </select>
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.relationLeftField") }}</span>
                  <select v-model="activeRelation.leftField" :disabled="!activeRelation.leftSourceId">
                    <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                    <option
                      v-for="name in fieldsForRelationSource(activeRelation.leftSourceId)"
                      :key="`left-${activeRelation.id}-${name}`"
                      :value="name"
                    >
                      {{ name }}
                    </option>
                  </select>
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.relationRightSource") }}</span>
                  <select v-model="activeRelation.rightSourceId">
                    <option value="">{{ $t("engineRules.messages.selectSource") }}</option>
                    <option v-for="source in sourceOptions" :key="`relation-right-${source.id}`" :value="source.id">
                      {{ source.label }}
                    </option>
                  </select>
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.relationRightField") }}</span>
                  <select v-model="activeRelation.rightField" :disabled="!activeRelation.rightSourceId">
                    <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                    <option
                      v-for="name in fieldsForRelationSource(activeRelation.rightSourceId)"
                      :key="`right-${activeRelation.id}-${name}`"
                      :value="name"
                    >
                      {{ name }}
                    </option>
                  </select>
                </label>
              </div>
              <div class="field-grid field-grid-two">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.relationJoinType") }}</span>
                  <select v-model="activeRelation.joinType">
                    <option v-for="joinType in ENGINE_RELATION_JOIN_TYPES" :key="joinType" :value="joinType">
                      {{ $t(`engineRules.relationJoinTypes.${joinType}`) }}
                    </option>
                  </select>
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.relationMultiMatchStrategy") }}</span>
                  <select v-model="activeRelation.multiMatchStrategy">
                    <option
                      v-for="strategy in ENGINE_RELATION_MULTI_MATCH_STRATEGIES"
                      :key="strategy"
                      :value="strategy"
                    >
                      {{ $t(`engineRules.relationMultiMatchStrategies.${strategy}`) }}
                    </option>
                  </select>
                </label>
              </div>
            </section>
          </template>

          <template v-else-if="panelMatches('dimensions')">
            <section class="inspector-section">
              <div class="inspector-inline-head">
                <h3>{{ $t("engineRules.fields.groupFields") }}</h3>
                <button type="button" class="secondary-btn" @click="addResultGroupField">
                  {{ $t("engineRules.actions.addField") }}
                </button>
              </div>
              <div class="stack-list">
                <button
                  v-for="field in draftRule.result.groupFields"
                  :key="`inspector-dimension-${field.id}`"
                  type="button"
                  class="stack-card stack-card-compact"
                  @click="setActivePanel(dimensionPanelKey(field.id))"
                >
                  <div class="stack-card-main">
                    <div class="mini-card-head">
                      <span>{{ dimensionLabel(field.id) }}</span>
                    </div>
                    <span class="mini-card-meta">
                      {{ relationSourceLabel(field.sourceTableId) }} / {{ dimensionVisibilityLabel(field.visible) }}
                    </span>
                  </div>
                  <span class="status-dot" :class="dimensionStatus(field.id)" />
                </button>
              </div>

              <div class="inspector-subsection">
                <div class="inspector-inline-head">
                  <h4>{{ $t("engineRules.fields.sortFields") }}</h4>
                  <button type="button" class="secondary-btn" @click="addSortField">
                    {{ $t("engineRules.actions.addSort") }}
                  </button>
                </div>
                <table v-if="draftRule.result.sortFields.length > 0" class="rule-table compact-table">
                  <thead>
                    <tr>
                      <th>{{ $t("engineRules.fields.sortFields") }}</th>
                      <th>{{ $t("engineRules.fields.valueMode") }}</th>
                      <th class="operation-col">{{ $t("engineRules.actions.remove") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="field in draftRule.result.sortFields" :key="field.id">
                      <td>
                        <select v-model="field.fieldName">
                          <option value="">{{ $t("engineRules.messages.selectResultField") }}</option>
                          <option v-for="name in resultFieldOptions" :key="name" :value="name">
                            {{ name }}
                          </option>
                        </select>
                      </td>
                      <td>
                        <select v-model="field.direction">
                          <option v-for="direction in ENGINE_SORT_DIRECTIONS" :key="direction" :value="direction">
                            {{ $t(`engineRules.sortDirections.${direction}`) }}
                          </option>
                        </select>
                      </td>
                      <td>
                        <button type="button" class="text-btn danger" @click="removeSortField(field.id)">
                          {{ $t("engineRules.actions.remove") }}
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-else class="hint-text">{{ $t("engineRules.messages.noSorts") }}</p>
              </div>

              <div class="inspector-subsection">
                <div class="inspector-inline-head">
                  <h4>{{ $t("engineRules.editor.rowCompletionTitle") }}</h4>
                  <button type="button" class="secondary-btn" @click="setActivePanel('rowCompletion')">
                    {{ $t("engineRules.actions.configure") }}
                  </button>
                </div>
                <button type="button" class="stack-card stack-card-compact" @click="setActivePanel('rowCompletion')">
                  <div class="stack-card-main">
                    <div class="mini-card-head">
                      <span>{{ $t("engineRules.editor.rowCompletionTitle") }}</span>
                    </div>
                    <span class="mini-card-meta">
                      {{
                        draftRule.result.rowCompletion.enabled
                          ? $t(`engineRules.rowCompletionBaselineTypes.${draftRule.result.rowCompletion.baselineType}`)
                          : $t("engineRules.labels.unset")
                      }}
                    </span>
                  </div>
                  <span class="status-dot" :class="rowCompletionStatus()" />
                </button>
              </div>
            </section>
          </template>

          <template v-else-if="panelMatches('rowCompletion')">
            <section class="inspector-section">
              <div class="switch-row">
                <span>{{ $t("engineRules.fields.rowCompletionEnabled") }}</span>
                <label class="switch" :aria-label="$t('engineRules.fields.rowCompletionEnabled')">
                  <input v-model="draftRule.result.rowCompletion.enabled" type="checkbox" />
                  <span class="switch-track">
                    <span class="switch-thumb" />
                  </span>
                </label>
              </div>
              <p class="hint-text">{{ $t("engineRules.messages.rowCompletionHint") }}</p>

              <template v-if="draftRule.result.rowCompletion.enabled">
                <div class="field-grid field-grid-two">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.rowCompletionTargetField") }}</span>
                    <select v-model="draftRule.result.rowCompletion.targetField">
                      <option value="">{{ $t("engineRules.messages.selectResultField") }}</option>
                      <option v-for="name in resultFieldOptions" :key="`row-completion-target-${name}`" :value="name">
                        {{ name }}
                      </option>
                    </select>
                  </label>
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.rowCompletionMode") }}</span>
                    <select v-model="draftRule.result.rowCompletion.completionMode">
                      <option v-for="mode in ENGINE_RESULT_COMPLETION_MODES" :key="mode" :value="mode">
                        {{ $t(`engineRules.rowCompletionModes.${mode}`) }}
                      </option>
                    </select>
                  </label>
                </div>

                <label class="field-block">
                  <span>{{ $t("engineRules.fields.rowCompletionBaselineType") }}</span>
                  <select v-model="draftRule.result.rowCompletion.baselineType">
                    <option v-for="type in ENGINE_RESULT_COMPLETION_BASELINE_TYPES" :key="type" :value="type">
                      {{ $t(`engineRules.rowCompletionBaselineTypes.${type}`) }}
                    </option>
                  </select>
                </label>

                <div v-if="draftRule.result.rowCompletion.baselineType === 'source_table'" class="field-grid field-grid-two">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.rowCompletionSourceTable") }}</span>
                    <select v-model="draftRule.result.rowCompletion.sourceTableId">
                      <option value="">{{ $t("engineRules.messages.selectSource") }}</option>
                      <option v-for="source in sourceOptions" :key="`row-completion-source-${source.id}`" :value="source.id">
                        {{ source.label }}
                      </option>
                    </select>
                  </label>
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.rowCompletionSourceField") }}</span>
                    <select
                      v-model="draftRule.result.rowCompletion.sourceField"
                      :disabled="!draftRule.result.rowCompletion.sourceTableId"
                    >
                      <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                      <option
                        v-for="name in rowCompletionSourceFieldOptions"
                        :key="`row-completion-field-${name}`"
                        :value="name"
                      >
                        {{ name }}
                      </option>
                    </select>
                  </label>
                </div>

                <div v-else-if="draftRule.result.rowCompletion.baselineType === 'mapping_group'" class="field-grid field-grid-two">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.rowCompletionMappingGroupId") }}</span>
                    <select v-model="draftRule.result.rowCompletion.mappingGroupId">
                      <option value="">{{ $t("engineRules.messages.selectMapping") }}</option>
                      <option v-for="mapping in mappingOptions" :key="`row-completion-mapping-${mapping.id}`" :value="mapping.id">
                        {{ mapping.name }}
                      </option>
                    </select>
                  </label>
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.rowCompletionMappingValueType") }}</span>
                    <select v-model="draftRule.result.rowCompletion.mappingValueType">
                      <option
                        v-for="valueType in ENGINE_RESULT_COMPLETION_MAPPING_VALUE_TYPES"
                        :key="valueType"
                        :value="valueType"
                      >
                        {{ $t(`engineRules.rowCompletionMappingValueTypes.${valueType}`) }}
                      </option>
                    </select>
                  </label>
                </div>

                <label v-else-if="draftRule.result.rowCompletion.baselineType === 'manual_values'" class="field-block">
                  <span>{{ $t("engineRules.fields.rowCompletionManualValues") }}</span>
                  <textarea v-model="draftRule.result.rowCompletion.manualValuesText" rows="5" />
                </label>
                <p
                  v-if="draftRule.result.rowCompletion.baselineType === 'manual_values'"
                  class="hint-text"
                >
                  {{ $t("engineRules.messages.rowCompletionManualValuesHint") }}
                </p>
              </template>
            </section>
          </template>

          <template v-else-if="activeDimension">
            <section class="inspector-section">
              <div class="inspector-inline-head">
                <h3>{{ currentPanelTitle }}</h3>
                <button type="button" class="text-btn danger" @click="removeResultGroupField(activeDimension.id)">
                  {{ $t("engineRules.actions.remove") }}
                </button>
              </div>
              <label class="field-block">
                <span>{{ $t("engineRules.fields.resultFieldLabel") }}</span>
                <input v-model="activeDimension.label" type="text" />
              </label>
              <label class="field-block">
                <span>{{ $t("engineRules.fields.sourceTable") }}</span>
                <select v-model="activeDimension.sourceTableId">
                  <option value="">{{ $t("engineRules.messages.selectSource") }}</option>
                  <option v-for="source in sourceOptions" :key="`dimension-source-${source.id}`" :value="source.id">
                    {{ source.label }}
                  </option>
                </select>
              </label>
              <label class="field-block">
                <span>{{ $t("engineRules.fields.sourceField") }}</span>
                <select v-model="activeDimension.sourceField" :disabled="!activeDimension.sourceTableId">
                  <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                  <option
                    v-for="name in fieldsForSourceId(activeDimension.sourceTableId)"
                    :key="`${activeDimension.id}-${name}`"
                    :value="name"
                  >
                    {{ name }}
                  </option>
                </select>
              </label>
              <div class="switch-row">
                <span>{{ $t("engineRules.fields.dimensionVisible") }}</span>
                <label class="switch" :aria-label="$t('engineRules.fields.dimensionVisible')">
                  <input v-model="activeDimension.visible" type="checkbox" />
                  <span class="switch-track">
                    <span class="switch-thumb" />
                  </span>
                </label>
              </div>
            </section>
          </template>

          <template v-else-if="panelMatches('outputs')">
            <section class="inspector-section">
              <div class="inspector-inline-head">
                <h3>{{ $t("engineRules.editor.outputTitle") }}</h3>
                <button type="button" class="secondary-btn" @click="addOutputField">
                  {{ $t("engineRules.actions.addField") }}
                </button>
              </div>
              <div class="stack-list">
                <div
                  v-for="field in outputFieldViews"
                  :key="`inspector-output-${field.id}`"
                  :data-output-field-id="field.id"
                  class="stack-card stack-card-compact stack-card-draggable"
                  :class="{
                    dragging: draggingOutputFieldId === field.id,
                    'drag-over-before': dragOverOutputFieldId === field.id && dragOverOutputFieldPosition === 'before' && draggingOutputFieldId !== field.id,
                    'drag-over-after': dragOverOutputFieldId === field.id && dragOverOutputFieldPosition === 'after' && draggingOutputFieldId !== field.id,
                  }"
                >
                  <div
                    class="stack-card-main stack-card-main-inline stack-card-main-clickable"
                    role="button"
                    tabindex="0"
                    @click="handleOutputFieldCardClick(field.id)"
                    @keydown.enter.prevent="handleOutputFieldCardClick(field.id)"
                    @keydown.space.prevent="handleOutputFieldCardClick(field.id)"
                  >
                    <div class="mini-card-head mini-card-head-inline">
                      <span class="stack-card-title-wrap">
                        <span
                          class="stack-card-grip"
                          title="拖动排序"
                          aria-label="拖动排序"
                          @click.stop
                          @mousedown="handleOutputFieldDragStart($event, field.id)"
                        >
                          ⋮⋮
                        </span>
                        <span>{{ field.label }}</span>
                      </span>
                    </div>
                    <span class="mini-card-meta">{{ $t(`engineRules.valueModes.${field.valueMode}`) }}</span>
                  </div>
                  <span class="status-dot" :class="field.status" />
                </div>
              </div>
            </section>
          </template>

          <template v-else-if="activeOutput">
            <section class="inspector-section">
              <div class="inspector-inline-head">
                <h3>{{ currentPanelTitle }}</h3>
                <button type="button" class="text-btn danger" @click="removeOutputField(activeOutput.id)">
                  {{ $t("engineRules.actions.remove") }}
                </button>
              </div>

              <div class="field-grid field-grid-two">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.fieldNameMode") }}</span>
                  <select v-model="activeOutput.nameMode" @change="handleOutputNameModeChange(activeOutput)">
                    <option v-for="mode in ENGINE_OUTPUT_NAME_MODES" :key="mode" :value="mode">
                      {{ $t(`engineRules.nameModes.${mode}`) }}
                    </option>
                  </select>
                </label>
                <label v-if="activeOutput.nameMode === 'fixed'" class="field-block">
                  <span>{{ $t("engineRules.fields.fieldName") }}</span>
                  <input v-model="activeOutput.fieldName" type="text" />
                </label>
              </div>

              <div v-if="activeOutput.nameMode === 'source_field'" class="field-grid field-grid-two">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.nameSourceTable") }}</span>
                  <select v-model="activeOutput.nameSourceTableId">
                    <option value="">{{ $t("engineRules.messages.selectSource") }}</option>
                    <option v-for="source in sourceOptions" :key="`name-source-${source.id}`" :value="source.id">
                      {{ source.label }}
                    </option>
                  </select>
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.nameSourceField") }}</span>
                  <select v-model="activeOutput.nameSourceField" :disabled="!activeOutput.nameSourceTableId">
                    <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                    <option
                      v-for="name in fieldsForOutputName(activeOutput)"
                      :key="`${activeOutput.id}-name-source-${name}`"
                      :value="name"
                    >
                      {{ name }}
                    </option>
                  </select>
                </label>
              </div>

              <div v-else-if="activeOutput.nameMode === 'mapping'" class="inspector-subsection">
                <div class="field-grid field-grid-two">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.nameSourceTable") }}</span>
                    <select v-model="activeOutput.nameSourceTableId">
                      <option value="">{{ $t("engineRules.messages.selectSource") }}</option>
                      <option v-for="source in sourceOptions" :key="`name-mapping-source-${source.id}`" :value="source.id">
                        {{ source.label }}
                      </option>
                    </select>
                  </label>
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.nameMappingGroupId") }}</span>
                    <select v-model="activeOutput.nameMappingGroupId">
                      <option value="">{{ $t("engineRules.messages.selectMapping") }}</option>
                      <option v-for="mapping in mappingOptions" :key="`name-mapping-${mapping.id}`" :value="mapping.id">
                        {{ mapping.name }}
                      </option>
                    </select>
                  </label>
                </div>
                <div class="field-block">
                  <span>{{ $t("engineRules.fields.nameMappingSourceFields") }}</span>
                  <div class="group-options">
                    <label
                      v-for="name in fieldsForOutputName(activeOutput)"
                      :key="`${activeOutput.id}-name-mapping-source-${name}`"
                      class="group-option"
                    >
                      <input
                        type="checkbox"
                        :checked="activeOutput.nameMappingSourceFields.includes(name)"
                        @change="toggleOutputNameMappingSourceField(activeOutput, name)"
                      />
                      <button
                        type="button"
                        class="group-option-btn"
                        :class="{ active: activeOutput.nameMappingSourceFields.includes(name) }"
                        @click.prevent="toggleOutputNameMappingSourceField(activeOutput, name)"
                      />
                      <span :title="name">{{ name }}</span>
                    </label>
                  </div>
                  <p class="hint-text">{{ $t("engineRules.messages.nameMappingSourceFieldsHint") }}</p>
                </div>
              </div>

              <label v-else-if="activeOutput.nameMode === 'expression'" class="field-block">
                <span>{{ $t("engineRules.fields.nameExpressionText") }}</span>
                <textarea v-model="activeOutput.nameExpressionText" rows="3" />
              </label>

              <div class="field-grid field-grid-two">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.valueMode") }}</span>
                  <select v-model="activeOutput.valueMode" @change="handleValueModeChange(activeOutput)">
                    <option v-for="mode in ENGINE_OUTPUT_VALUE_MODES" :key="mode" :value="mode">
                      {{ $t(`engineRules.valueModes.${mode}`) }}
                    </option>
                  </select>
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.dataType") }}</span>
                  <select v-model="activeOutput.dataType">
                    <option v-for="dataType in ENGINE_OUTPUT_DATA_TYPES" :key="dataType" :value="dataType">
                      {{ $t(`engineRules.dataTypes.${dataType}`) }}
                    </option>
                  </select>
                </label>
              </div>

              <div class="field-grid field-grid-two">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.sourceTable") }}</span>
                  <select v-model="activeOutput.sourceTableId" :disabled="activeOutput.valueMode === 'constant'">
                    <option value="">{{ $t("engineRules.messages.selectSource") }}</option>
                    <option v-for="source in sourceOptions" :key="`output-source-${source.id}`" :value="source.id">
                      {{ source.label }}
                    </option>
                  </select>
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.sourceField") }}</span>
                  <select
                    v-model="activeOutput.sourceField"
                    :disabled="!activeOutput.sourceTableId || activeOutput.valueMode === 'expression' || activeOutput.valueMode === 'mapping' || activeOutput.valueMode === 'constant'"
                  >
                    <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                    <option
                      v-for="name in fieldsForOutputField(activeOutput)"
                      :key="`${activeOutput.id}-${name}`"
                      :value="name"
                    >
                      {{ name }}
                    </option>
                  </select>
                </label>
              </div>

              <div class="field-grid field-grid-two">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.emptyValuePolicy") }}</span>
                  <select v-model="activeOutput.emptyValuePolicy">
                    <option v-for="policy in ENGINE_EMPTY_VALUE_POLICIES" :key="policy" :value="policy">
                      {{ $t(`engineRules.emptyValuePolicies.${policy}`) }}
                    </option>
                  </select>
                </label>
                <label v-if="activeOutput.emptyValuePolicy === 'constant'" class="field-block">
                  <span>{{ $t("engineRules.fields.defaultValue") }}</span>
                  <input v-model="activeOutput.defaultValue" type="text" />
                </label>
              </div>

              <div class="inspector-subsection">
                <div class="switch-row">
                  <span>{{ $t("engineRules.fields.fallbackEnabled") }}</span>
                  <label class="switch" :aria-label="$t('engineRules.fields.fallbackEnabled')">
                    <input v-model="activeOutput.fallbackConfig.enabled" type="checkbox" />
                    <span class="switch-track">
                      <span class="switch-thumb" />
                    </span>
                  </label>
                </div>
                <p class="hint-text">{{ $t("engineRules.messages.fallbackHint") }}</p>
                <template v-if="activeOutput.fallbackConfig.enabled">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.fallbackMode") }}</span>
                    <select v-model="activeOutput.fallbackConfig.mode" @change="handleFallbackModeChange(activeOutput)">
                      <option v-for="mode in ENGINE_OUTPUT_FALLBACK_MODES" :key="mode" :value="mode">
                        {{ $t(`engineRules.fallbackModes.${mode}`) }}
                      </option>
                    </select>
                  </label>

                  <label
                    v-if="activeOutput.fallbackConfig.mode === 'baseline' || activeOutput.fallbackConfig.mode === 'mapping'"
                    class="field-block"
                  >
                    <span>{{ $t("engineRules.fields.fallbackBaselineField") }}</span>
                    <select v-model="activeOutput.fallbackConfig.baselineField">
                      <option value="">{{ $t("engineRules.messages.selectResultField") }}</option>
                      <option v-for="name in resultFieldOptions" :key="`${activeOutput.id}-fallback-${name}`" :value="name">
                        {{ name }}
                      </option>
                    </select>
                  </label>

                  <label v-if="activeOutput.fallbackConfig.mode === 'mapping'" class="field-block">
                    <span>{{ $t("engineRules.fields.fallbackMappingGroupId") }}</span>
                    <select v-model="activeOutput.fallbackConfig.mappingGroupId">
                      <option value="">{{ $t("engineRules.messages.selectMapping") }}</option>
                      <option v-for="mapping in mappingOptions" :key="`${activeOutput.id}-fallback-mapping-${mapping.id}`" :value="mapping.id">
                        {{ mapping.name }}
                      </option>
                    </select>
                  </label>

                  <label v-if="activeOutput.fallbackConfig.mode === 'constant'" class="field-block">
                    <span>{{ $t("engineRules.fields.fallbackConstantValue") }}</span>
                    <input v-model="activeOutput.fallbackConfig.constantValue" type="text" />
                  </label>
                </template>
              </div>

              <label v-if="activeOutput.dataType === 'date'" class="field-block">
                <span>{{ $t("engineRules.fields.dateOutputFormat") }}</span>
                <input v-model="activeOutput.dateOutputFormat" type="text" placeholder="YYYY/M/D" />
                <p class="hint-text">{{ $t("engineRules.messages.dateOutputFormatHint") }}</p>
              </label>

              <label v-if="activeOutput.valueMode === 'constant'" class="field-block">
                <span>{{ $t("engineRules.fields.constantValue") }}</span>
                <input v-model="activeOutput.constantValue" type="text" />
              </label>

              <label v-else-if="activeOutput.valueMode === 'expression'" class="field-block">
                <span>{{ $t("engineRules.fields.expressionText") }}</span>
                <textarea v-model="activeOutput.expressionText" rows="4" />
              </label>

              <div v-else-if="activeOutput.valueMode === 'mapping'" class="inspector-subsection">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.mappingGroupId") }}</span>
                  <select v-model="activeOutput.mappingGroupId">
                    <option value="">{{ $t("engineRules.messages.selectMapping") }}</option>
                    <option v-for="mapping in mappingOptions" :key="mapping.id" :value="mapping.id">
                      {{ mapping.name }}
                    </option>
                  </select>
                </label>
                <div class="field-block">
                  <span>{{ $t("engineRules.fields.mappingSourceFields") }}</span>
                  <div class="group-options">
                    <label
                      v-for="name in fieldsForOutputField(activeOutput)"
                      :key="`${activeOutput.id}-mapping-source-${name}`"
                      class="group-option"
                    >
                      <input
                        type="checkbox"
                        :checked="activeOutput.mappingSourceFields.includes(name)"
                        @change="toggleMappingSourceField(activeOutput, name)"
                      />
                      <button
                        type="button"
                        class="group-option-btn"
                        :class="{ active: activeOutput.mappingSourceFields.includes(name) }"
                        @click.prevent="toggleMappingSourceField(activeOutput, name)"
                      />
                      <span :title="name">{{ name }}</span>
                    </label>
                  </div>
                  <p class="hint-text">{{ $t("engineRules.messages.mappingSourceFieldsHint") }}</p>
                </div>
              </div>

              <div v-else-if="activeOutput.valueMode === 'fill'" class="inspector-subsection">
                <div class="switch-row">
                  <span>{{ $t("engineRules.fields.fillEnabled") }}</span>
                  <label class="switch" :aria-label="$t('engineRules.fields.fillEnabled')">
                    <input v-model="activeOutput.fillConfig.enabled" type="checkbox" />
                    <span class="switch-track">
                      <span class="switch-thumb" />
                    </span>
                  </label>
                </div>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.baselineField") }}</span>
                  <select v-model="activeOutput.fillConfig.baselineField">
                    <option value="">{{ $t("engineRules.messages.selectResultField") }}</option>
                    <option v-for="name in resultFieldOptions" :key="`${activeOutput.id}-baseline-${name}`" :value="name">
                      {{ name }}
                    </option>
                  </select>
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.mappingGroupId") }}</span>
                  <select v-model="activeOutput.fillConfig.mappingGroupId">
                    <option value="">{{ $t("engineRules.messages.selectMapping") }}</option>
                    <option
                      v-for="mapping in mappingOptions"
                      :key="`${activeOutput.id}-fill-${mapping.id}`"
                      :value="mapping.id"
                    >
                      {{ mapping.name }}
                    </option>
                  </select>
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.constantValue") }}</span>
                  <input v-model="activeOutput.fillConfig.constantValue" type="text" />
                </label>
              </div>

              <div v-else-if="activeOutput.valueMode === 'text_aggregate'" class="inspector-subsection">
                <p class="hint-text">{{ $t("engineRules.messages.textAggregateHint") }}</p>
                <div class="field-grid field-grid-two">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.textAggregateDelimiterMode") }}</span>
                    <select v-model="activeOutput.textAggregateConfig.delimiterMode">
                      <option
                        v-for="mode in ENGINE_TEXT_AGGREGATE_DELIMITER_MODES"
                        :key="mode"
                        :value="mode"
                      >
                        {{ $t(`engineRules.textAggregateDelimiterModes.${mode}`) }}
                      </option>
                    </select>
                  </label>
                  <label v-if="activeOutput.textAggregateConfig.delimiterMode === 'custom'" class="field-block">
                    <span>{{ $t("engineRules.fields.textAggregateCustomDelimiter") }}</span>
                    <input v-model="activeOutput.textAggregateConfig.customDelimiter" type="text" />
                  </label>
                </div>

                <div class="switch-row">
                  <span>{{ $t("engineRules.fields.textAggregateDistinct") }}</span>
                  <label class="switch" :aria-label="$t('engineRules.fields.textAggregateDistinct')">
                    <input v-model="activeOutput.textAggregateConfig.distinct" type="checkbox" />
                    <span class="switch-track">
                      <span class="switch-thumb" />
                    </span>
                  </label>
                </div>

                <div class="field-grid field-grid-two">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.textAggregateSortField") }}</span>
                    <select v-model="activeOutput.textAggregateConfig.sortField">
                      <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                      <option
                        v-for="name in fieldsForOutputField(activeOutput)"
                        :key="`${activeOutput.id}-text-aggregate-sort-${name}`"
                        :value="name"
                      >
                        {{ name }}
                      </option>
                    </select>
                    <p class="hint-text">{{ $t("engineRules.messages.textAggregateSortFieldOptional") }}</p>
                  </label>
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.textAggregateSortDirection") }}</span>
                    <select v-model="activeOutput.textAggregateConfig.sortDirection">
                      <option v-for="direction in ENGINE_SORT_DIRECTIONS" :key="direction" :value="direction">
                        {{ $t(`engineRules.sortDirections.${direction}`) }}
                      </option>
                    </select>
                  </label>
                </div>
              </div>

              <div v-else-if="activeOutput.valueMode === 'dynamic_columns'" class="inspector-subsection">
                <div class="switch-row">
                  <span>{{ $t("engineRules.fields.dynamicEnabled") }}</span>
                  <label class="switch" :aria-label="$t('engineRules.fields.dynamicEnabled')">
                    <input v-model="activeOutput.dynamicColumnConfig.enabled" type="checkbox" />
                    <span class="switch-track">
                      <span class="switch-thumb" />
                    </span>
                  </label>
                </div>
                <div class="field-grid field-grid-two">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.dynamicColumnField") }}</span>
                    <select v-model="activeOutput.dynamicColumnConfig.columnField">
                      <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                      <option
                        v-for="name in fieldsForOutputField(activeOutput)"
                        :key="`${activeOutput.id}-dynamic-column-${name}`"
                        :value="name"
                      >
                        {{ name }}
                      </option>
                    </select>
                  </label>
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.dynamicValueField") }}</span>
                    <select v-model="activeOutput.dynamicColumnConfig.valueField">
                      <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                      <option
                        v-for="name in fieldsForOutputField(activeOutput)"
                        :key="`${activeOutput.id}-dynamic-value-${name}`"
                        :value="name"
                      >
                        {{ name }}
                      </option>
                    </select>
                  </label>
                </div>
                <div class="field-grid field-grid-two">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.namePrefix") }}</span>
                    <input v-model="activeOutput.dynamicColumnConfig.namePrefix" type="text" />
                  </label>
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.nameSuffix") }}</span>
                    <input v-model="activeOutput.dynamicColumnConfig.nameSuffix" type="text" />
                  </label>
                </div>
              </div>

              <div class="inspector-subsection">
                <div class="inspector-inline-head">
                  <h4>{{ $t("engineRules.fields.matchConditions") }}</h4>
                  <button type="button" class="secondary-btn" @click="addOutputMatchCondition(activeOutput)">
                    {{ $t("engineRules.actions.addMatch") }}
                  </button>
                </div>
                <div v-if="activeOutput.matchConditions.length > 0" class="stack-list">
                  <div
                    v-for="condition in activeOutput.matchConditions"
                    :key="condition.id"
                    class="stack-card stack-card-static"
                  >
                    <div class="field-grid field-grid-two">
                      <label class="field-block">
                        <span>{{ $t("engineRules.messages.selectResultField") }}</span>
                        <select v-model="condition.resultField">
                          <option value="">{{ $t("engineRules.messages.selectResultField") }}</option>
                          <option v-for="name in resultFieldOptions" :key="`${condition.id}-result-${name}`" :value="name">
                            {{ name }}
                          </option>
                        </select>
                      </label>
                      <label class="field-block">
                        <span>{{ $t("engineRules.fields.sourceField") }}</span>
                        <select v-model="condition.sourceField" :disabled="!activeOutput.sourceTableId">
                          <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                          <option
                            v-for="name in fieldsForOutputField(activeOutput)"
                            :key="`${condition.id}-${name}`"
                            :value="name"
                          >
                            {{ name }}
                          </option>
                        </select>
                      </label>
                    </div>
                    <button
                      type="button"
                      class="text-btn danger"
                      @click="removeOutputMatchCondition(activeOutput, condition.id)"
                    >
                      {{ $t("engineRules.actions.remove") }}
                    </button>
                  </div>
                </div>
                <p v-else class="hint-text">{{ $t("engineRules.messages.noMatches") }}</p>
              </div>

              <div class="inspector-subsection">
                <div class="inspector-inline-head">
                  <h4>{{ $t("engineRules.fields.filters") }}</h4>
                  <button type="button" class="secondary-btn" @click="addOutputFilter(activeOutput)">
                    {{ $t("engineRules.actions.addFilter") }}
                  </button>
                </div>
                <div v-if="activeOutput.filters.length > 0" class="stack-list">
                  <div v-for="filter in activeOutput.filters" :key="filter.id" class="stack-card stack-card-static">
                    <div class="field-grid field-grid-three">
                      <label class="field-block">
                        <span>{{ $t("engineRules.fields.field") }}</span>
                        <select v-model="filter.field" :disabled="!activeOutput.sourceTableId">
                          <option value="">{{ $t("engineRules.messages.selectField") }}</option>
                          <option
                            v-for="name in fieldsForOutputField(activeOutput)"
                            :key="`${filter.id}-field-${name}`"
                            :value="name"
                          >
                            {{ name }}
                          </option>
                        </select>
                      </label>
                      <label class="field-block">
                        <span>{{ $t("engineRules.fields.valueMode") }}</span>
                        <select v-model="filter.operator">
                          <option v-for="operator in ENGINE_SOURCE_FILTER_OPERATORS" :key="operator" :value="operator">
                            {{ $t(`engineRules.filterOperators.${operator}`) }}
                          </option>
                        </select>
                      </label>
                      <label class="field-block">
                        <span>{{ $t("engineRules.fields.filterValue") }}</span>
                        <input v-model="filter.valueText" type="text" />
                      </label>
                    </div>
                    <button type="button" class="text-btn danger" @click="removeOutputFilter(activeOutput, filter.id)">
                      {{ $t("engineRules.actions.remove") }}
                    </button>
                  </div>
                </div>
                <p v-else class="hint-text">{{ $t("engineRules.messages.noFilters") }}</p>
              </div>
            </section>
          </template>

          <template v-else-if="panelMatches('sheet')">
            <section class="inspector-section">
              <label class="field-block">
                <span>{{ $t("engineRules.fields.sheetMode") }}</span>
                <select v-model="draftRule.result.sheetConfig.mode">
                  <option v-for="mode in ENGINE_SHEET_MODES" :key="mode" :value="mode">
                    {{ $t(`engineRules.sheetModes.${mode}`) }}
                  </option>
                </select>
              </label>
              <label class="field-block">
                <span>{{ $t("engineRules.fields.splitSheetField") }}</span>
                <div class="field-grid">
                  <select
                    v-model="draftRule.result.sheetConfig.splitFieldScope"
                    :disabled="draftRule.result.sheetConfig.mode !== 'split_field'"
                  >
                    <option v-for="scope in ENGINE_SHEET_SPLIT_SCOPES" :key="scope" :value="scope">
                      {{ $t(`engineRules.splitScopes.${scope}`) }}
                    </option>
                  </select>
                  <select
                    v-if="draftRule.result.sheetConfig.splitFieldScope === 'source_field'"
                    v-model="draftRule.result.sheetConfig.splitSourceTableId"
                    :disabled="draftRule.result.sheetConfig.mode !== 'split_field'"
                  >
                    <option value="">{{ $t("engineRules.messages.selectSource") }}</option>
                    <option v-for="source in sourceOptions" :key="`sheet-source-${source.id}`" :value="source.id">
                      {{ source.label }}
                    </option>
                  </select>
                  <select
                    v-model="draftRule.result.sheetConfig.splitField"
                    :disabled="draftRule.result.sheetConfig.mode !== 'split_field'"
                  >
                    <option value="">{{ $t("engineRules.messages.selectSplitField") }}</option>
                    <option v-for="name in splitFieldOptions" :key="`sheet-${name}`" :value="name">
                      {{ name }}
                    </option>
                  </select>
                </div>
              </label>
              <label class="field-block">
                <span>{{ $t("engineRules.fields.sheetNameTemplate") }}</span>
                <input v-model="draftRule.result.sheetConfig.sheetNameTemplate" type="text" />
              </label>
            </section>
          </template>

          <template v-else-if="panelMatches('sheetTemplate')">
            <section class="inspector-section">
              <div class="switch-row">
                <span>{{ $t("engineRules.fields.sheetTitleEnabled") }}</span>
                <label class="switch" :aria-label="$t('engineRules.fields.sheetTitleEnabled')">
                  <input v-model="draftRule.sheetTemplate.titleEnabled" type="checkbox" />
                  <span class="switch-track">
                    <span class="switch-thumb" />
                  </span>
                </label>
              </div>

              <template v-if="draftRule.sheetTemplate.titleEnabled">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.titleTemplate") }}</span>
                  <input v-model="draftRule.sheetTemplate.titleTemplate" type="text" />
                </label>
                <p class="hint-text">{{ $t("engineRules.messages.titleTemplateHint") }}</p>

                <div class="inspector-subsection">
                  <div class="template-variable-group">
                    <span class="template-variable-label">{{ $t("engineRules.fields.availableSourceVariables") }}</span>
                    <div class="template-variable-list">
                      <button
                        v-for="variableKey in sourceTemplateVariables"
                        :key="`template-source-${variableKey}`"
                        type="button"
                        class="template-variable-chip"
                        @click="insertTitleVariable(variableKey)"
                      >
                        {{ variableKey }}
                      </button>
                    </div>
                  </div>
                  <div class="template-variable-group">
                    <span class="template-variable-label">{{ $t("engineRules.fields.availableResultVariables") }}</span>
                    <div class="template-variable-list">
                      <button
                        v-for="variableKey in resultTemplateVariables"
                        :key="`template-result-${variableKey}`"
                        type="button"
                        class="template-variable-chip"
                        @click="insertTitleVariable(variableKey)"
                      >
                        {{ variableKey }}
                      </button>
                    </div>
                  </div>
                  <p v-if="availableTemplateVariables.length === 0" class="hint-text">
                    {{ $t("engineRules.messages.noTemplateVariables") }}
                  </p>
                  <p v-else class="hint-text">{{ $t("engineRules.messages.titleVariableHint") }}</p>
                </div>

                <div class="field-grid field-grid-two">
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.templateHeaderRowIndex") }}</span>
                    <input v-model.number="draftRule.sheetTemplate.headerRowIndex" type="number" min="1" />
                  </label>
                  <label class="field-block">
                    <span>{{ $t("engineRules.fields.dataStartRowIndex") }}</span>
                    <input v-model.number="draftRule.sheetTemplate.dataStartRowIndex" type="number" min="1" />
                  </label>
                </div>

                <p class="hint-text">
                  {{
                    $t("engineRules.messages.mergePreview", {
                      range: mergeRangeEndCell,
                      headerRow: draftRule.sheetTemplate.headerRowIndex,
                      dataRow: draftRule.sheetTemplate.dataStartRowIndex,
                    })
                  }}
                </p>
                <p v-if="usedTemplateVariables.length === 0" class="hint-text">
                  {{ $t("engineRules.messages.noTitleVariablesUsed") }}
                </p>
              </template>
              <p v-else class="hint-text">{{ $t("engineRules.messages.titleTemplateEmpty") }}</p>
            </section>
          </template>

          <template v-else-if="panelMatches('totalRow')">
            <section class="inspector-section">
              <div class="switch-row">
                <span>{{ $t("engineRules.fields.totalRowEnabled") }}</span>
                <label class="switch" :aria-label="$t('engineRules.fields.totalRowEnabled')">
                  <input v-model="draftRule.result.totalRow.enabled" type="checkbox" />
                  <span class="switch-track">
                    <span class="switch-thumb" />
                  </span>
                </label>
              </div>
              <p class="hint-text">{{ $t("engineRules.messages.totalRowHint") }}</p>
              <template v-if="draftRule.result.totalRow.enabled">
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.totalRowLabel") }}</span>
                  <input v-model="draftRule.result.totalRow.label" type="text" />
                </label>
                <label class="field-block">
                  <span>{{ $t("engineRules.fields.totalRowLabelField") }}</span>
                  <select v-model="draftRule.result.totalRow.labelField">
                    <option value="">{{ $t("engineRules.messages.selectOutputField") }}</option>
                    <option v-for="name in totalRowLabelFieldOptions" :key="`total-label-${name}`" :value="name">
                      {{ name }}
                    </option>
                  </select>
                </label>
                <div class="field-block">
                  <span>{{ $t("engineRules.fields.totalRowSumFields") }}</span>
                  <div class="group-options">
                    <label v-for="name in outputFieldNameOptions" :key="`sum-${name}`" class="group-option">
                      <input
                        type="checkbox"
                        :checked="draftRule.result.totalRow.sumFields.includes(name)"
                        @change="toggleTotalRowSumField(name)"
                      />
                      <button
                        type="button"
                        class="group-option-btn"
                        :class="{ active: draftRule.result.totalRow.sumFields.includes(name) }"
                        @click.prevent="toggleTotalRowSumField(name)"
                      />
                      <span :title="name">{{ name }}</span>
                    </label>
                  </div>
                </div>
              </template>
            </section>
          </template>
        </div>
      </aside>
    </section>
  </main>
</template>

<style scoped>
.engine-editor-page {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  background:
    radial-gradient(circle at top left, rgba(68, 162, 255, 0.12), transparent 28%),
    radial-gradient(circle at bottom right, rgba(15, 118, 110, 0.12), transparent 24%),
    var(--bg-main);
  color: var(--text-main);
  padding: 14px;
  display: grid;
  gap: 12px;
  grid-template-rows: auto 1fr;
  overflow: hidden;
}

.engine-editor-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.engine-editor-title-block {
  display: grid;
  gap: 4px;
}

.engine-editor-eyebrow {
  margin: 0;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.engine-editor-title-block h1 {
  margin: 0;
  font-size: 22px;
  line-height: 1.1;
}

.engine-editor-header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.engine-editor-shell {
  min-height: 0;
  display: grid;
  gap: 12px;
  grid-template-columns: 220px minmax(0, 1fr) 380px;
}

.engine-editor-sidebar,
.engine-editor-canvas,
.engine-editor-inspector {
  min-height: 0;
  border: 1px solid var(--stroke-soft);
  border-radius: 18px;
  background: var(--bg-card);
  box-shadow: 0 18px 40px rgba(10, 15, 20, 0.08);
}

.engine-editor-sidebar {
  display: grid;
  gap: 14px;
  padding: 12px;
  overflow: auto;
  align-content: start;
  grid-auto-rows: max-content;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.engine-editor-sidebar::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.sidebar-section {
  display: grid;
  gap: 8px;
  align-content: start;
}

.tree-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tree-section-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tree-list {
  display: grid;
  gap: 6px;
}

.tree-item {
  width: 100%;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: var(--text-main);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  min-width: 0;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease,
    transform 120ms ease;
}

.tree-item:hover {
  background: rgba(68, 162, 255, 0.08);
}

.tree-item.active {
  border-color: rgba(68, 162, 255, 0.38);
  background: linear-gradient(135deg, rgba(68, 162, 255, 0.12), rgba(15, 118, 110, 0.08));
  transform: translateX(2px);
}

.tree-item-root {
  font-weight: 600;
}

.tree-item-child {
  padding-left: 18px;
}

.tree-item-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-btn {
  width: 30px;
  height: 30px;
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: var(--bg-input);
  color: var(--text-main);
  cursor: pointer;
}

.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.collapse-btn {
  font-size: 14px;
  line-height: 1;
  padding: 0;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: rgba(148, 163, 184, 0.5);
}

.status-dot.ready {
  background: #14b8a6;
}

.status-dot.partial {
  background: #f59e0b;
}

.status-dot.empty {
  background: rgba(148, 163, 184, 0.35);
}

.engine-editor-canvas {
  display: grid;
  gap: 14px;
  padding: 14px;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.engine-editor-canvas::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.banner-card {
  border-radius: 14px;
  padding: 12px 14px;
  display: grid;
  gap: 6px;
}

.error-banner {
  border: 1px solid rgba(220, 38, 38, 0.22);
  background: rgba(220, 38, 38, 0.08);
  color: #b91c1c;
}

.success-banner {
  border: 1px solid rgba(16, 185, 129, 0.24);
  background: rgba(16, 185, 129, 0.08);
  color: #047857;
}

.banner-card p {
  margin: 0;
}

.sheet-canvas {
  display: grid;
  gap: 10px;
  min-height: 0;
}

.sheet-toolbar,
.sheet-formula-bar,
.sheet-tabs {
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(255, 255, 255, 0.58));
}

.sheet-toolbar {
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sheet-toolbar-meta,
.sheet-toolbar-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sheet-toolbar-title {
  font-size: var(--fs-sm);
  font-weight: 700;
}

.sheet-toolbar-badge,
.sheet-toolbar-stat {
  border: 1px solid rgba(68, 162, 255, 0.16);
  border-radius: 999px;
  background: rgba(68, 162, 255, 0.08);
  color: var(--text-main);
  font-size: var(--fs-caption);
  padding: 4px 9px;
}

.sheet-formula-bar {
  padding: 8px 10px;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 10px;
}

.sheet-formula-label {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: rgba(68, 162, 255, 0.08);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
}

.sheet-formula-input {
  min-height: 38px;
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: white;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: var(--fs-sm);
  color: var(--text-main);
}

.sheet-board {
  position: relative;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--stroke-soft);
  border-radius: 16px;
  background: #f8fafc;
  display: grid;
  grid-template-columns: 44px repeat(var(--sheet-column-count, 8), minmax(118px, 1fr));
  grid-template-rows: 34px repeat(var(--sheet-row-count, 18), 42px);
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.sheet-board::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.sheet-corner,
.sheet-column-header,
.sheet-row-header {
  position: sticky;
  z-index: 2;
  background: #eef2f7;
  color: #475569;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid #dbe2ea;
  border-bottom: 1px solid #dbe2ea;
}

.sheet-corner {
  grid-column: 1;
  grid-row: 1;
  left: 0;
  top: 0;
  z-index: 4;
}

.sheet-column-header {
  top: 0;
}

.sheet-row-header {
  left: 0;
}

.sheet-grid-surface {
  grid-column: 2 / -1;
  grid-row: 2 / -1;
  display: grid;
  grid-template-columns: repeat(var(--sheet-column-count, 8), minmax(118px, 1fr));
  grid-template-rows: repeat(var(--sheet-row-count, 18), 42px);
  position: relative;
  background:
    linear-gradient(#e5e7eb 1px, transparent 1px),
    linear-gradient(90deg, #e5e7eb 1px, transparent 1px);
  background-size: 100% 42px, calc(100% / var(--sheet-column-count, 8)) 100%;
}

.sheet-cell {
  min-width: 0;
  min-height: 0;
  border-right: 1px solid #e5e7eb;
  border-bottom: 1px solid #e5e7eb;
  background: rgba(255, 255, 255, 0.88);
  color: #1e293b;
  font-size: 12px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-cell.clickable {
  cursor: pointer;
  transition:
    box-shadow 120ms ease,
    background 120ms ease;
}

.sheet-cell.clickable:hover {
  background: rgba(219, 234, 254, 0.9);
}

.sheet-cell-title {
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  background: rgba(254, 240, 138, 0.3);
}

.sheet-cell-header {
  font-weight: 700;
  background: rgba(226, 232, 240, 0.65);
}

.sheet-cell-sample {
  background: rgba(255, 255, 255, 0.96);
}

.sheet-cell-total {
  font-weight: 700;
  background: rgba(220, 252, 231, 0.55);
}

.sheet-cell.active {
  box-shadow: inset 0 0 0 2px rgba(68, 162, 255, 0.42);
}

.sheet-tabs {
  padding: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.sheet-tab {
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: white;
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-caption);
  padding: 7px 11px;
  cursor: pointer;
}

.sheet-tab.active {
  border-color: rgba(68, 162, 255, 0.32);
  background: rgba(68, 162, 255, 0.08);
}

.canvas-stats {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.stat-card {
  border: 1px solid var(--stroke-soft);
  border-radius: 16px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.3));
  padding: 12px;
  display: grid;
  gap: 6px;
}

.stat-label {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.stat-card strong {
  font-size: 24px;
  line-height: 1;
}

.canvas-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
}

.canvas-card {
  border: 1px solid var(--stroke-soft);
  border-radius: 18px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.74), rgba(255, 255, 255, 0.48)),
    var(--bg-card);
  padding: 14px;
  display: grid;
  gap: 14px;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    transform 120ms ease,
    box-shadow 120ms ease;
}

.canvas-card:hover {
  transform: translateY(-1px);
}

.canvas-card.active {
  border-color: rgba(68, 162, 255, 0.38);
  box-shadow: 0 12px 30px rgba(68, 162, 255, 0.12);
}

.canvas-card-wide {
  grid-column: span 2;
}

.canvas-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.canvas-card-head h3 {
  margin: 0 0 4px;
  font-size: 16px;
}

.canvas-list {
  display: grid;
  gap: 10px;
}

.mini-card,
.stack-card {
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  background: var(--bg-input);
  padding: 12px;
  display: grid;
  gap: 6px;
  text-align: left;
  color: var(--text-main);
}

.mini-card {
  cursor: pointer;
}

.stack-card {
  position: relative;
}

.stack-card-compact {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
}

.stack-card-main {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.stack-card-main-inline {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stack-card-main-clickable {
  cursor: pointer;
}

.stack-card-compact .mini-card-head {
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
}

.mini-card-head-inline {
  flex: 1 1 auto;
}

.stack-card-compact .mini-card-head > span:first-child,
.stack-card-compact .stack-card-title-wrap,
.stack-card-compact .stack-card-title-wrap > span:last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stack-card-compact .mini-card-meta {
  max-width: 100%;
  justify-self: start;
  text-align: left;
  flex: 0 0 auto;
  white-space: nowrap;
}

.stack-card-draggable {
  cursor: grab;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease,
    border-color 120ms ease;
}

.stack-card-draggable:active {
  cursor: grabbing;
}

.stack-card-draggable.dragging {
  opacity: 0.55;
  transform: scale(0.99);
}

.stack-card-draggable.drag-over-before::before,
.stack-card-draggable.drag-over-after::after {
  content: "";
  position: absolute;
  left: 10px;
  right: 10px;
  height: 3px;
  border-radius: 999px;
  background: var(--accent);
}

.stack-card-draggable.drag-over-before::before {
  top: -2px;
}

.stack-card-draggable.drag-over-after::after {
  bottom: -2px;
}

.stack-card-title-wrap {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.stack-card-grip {
  color: var(--text-muted);
  font-weight: 700;
  letter-spacing: 0.04em;
  flex: 0 0 auto;
  cursor: grab;
  user-select: none;
}

.stack-card-grip:active {
  cursor: grabbing;
}

.stack-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.sort-btn {
  width: 24px;
  height: 24px;
  border-radius: 8px;
  font-size: 12px;
}

.mini-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.mini-card-meta {
  color: var(--text-muted);
  font-size: var(--fs-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.metric-pill {
  border: 1px solid rgba(68, 162, 255, 0.16);
  border-radius: 999px;
  background: rgba(68, 162, 255, 0.08);
  color: var(--text-main);
  font-size: var(--fs-caption);
  padding: 5px 10px;
}

.metric-pill-action {
  cursor: pointer;
}

.canvas-summary {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-sm);
  line-height: 1.5;
}

.engine-editor-inspector {
  display: grid;
  grid-template-rows: auto 1fr;
  overflow: hidden;
}

.inspector-head {
  border-bottom: 1px solid var(--stroke-soft);
  padding: 14px 16px;
  display: grid;
  gap: 8px;
}

.inspector-caption {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.inspector-head h2 {
  margin: 0;
  font-size: 18px;
}

.inspector-body {
  min-height: 0;
  overflow: auto;
  padding: 16px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.inspector-body::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.inspector-section,
.inspector-subsection,
.stack-list {
  display: grid;
  gap: 10px;
}

.inspector-inline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.inspector-inline-head h3,
.inspector-inline-head h4 {
  margin: 0;
  font-size: 15px;
}

.field-grid {
  display: grid;
  gap: 12px;
}

.field-grid-two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.field-grid-three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.field-block {
  display: grid;
  gap: 6px;
  font-size: var(--fs-sm);
}

.field-block > span,
.field-block-label {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.field-block input[type="text"],
.field-block input[type="number"],
.field-block select,
.field-block textarea,
.rule-table input[type="text"],
.rule-table input[type="number"],
.rule-table select,
.rule-table textarea {
  width: 100%;
  border: 1px solid var(--stroke-soft);
  border-radius: 12px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 9px 11px;
}

.field-block input[type="text"]:focus-visible,
.field-block input[type="number"]:focus-visible,
.field-block select:focus-visible,
.field-block textarea:focus-visible,
.rule-table input[type="text"]:focus-visible,
.rule-table input[type="number"]:focus-visible,
.rule-table select:focus-visible,
.rule-table textarea:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.field-block textarea,
.rule-table textarea {
  resize: vertical;
  min-height: 88px;
}

.secondary-btn {
  border: 1px solid var(--btn-border);
  border-radius: 12px;
  background: var(--btn-bg);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1;
  padding: 10px 13px;
  cursor: pointer;
}

.secondary-btn:hover:not(:disabled) {
  background: var(--btn-bg-hover);
}

.secondary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.primary-btn {
  border: 1px solid color-mix(in srgb, var(--accent) 82%, black 18%);
  border-radius: 12px;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 72%, #0f766e 28%));
  color: white;
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1;
  padding: 10px 13px;
  cursor: pointer;
}

.primary-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.danger-outline {
  border-color: var(--danger);
  color: var(--danger);
}

.text-btn {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}

.text-btn.danger {
  color: var(--danger);
}

.hint-text {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  background: var(--bg-input);
}

.switch {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.switch input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.switch-track {
  width: 44px;
  height: 24px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.35);
  padding: 2px;
  display: flex;
  align-items: center;
  transition: background 120ms ease;
}

.switch-thumb {
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: white;
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.18);
  transition: transform 120ms ease;
}

.switch input:checked + .switch-track {
  background: var(--accent);
}

.switch input:checked + .switch-track .switch-thumb {
  transform: translateX(20px);
}

.source-upload-row {
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  background: var(--bg-input);
  padding: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.source-upload-meta {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.source-upload-meta strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.header-chip {
  border: 1px solid var(--stroke-soft);
  border-radius: 999px;
  background: rgba(68, 162, 255, 0.08);
  color: var(--text-main);
  font-size: var(--fs-caption);
  padding: 4px 9px;
}

.sample-table-wrap {
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  overflow: hidden;
}

.sample-table {
  width: 100%;
  border-collapse: collapse;
}

.sample-table th,
.sample-table td,
.rule-table th,
.rule-table td {
  padding: 10px 8px;
  text-align: left;
  border-bottom: 1px solid var(--stroke-soft);
  vertical-align: top;
}

.sample-table th,
.rule-table th {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  font-weight: 600;
  background: color-mix(in srgb, var(--bg-card) 92%, var(--bg-input) 8%);
}

.rule-table {
  width: 100%;
  border-collapse: collapse;
}

.compact-table th,
.compact-table td {
  padding-block: 8px;
}

.operation-col {
  width: 86px;
}

.stack-card-static {
  cursor: default;
}

.group-options {
  display: grid;
  gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.group-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.group-option input {
  display: none;
}

.group-option-btn {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  border: 1px solid var(--stroke-soft);
  background: transparent;
  flex: 0 0 auto;
}

.group-option-btn.active {
  background: var(--accent);
  border-color: var(--accent);
}

.template-variable-group {
  display: grid;
  gap: 8px;
}

.template-variable-label {
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.template-variable-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.template-variable-chip {
  border: 1px solid var(--stroke-soft);
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-caption);
  line-height: 1;
  padding: 7px 11px;
  cursor: pointer;
}

.template-variable-chip:hover {
  border-color: var(--accent);
}

@media (max-width: 1180px) {
  .engine-editor-shell {
    grid-template-columns: 210px minmax(0, 1fr);
  }

  .engine-editor-inspector {
    grid-column: 1 / -1;
    min-height: 480px;
  }

  .canvas-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .sheet-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 900px) {
  .engine-editor-page {
    height: auto;
    min-height: 100%;
  }

  .engine-editor-header {
    flex-direction: column;
    align-items: stretch;
  }

  .engine-editor-shell {
    grid-template-columns: 1fr;
  }

  .canvas-grid,
  .canvas-stats,
  .field-grid-two,
  .field-grid-three {
    grid-template-columns: 1fr;
  }

  .canvas-card-wide {
    grid-column: span 1;
  }

  .sheet-output-head,
  .sheet-output-row {
    grid-template-columns: 1fr;
  }
}
</style>
