<script setup lang="ts">
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useMappingStore, useRuleStore } from "../store";
import {
  RULE_RESULT_FILL_VALUE_MODES,
  RULE_SHEET_TITLE_CONFLICT_MODES,
  cloneRuleDefinition,
  createEmptyRuleDefinition,
  createEmptyRuleOutputColumn,
  createEmptyRuleResultFillFieldRule,
  createEmptyRuleSheetTemplate,
  type RuleDefinition,
  type RuleOutputColumn,
  type RuleResultFillFieldRule,
} from "../types/rule";
import {
  collectAvailableTemplateVariableKeys,
  extractTitleTemplateVariables,
  syncTemplateVariableConfigs,
  toExcelColumnLabel,
} from "../utils/ruleTemplate";
import { parseSpreadsheetFile, type SpreadsheetPreview, type SpreadsheetSheetPreview } from "../utils/spreadsheetParser";
import { validateRuleDraft } from "../utils/ruleValidator";

type RuleEditorPayload = {
  ruleId: string | null;
};

const MAIN_WINDOW_LABEL = "main";

const appWindow = getCurrentWindow();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { ruleStoreError, saveRule, deleteRule, getRuleById, reloadRules } = useRuleStore();
const { mappingGroups } = useMappingStore();

const activeRuleId = ref("");
const sourceFileInputRef = ref<HTMLInputElement | null>(null);
const draftRule = ref<RuleDefinition>(createEmptyRuleDefinition());
const sourcePreview = ref<SpreadsheetPreview | null>(null);
const validationErrors = ref<string[]>([]);
const actionMessage = ref("");
const isParsingSource = ref(false);
const isSaving = ref(false);
const sortingColumnId = ref("");
const sortingOverColumnId = ref("");

let unlistenSetRule: UnlistenFn | undefined;

const availableHeaders = computed(() => draftRule.value.sourceHeaders);
const mappingOptions = computed(() =>
  mappingGroups.value.map((group) => ({
    id: group.id,
    label: group.name,
    count: group.entries.length,
  })),
);
const activeSheetPreview = computed<SpreadsheetSheetPreview | null>(() => {
  if (!sourcePreview.value) {
    return null;
  }
  return sourcePreview.value.sheets.find((sheet) => sheet.name === draftRule.value.sourceSheetName) ?? null;
});
const canEdit = computed(() => !isSaving.value);
const titleConflictModes = RULE_SHEET_TITLE_CONFLICT_MODES;
const resultFillValueModes = RULE_RESULT_FILL_VALUE_MODES;
const sourceTemplateVariables = computed(() => draftRule.value.sourceHeaders);

function getColumnTargetFields(column: RuleOutputColumn): string[] {
  if (column.valueMode === "conditional_target") {
    return [column.conditionalHitTargetField.trim(), column.conditionalMissTargetField.trim()].filter(Boolean);
  }
  return [column.targetField.trim()].filter(Boolean);
}

const outputTemplateVariables = computed(() => {
  const variableKeys = new Set<string>();
  draftRule.value.outputColumns.forEach((column) => {
    getColumnTargetFields(column).forEach((field) => {
      variableKeys.add(field);
    });
  });
  return Array.from(variableKeys);
});
const outputTargetFields = computed(() => outputTemplateVariables.value.filter((item) => item.trim().length > 0));
const resultFillTargetFields = computed(() => outputTargetFields.value);
const totalRowTargetFields = computed(() => outputTargetFields.value);
const availableTemplateVariables = computed(() =>
  collectAvailableTemplateVariableKeys(draftRule.value.sourceHeaders, draftRule.value.outputColumns),
);
const usedTitleVariables = computed(() =>
  extractTitleTemplateVariables(draftRule.value.sheetTemplate.titleTemplate),
);
const mergeRangeEndCell = computed(() => {
  const outputFieldCount =
    draftRule.value.outputColumns.reduce((count, column) => {
      return count + getColumnTargetFields(column).length;
    }, 0) || 1;
  return `${toExcelColumnLabel(outputFieldCount)}1`;
});

function resetFeedback(): void {
  validationErrors.value = [];
  actionMessage.value = "";
}

function syncDraftWithHeaders(headers: string[]): void {
  const headerSet = new Set(headers);
  draftRule.value.groupByFields = draftRule.value.groupByFields.filter((field) => headerSet.has(field)).slice(0, 1);
  draftRule.value.summaryGroupByFields = draftRule.value.summaryGroupByFields.filter((field) => headerSet.has(field));
  if (!headerSet.has(draftRule.value.resultFill.baselineSourceField)) {
    draftRule.value.resultFill.baselineSourceField = "";
  }
  draftRule.value.resultFill.fieldRules = draftRule.value.resultFill.fieldRules.map((fieldRule) => ({
    ...fieldRule,
    sourceField: headerSet.has(fieldRule.sourceField) ? fieldRule.sourceField : "",
    mappingSourceFields: fieldRule.mappingSourceFields.filter((field) => headerSet.has(field)),
  }));
  draftRule.value.outputColumns = draftRule.value.outputColumns.map((column) => {
    if (
      (column.valueMode === "source" || column.valueMode === "mapping") &&
      column.sourceField &&
      !headerSet.has(column.sourceField)
    ) {
      return {
        ...column,
        sourceField: "",
      };
    }

    if (column.valueMode === "mapping_multi") {
      return {
        ...column,
        mappingSourceFields: column.mappingSourceFields.filter((field) => headerSet.has(field)),
      };
    }

    const patch: Partial<RuleOutputColumn> = {};
    if (column.valueMode === "conditional_target") {
      if (column.conditionalJudgeField && !headerSet.has(column.conditionalJudgeField)) {
        patch.conditionalJudgeField = "";
      }
      if (column.conditionalValueSourceField && !headerSet.has(column.conditionalValueSourceField)) {
        patch.conditionalValueSourceField = "";
      }
    }
    if (column.aggregateSourceField && !headerSet.has(column.aggregateSourceField)) {
      patch.aggregateSourceField = "";
    }
    if (column.aggregateNumeratorField && !headerSet.has(column.aggregateNumeratorField)) {
      patch.aggregateNumeratorField = "";
    }
    if (column.aggregateDenominatorField && !headerSet.has(column.aggregateDenominatorField)) {
      patch.aggregateDenominatorField = "";
    }
    if (column.aggregateJoinSourceField && !headerSet.has(column.aggregateJoinSourceField)) {
      patch.aggregateJoinSourceField = "";
    }
    if (column.dateSourceField && !headerSet.has(column.dateSourceField)) {
      patch.dateSourceField = "";
    }

    if (Object.keys(patch).length === 0) {
      return column;
    }
    return { ...column, ...patch };
  });
  syncResultFillFieldRules();
  syncTotalRowConfig();
}

function setDraftRule(rule: RuleDefinition): void {
  const nextRule = cloneRuleDefinition(rule);
  nextRule.groupByFields = nextRule.groupByFields.slice(0, 1);
  nextRule.summaryGroupByFields = Array.from(new Set(nextRule.summaryGroupByFields.map((item) => item.trim()).filter(Boolean)));
  if (nextRule.summaryFillMissingPrimary && !nextRule.resultFill.enabled) {
    nextRule.resultFill.enabled = true;
  }
  draftRule.value = nextRule;
  syncResultFillFieldRules();
  syncTotalRowConfig();
  syncTitleVariableConfigs();
}

function selectGroupByField(header: string): void {
  if (draftRule.value.groupByFields[0] === header) {
    draftRule.value.groupByFields = [];
    return;
  }
  draftRule.value.groupByFields = [header];
}

function toggleSummaryGroupField(header: string): void {
  if (draftRule.value.summaryGroupByFields.includes(header)) {
    draftRule.value.summaryGroupByFields = draftRule.value.summaryGroupByFields.filter((item) => item !== header);
    return;
  }
  draftRule.value.summaryGroupByFields = [...draftRule.value.summaryGroupByFields, header];
}

function toggleMappingSourceField(column: RuleOutputColumn, header: string): void {
  if (column.mappingSourceFields.includes(header)) {
    column.mappingSourceFields = column.mappingSourceFields.filter((item) => item !== header);
    return;
  }
  column.mappingSourceFields = [...column.mappingSourceFields, header];
}

function handleGroupExcludeModeChange(): void {
  if (draftRule.value.groupExcludeMode === "none") {
    draftRule.value.groupExcludeValuesText = "";
    draftRule.value.groupExcludeMappingSection = "";
    return;
  }

  if (draftRule.value.groupExcludeMode === "manual_values") {
    draftRule.value.groupExcludeMappingSection = "";
    return;
  }

  draftRule.value.groupExcludeValuesText = "";
}

function clearGroupBySectionConfig(): void {
  draftRule.value.groupByFields = [];
  draftRule.value.groupExcludeMode = "none";
  draftRule.value.groupExcludeValuesText = "";
  draftRule.value.groupExcludeMappingSection = "";
  draftRule.value.summaryGroupByFields = [];
  draftRule.value.summaryFillMissingPrimary = false;
  draftRule.value.resultFill.enabled = false;
}

function syncResultFillFieldRules(): void {
  const fieldRuleMap = new Map(
    draftRule.value.resultFill.fieldRules.map((item) => [item.targetField.trim(), item] as const),
  );
  draftRule.value.resultFill.fieldRules = resultFillTargetFields.value.map((targetField) => {
    const current = fieldRuleMap.get(targetField);
    if (!current) {
      return createEmptyRuleResultFillFieldRule(targetField);
    }
    return {
      ...current,
      targetField,
      mappingSourceFields: [...current.mappingSourceFields],
    };
  });
}

function syncTotalRowConfig(): void {
  const targetFieldSet = new Set(totalRowTargetFields.value);
  if (!targetFieldSet.has(draftRule.value.totalRow.labelField)) {
    draftRule.value.totalRow.labelField = "";
  }
  draftRule.value.totalRow.sumFields = Array.from(
    new Set(
      draftRule.value.totalRow.sumFields
        .map((field) => field.trim())
        .filter((field) => targetFieldSet.has(field)),
    ),
  );
}

function handleTotalRowEnabledChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  draftRule.value.totalRow.enabled = input.checked;
  if (!draftRule.value.totalRow.enabled) {
    return;
  }
  if (!draftRule.value.totalRow.label.trim()) {
    draftRule.value.totalRow.label = "总计";
  }
  if (!draftRule.value.totalRow.labelField && totalRowTargetFields.value.length > 0) {
    draftRule.value.totalRow.labelField = totalRowTargetFields.value[0] || "";
  }
}

function toggleTotalRowSumField(targetField: string): void {
  if (draftRule.value.totalRow.sumFields.includes(targetField)) {
    draftRule.value.totalRow.sumFields = draftRule.value.totalRow.sumFields.filter((item) => item !== targetField);
    return;
  }
  draftRule.value.totalRow.sumFields = [...draftRule.value.totalRow.sumFields, targetField];
}

function getResultFillRulesByColumn(column: RuleOutputColumn): RuleResultFillFieldRule[] {
  const targetFields = new Set(getColumnTargetFields(column));
  if (targetFields.size === 0) {
    return [];
  }
  return draftRule.value.resultFill.fieldRules.filter((item) => targetFields.has(item.targetField));
}

function handleResultFillEnabledChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  draftRule.value.resultFill.enabled = input.checked;
  if (!draftRule.value.resultFill.enabled) {
    return;
  }
  if (!draftRule.value.resultFill.baselineSourceField) {
    draftRule.value.resultFill.baselineSourceField = draftRule.value.summaryGroupByFields[0] || "";
  }
}

function handleResultFillFieldModeChange(fieldRule: RuleResultFillFieldRule): void {
  fieldRule.constantValue = "";
  fieldRule.sourceField = "";
  fieldRule.mappingSourceFields = [];
  fieldRule.mappingSection = "";
  fieldRule.copyFromTargetField = "";
}

function toggleResultFillMappingSourceField(fieldRule: RuleResultFillFieldRule, header: string): void {
  if (fieldRule.mappingSourceFields.includes(header)) {
    fieldRule.mappingSourceFields = fieldRule.mappingSourceFields.filter((item) => item !== header);
    return;
  }
  fieldRule.mappingSourceFields = [...fieldRule.mappingSourceFields, header];
}

async function handleGroupByEnabledChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const nextEnabled = input.checked;
  if (nextEnabled) {
    draftRule.value.groupByEnabled = true;
    return;
  }

  const confirmed = await confirm(t("rules.messages.groupByDisableConfirm"));
  if (!confirmed) {
    input.checked = true;
    draftRule.value.groupByEnabled = true;
    return;
  }

  draftRule.value.groupByEnabled = false;
  clearGroupBySectionConfig();
}

function syncTitleVariableConfigs(): void {
  draftRule.value.sheetTemplate.variableConfigs = syncTemplateVariableConfigs(
    usedTitleVariables.value,
    draftRule.value.sheetTemplate.variableConfigs,
  );
}

function clearSheetTemplateSectionConfig(): void {
  draftRule.value.sheetTemplate = createEmptyRuleSheetTemplate();
}

function normalizeTitleLayoutWhenEnabled(): void {
  if (draftRule.value.sheetTemplate.headerRowIndex <= 1) {
    draftRule.value.sheetTemplate.headerRowIndex = 2;
  }
  if (draftRule.value.sheetTemplate.dataStartRowIndex <= draftRule.value.sheetTemplate.headerRowIndex) {
    draftRule.value.sheetTemplate.dataStartRowIndex = draftRule.value.sheetTemplate.headerRowIndex + 1;
  }
}

async function handleTitleEnabledChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const nextEnabled = input.checked;
  if (nextEnabled) {
    draftRule.value.sheetTemplate.titleEnabled = true;
    normalizeTitleLayoutWhenEnabled();
    return;
  }

  const confirmed = await confirm(t("rules.messages.sheetTemplateDisableConfirm"));
  if (!confirmed) {
    input.checked = true;
    draftRule.value.sheetTemplate.titleEnabled = true;
    return;
  }

  draftRule.value.sheetTemplate.titleEnabled = false;
  clearSheetTemplateSectionConfig();
}

function insertTitleVariable(variableKey: string): void {
  if (!canEdit.value) {
    return;
  }

  const token = `{{${variableKey}}}`;
  const current = draftRule.value.sheetTemplate.titleTemplate.trimEnd();
  draftRule.value.sheetTemplate.titleTemplate = current ? `${current} ${token}` : token;
}

function resolveRuleIdFromQuery(): string | null {
  const queryRuleId = route.query.ruleId;
  if (typeof queryRuleId !== "string") {
    return null;
  }
  const normalized = queryRuleId.trim();
  return normalized ? normalized : null;
}

async function loadRule(ruleId: string | null): Promise<void> {
  resetFeedback();
  sourcePreview.value = null;

  if (!ruleId) {
    activeRuleId.value = "";
    setDraftRule(createEmptyRuleDefinition());
    return;
  }

  await reloadRules();
  const selected = getRuleById(ruleId);
  if (!selected) {
    activeRuleId.value = "";
    setDraftRule(createEmptyRuleDefinition());
    validationErrors.value = [t("rules.messages.ruleNotFound")];
    return;
  }

  activeRuleId.value = selected.id;
  setDraftRule(selected);
}

function openSourceFilePicker(): void {
  sourceFileInputRef.value?.click();
}

function applySheet(sheetName: string): void {
  if (!sourcePreview.value) {
    return;
  }
  const sheet = sourcePreview.value.sheets.find((item) => item.name === sheetName);
  if (!sheet) {
    return;
  }
  draftRule.value.sourceSheetName = sheet.name;
  draftRule.value.sourceHeaders = [...sheet.headers];
  syncDraftWithHeaders(sheet.headers);
}

async function handleSourceFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  isParsingSource.value = true;
  resetFeedback();

  try {
    const preview = await parseSpreadsheetFile(file);
    sourcePreview.value = preview;
    draftRule.value.sourceFileName = preview.fileName;

    if (preview.sheets.length === 0) {
      draftRule.value.sourceSheetName = "";
      draftRule.value.sourceHeaders = [];
      validationErrors.value = [t("rules.messages.noSheetFound")];
      return;
    }

    applySheet(preview.sheets[0].name);
    actionMessage.value = t("rules.messages.sourceLoaded", { file: preview.fileName });
  } catch {
    sourcePreview.value = null;
    draftRule.value.sourceFileName = "";
    draftRule.value.sourceSheetName = "";
    draftRule.value.sourceHeaders = [];
    validationErrors.value = [t("rules.messages.sourceLoadFailed")];
  } finally {
    isParsingSource.value = false;
    input.value = "";
  }
}

function handleColumnModeChange(column: RuleOutputColumn): void {
  column.targetField = "";
  column.sourceField = "";
  column.mappingSourceFields = [];
  column.constantValue = "";
  column.mappingSection = "";
  column.conditionalJudgeField = "";
  column.conditionalMappingSection = "";
  column.conditionalHitTargetField = "";
  column.conditionalMissTargetField = "";
  column.conditionalValueSourceField = "";
  column.conditionalAggregateMode = "first";
  column.aggregateSourceField = "";
  column.aggregateNumeratorField = "";
  column.aggregateDenominatorField = "";
  column.aggregateJoinSourceField = "";
  column.aggregateJoinDelimiter = "newline";
  column.copyFromTargetField = "";
  column.dateSourceField = "";
  column.dateOutputFormat = "YYYY/M/D";
  column.expressionText = "";
}

function addOutputColumn(): void {
  draftRule.value.outputColumns = [...draftRule.value.outputColumns, createEmptyRuleOutputColumn()];
}

function removeOutputColumn(columnId: string): void {
  const nextColumns = draftRule.value.outputColumns.filter((column) => column.id !== columnId);
  draftRule.value.outputColumns = nextColumns.length > 0 ? nextColumns : [createEmptyRuleOutputColumn()];
}

function moveOutputColumn(sourceId: string, targetId: string): void {
  if (!sourceId || !targetId || sourceId === targetId) {
    return;
  }
  const columns = [...draftRule.value.outputColumns];
  const fromIndex = columns.findIndex((column) => column.id === sourceId);
  const toIndex = columns.findIndex((column) => column.id === targetId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return;
  }

  const [moved] = columns.splice(fromIndex, 1);
  columns.splice(toIndex, 0, moved);
  draftRule.value.outputColumns = columns;
}

function stopOutputColumnSort(): void {
  sortingColumnId.value = "";
  sortingOverColumnId.value = "";
  window.removeEventListener("mousemove", handleOutputColumnSortMove);
  window.removeEventListener("mouseup", stopOutputColumnSort);
}

function handleOutputColumnSortMove(event: MouseEvent): void {
  const sourceId = sortingColumnId.value;
  if (!sourceId) {
    return;
  }

  const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  const row = target?.closest("[data-output-column-id]") as HTMLElement | null;
  const targetId = row?.dataset.outputColumnId?.trim() ?? "";
  if (!targetId || targetId === sourceId) {
    return;
  }

  sortingOverColumnId.value = targetId;
  moveOutputColumn(sourceId, targetId);
}

function startOutputColumnSort(columnId: string, event: MouseEvent): void {
  if (!canEdit.value || event.button !== 0) {
    return;
  }
  event.preventDefault();
  sortingColumnId.value = columnId;
  sortingOverColumnId.value = columnId;
  window.addEventListener("mousemove", handleOutputColumnSortMove);
  window.addEventListener("mouseup", stopOutputColumnSort);
}

watch(
  () => usedTitleVariables.value.join("|"),
  () => {
    syncTitleVariableConfigs();
  },
  { immediate: true },
);

watch(
  () => resultFillTargetFields.value.join("|"),
  () => {
    syncResultFillFieldRules();
    syncTotalRowConfig();
  },
  { immediate: true },
);

async function handleSaveRule(closeAfterSave = false): Promise<void> {
  if (!canEdit.value) {
    return;
  }

  validationErrors.value = [];
  actionMessage.value = "";

  const validation = validateRuleDraft(draftRule.value);
  if (!validation.isValid) {
    validationErrors.value = validation.errors;
    return;
  }

  isSaving.value = true;
  try {
    const saved = await saveRule(cloneRuleDefinition(draftRule.value));
    activeRuleId.value = saved.id;
    setDraftRule(saved);
    actionMessage.value = t("rules.messages.saved");
    await emitTo(MAIN_WINDOW_LABEL, "rule-data-updated", { ruleId: saved.id });

    if (closeAfterSave) {
      await closeWindow();
    }
  } catch {
    validationErrors.value = [t("rules.messages.saveFailed")];
  } finally {
    isSaving.value = false;
  }
}

async function handleDeleteCurrentRule(): Promise<void> {
  if (!activeRuleId.value || !canEdit.value) {
    return;
  }

  const targetName = draftRule.value.name || t("rules.library.unnamed");
  const confirmed = await confirm(t("rules.messages.deleteConfirm", { name: targetName }));
  if (!confirmed) {
    return;
  }

  try {
    await deleteRule(activeRuleId.value);
    await emitTo(MAIN_WINDOW_LABEL, "rule-data-updated", { ruleId: null });
    await closeWindow();
  } catch {
    validationErrors.value = [t("rules.messages.saveFailed")];
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
      try {
        await appWindow.destroy();
        return;
      } catch {
        // continue to surface close failure
      }
    }
    validationErrors.value = [t("rules.messages.closeFailed")];
  }
}

onMounted(async () => {
  await loadRule(resolveRuleIdFromQuery());
  unlistenSetRule = await listen<RuleEditorPayload>("rule-editor:set-rule", (event) => {
    void loadRule(event.payload.ruleId);
  });
});

onUnmounted(() => {
  stopOutputColumnSort();
  unlistenSetRule?.();
});
</script>

<template>
  <main class="editor-page">
    <header class="editor-header">
      <h1>{{ $t("rules.editor.windowTitle") }}</h1>
      <button type="button" class="secondary-btn" @click="closeWindow">
        {{ $t("rules.actions.close") }}
      </button>
    </header>

    <section class="editor-body">
      <section v-if="ruleStoreError" class="editor-group error-group">
        <p>{{ $t("rules.messages.dbUnavailable", { reason: ruleStoreError }) }}</p>
      </section>

      <section class="editor-section">
        <h3 class="editor-section-title">{{ $t("rules.editor.basicTitle") }}</h3>
        <div class="editor-group">
          <div class="editor-setting-row">
            <span class="editor-setting-label">{{ $t("rules.fields.name") }}</span>
            <label class="field-block">
              <input v-model="draftRule.name" type="text" :disabled="!canEdit" />
            </label>
          </div>
          <div class="editor-setting-row">
            <span class="editor-setting-label">{{ $t("rules.fields.description") }}</span>
            <label class="field-block">
              <input v-model="draftRule.description" type="text" :disabled="!canEdit" />
            </label>
          </div>
        </div>
      </section>

      <section class="editor-section">
        <h3 class="editor-section-title">{{ $t("rules.editor.sourceTitle") }}</h3>
        <div class="editor-group">
          <div class="editor-setting-row">
          <span class="editor-setting-label">{{ $t("rules.actions.uploadSource") }}</span>
          <div class="source-actions">
            <input
              ref="sourceFileInputRef"
              type="file"
              accept=".xlsx,.xls,.csv"
              class="hidden-file"
              @change="handleSourceFileChange"
            />
            <span class="source-file">{{ draftRule.sourceFileName || $t("rules.messages.noSourceFile") }}</span>
            <button type="button" class="secondary-btn" :disabled="!canEdit || isParsingSource" @click="openSourceFilePicker">
              {{ isParsingSource ? $t("rules.actions.parsing") : $t("rules.actions.uploadSource") }}
            </button>
          </div>
          </div>

          <div class="editor-setting-row">
          <span class="editor-setting-label">{{ $t("rules.fields.sourceSheet") }}</span>
          <label class="field-block">
            <select
              :value="draftRule.sourceSheetName"
              :disabled="!canEdit || !sourcePreview || sourcePreview.sheets.length === 0"
              @change="applySheet(($event.target as HTMLSelectElement).value)"
            >
              <option value="">{{ $t("rules.messages.selectSheet") }}</option>
              <option v-for="sheet in sourcePreview?.sheets ?? []" :key="sheet.name" :value="sheet.name">
                {{ sheet.name }}
              </option>
            </select>
          </label>
          </div>

          <div class="header-wrap">
          <span
            v-for="header in availableHeaders"
            :key="header"
            class="header-chip"
          >
            {{ header }}
          </span>
          <p v-if="availableHeaders.length === 0" class="hint-text">
            {{ $t("rules.messages.noHeaders") }}
          </p>
          </div>

          <div v-if="activeSheetPreview && activeSheetPreview.sampleRows.length > 0" class="sample-table-wrap">
          <table class="sample-table">
            <thead>
              <tr>
                <th v-for="header in availableHeaders.slice(0, 6)" :key="header">{{ header }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in activeSheetPreview.sampleRows.slice(0, 5)" :key="index">
                <td v-for="header in availableHeaders.slice(0, 6)" :key="header">{{ row[header] }}</td>
              </tr>
            </tbody>
          </table>
          <p class="hint-text">
            {{ $t("rules.messages.sampleRows", { count: activeSheetPreview.rowCount }) }}
          </p>
          </div>
        </div>
      </section>

      <section class="editor-section">
        <h3 class="editor-section-title">{{ $t("rules.editor.groupByTitle") }}</h3>
        <div class="editor-group">
          <div class="editor-setting-row">
          <span class="editor-setting-label">{{ $t("rules.fields.groupByEnabled") }}</span>
          <label class="switch" :aria-label="$t('rules.fields.groupByEnabled')">
            <input
              :checked="draftRule.groupByEnabled"
              type="checkbox"
              :disabled="!canEdit"
              @change="handleGroupByEnabledChange"
            />
            <span class="switch-track">
              <span class="switch-thumb" />
            </span>
          </label>
          </div>

          <template v-if="draftRule.groupByEnabled">
          <div class="group-sub-block">
            <h4 class="sub-group-title">{{ $t("rules.fields.groupByField") }}</h4>
            <div class="group-options group-sub-content">
            <label v-for="header in availableHeaders" :key="header" class="group-option">
              <input
                type="radio"
                name="group-by-field"
                :checked="draftRule.groupByFields[0] === header"
                :disabled="!canEdit"
                @change="selectGroupByField(header)"
                @click="selectGroupByField(header)"
              />
              <button
                type="button"
                class="group-option-btn"
                :class="{ active: draftRule.groupByFields[0] === header }"
                :disabled="!canEdit"
                @click="selectGroupByField(header)"
              />
              <span :title="header">{{ header }}</span>
            </label>
            </div>
            <div class="selected-fields group-sub-content">
            <span v-for="field in draftRule.groupByFields" :key="field" class="selected-field-chip">
              {{ field }}
            </span>
            <p v-if="draftRule.groupByFields.length === 0" class="hint-text">
              {{ $t("rules.messages.groupByHint") }}
            </p>
            </div>
          </div>

          <div class="group-sub-block">
            <div class="group-sub-inline-row">
              <h4 class="sub-group-title">{{ $t("rules.fields.groupExclude") }}</h4>
              <select v-model="draftRule.groupExcludeMode" :disabled="!canEdit" @change="handleGroupExcludeModeChange">
                <option value="none">{{ $t("rules.messages.groupExcludeMode.none") }}</option>
                <option value="manual_values">{{ $t("rules.messages.groupExcludeMode.manual_values") }}</option>
                <option value="mapping_group_source">{{ $t("rules.messages.groupExcludeMode.mapping_group_source") }}</option>
              </select>
            </div>
            <div class="mapping-config group-sub-content">
            <textarea
              v-if="draftRule.groupExcludeMode === 'manual_values'"
              v-model="draftRule.groupExcludeValuesText"
              rows="3"
              :disabled="!canEdit"
              :placeholder="$t('rules.messages.groupExcludeValuesPlaceholder')"
            />
            <select
              v-else-if="draftRule.groupExcludeMode === 'mapping_group_source'"
              v-model="draftRule.groupExcludeMappingSection"
              :disabled="!canEdit"
            >
              <option value="">{{ $t("rules.messages.groupExcludeSelectMapping") }}</option>
              <option v-for="item in mappingOptions" :key="`exclude-${item.id}`" :value="item.id">
                {{ item.label }} ({{ item.count }})
              </option>
            </select>
            <p class="hint-text">{{ $t("rules.messages.groupExcludeHint") }}</p>
            </div>
          </div>

          <div class="group-sub-block">
            <h4 class="sub-group-title">{{ $t("rules.fields.summaryGroupBy") }}</h4>
            <div class="group-options group-sub-content">
            <label v-for="header in availableHeaders" :key="`summary-${header}`" class="group-option">
              <input
                type="checkbox"
                :checked="draftRule.summaryGroupByFields.includes(header)"
                :disabled="!canEdit"
                @change="toggleSummaryGroupField(header)"
              />
              <button
                type="button"
                class="group-option-btn"
                :class="{ active: draftRule.summaryGroupByFields.includes(header) }"
                :disabled="!canEdit"
                @click.prevent="toggleSummaryGroupField(header)"
              />
              <span :title="header">{{ header }}</span>
            </label>
            </div>
            <div class="selected-fields group-sub-content">
            <span v-for="field in draftRule.summaryGroupByFields" :key="`selected-summary-${field}`" class="selected-field-chip">
              {{ field }}
            </span>
            <p v-if="draftRule.summaryGroupByFields.length === 0" class="hint-text">
              {{ $t("rules.messages.summaryGroupByHint") }}
            </p>
            </div>
          </div>
          </template>
        </div>
      </section>

      <section class="editor-section">
        <h3 class="editor-section-title">{{ $t("rules.editor.outputTitle") }}</h3>
        <div class="editor-group">
          <div class="editor-setting-row">
            <span class="editor-setting-label">{{ $t("rules.fields.resultFillEnabled") }}</span>
            <label class="switch" :aria-label="$t('rules.fields.resultFillEnabled')">
              <input
                :checked="draftRule.resultFill.enabled"
                type="checkbox"
                :disabled="!canEdit || !draftRule.groupByEnabled || draftRule.summaryGroupByFields.length === 0"
                @change="handleResultFillEnabledChange"
              />
              <span class="switch-track">
                <span class="switch-thumb" />
              </span>
            </label>
          </div>
          <p class="hint-text">{{ $t("rules.messages.resultFillHint") }}</p>

          <template v-if="draftRule.resultFill.enabled">
            <div class="editor-setting-row">
              <span class="editor-setting-label">{{ $t("rules.fields.resultFillBaselineSourceField") }}</span>
              <label class="field-block">
                <select v-model="draftRule.resultFill.baselineSourceField" :disabled="!canEdit">
                  <option value="">{{ $t("rules.messages.selectHeader") }}</option>
                  <option v-for="header in availableHeaders" :key="`fill-baseline-${header}`" :value="header">{{ header }}</option>
                </select>
              </label>
            </div>

            <div class="editor-setting-row">
              <span class="editor-setting-label">{{ $t("rules.fields.resultFillBaselineMapping") }}</span>
              <label class="field-block">
                <select v-model="draftRule.resultFill.baselineMappingSection" :disabled="!canEdit">
                  <option value="">{{ $t("rules.messages.selectMapping") }}</option>
                  <option v-for="item in mappingOptions" :key="`fill-baseline-mapping-${item.id}`" :value="item.id">
                    {{ item.label }} ({{ item.count }})
                  </option>
                </select>
              </label>
            </div>

            <div class="editor-setting-row">
              <span class="editor-setting-label">{{ $t("rules.fields.resultFillFallbackMode") }}</span>
              <label class="field-block">
                <select v-model="draftRule.resultFill.fallbackMode" :disabled="!canEdit">
                  <option value="unknown">{{ $t("rules.resultFillFallbackModes.unknown") }}</option>
                  <option value="empty">{{ $t("rules.resultFillFallbackModes.empty") }}</option>
                  <option value="error">{{ $t("rules.resultFillFallbackModes.error") }}</option>
                </select>
              </label>
            </div>
          </template>

          <table class="rule-table">
          <thead>
            <tr>
              <th class="sort-col">#</th>
              <th>{{ $t("rules.fields.targetField") }}</th>
              <th>{{ $t("rules.fields.valueMode") }}</th>
              <th>{{ $t("rules.fields.valueSource") }}</th>
              <th>{{ $t("rules.fields.resultFillFieldRules") }}</th>
              <th class="operation-col">{{ $t("rules.fields.operation") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="column in draftRule.outputColumns"
              :key="column.id"
              class="draggable-row"
              :data-output-column-id="column.id"
              :class="{
                sorting: sortingColumnId === column.id,
                'sort-over': sortingOverColumnId === column.id && sortingColumnId !== column.id,
              }"
            >
              <td>
                <button
                  type="button"
                  class="drag-handle-btn"
                  :disabled="!canEdit"
                  :title="$t('rules.messages.dragToReorder')"
                  @mousedown.stop="startOutputColumnSort(column.id, $event)"
                >
                  ≡
                </button>
              </td>
              <td>
                <template v-if="column.valueMode === 'conditional_target'">
                  <div class="mapping-config">
                    <input
                      v-model="column.conditionalHitTargetField"
                      type="text"
                      :disabled="!canEdit"
                      :placeholder="$t('rules.messages.conditionalHitTargetPlaceholder')"
                    />
                    <input
                      v-model="column.conditionalMissTargetField"
                      type="text"
                      :disabled="!canEdit"
                      :placeholder="$t('rules.messages.conditionalMissTargetPlaceholder')"
                    />
                  </div>
                </template>
                <template v-else>
                  <input v-model="column.targetField" type="text" :disabled="!canEdit" />
                </template>
              </td>
              <td>
                <select v-model="column.valueMode" :disabled="!canEdit" @change="handleColumnModeChange(column)">
                  <option value="source">{{ $t("rules.modes.source") }}</option>
                  <option value="constant">{{ $t("rules.modes.constant") }}</option>
                  <option value="mapping">{{ $t("rules.modes.mapping") }}</option>
                  <option value="mapping_multi">{{ $t("rules.modes.mapping_multi") }}</option>
                  <option value="conditional_target">{{ $t("rules.modes.conditional_target") }}</option>
                  <option value="aggregate_sum">{{ $t("rules.modes.aggregate_sum") }}</option>
                  <option value="aggregate_sum_divide">{{ $t("rules.modes.aggregate_sum_divide") }}</option>
                  <option value="aggregate_join">{{ $t("rules.modes.aggregate_join") }}</option>
                  <option value="copy_output">{{ $t("rules.modes.copy_output") }}</option>
                  <option value="format_date">{{ $t("rules.modes.format_date") }}</option>
                  <option value="expression">{{ $t("rules.modes.expression") }}</option>
                </select>
              </td>
              <td>
                <template v-if="column.valueMode === 'constant'">
                  <input v-model="column.constantValue" type="text" :disabled="!canEdit" />
                </template>
                <template v-else-if="column.valueMode === 'mapping'">
                  <div class="mapping-config">
                    <select v-model="column.sourceField" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.selectHeader") }}</option>
                      <option v-for="header in availableHeaders" :key="header" :value="header">{{ header }}</option>
                    </select>
                    <select v-model="column.mappingSection" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.selectMapping") }}</option>
                      <option v-for="item in mappingOptions" :key="item.id" :value="item.id">
                        {{ item.label }} ({{ item.count }})
                      </option>
                    </select>
                  </div>
                </template>
                <template v-else-if="column.valueMode === 'mapping_multi'">
                  <div class="mapping-config">
                    <div class="group-options mapping-multi-options">
                      <label v-for="header in availableHeaders" :key="`${column.id}-${header}`" class="group-option">
                        <input
                          type="checkbox"
                          :checked="column.mappingSourceFields.includes(header)"
                          :disabled="!canEdit"
                          @change="toggleMappingSourceField(column, header)"
                        />
                        <button
                          type="button"
                          class="group-option-btn"
                          :class="{ active: column.mappingSourceFields.includes(header) }"
                          :disabled="!canEdit"
                          @click.prevent="toggleMappingSourceField(column, header)"
                        />
                        <span :title="header">{{ header }}</span>
                      </label>
                    </div>
                    <div class="selected-fields">
                      <span
                        v-for="field in column.mappingSourceFields"
                        :key="`${column.id}-selected-${field}`"
                        class="selected-field-chip"
                      >
                        {{ field }}
                      </span>
                      <p v-if="column.mappingSourceFields.length === 0" class="hint-text">
                        {{ $t("rules.messages.mappingMultiSelectHeaderHint") }}
                      </p>
                    </div>
                    <select v-model="column.mappingSection" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.selectMapping") }}</option>
                      <option v-for="item in mappingOptions" :key="item.id" :value="item.id">
                        {{ item.label }} ({{ item.count }})
                      </option>
                    </select>
                    <p class="hint-text">{{ $t("rules.messages.mappingMultiHint") }}</p>
                  </div>
                </template>
                <template v-else-if="column.valueMode === 'conditional_target'">
                  <div class="mapping-config">
                    <select v-model="column.conditionalJudgeField" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.conditionalSelectJudgeField") }}</option>
                      <option v-for="header in availableHeaders" :key="header" :value="header">{{ header }}</option>
                    </select>
                    <select v-model="column.conditionalMappingSection" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.conditionalSelectMapping") }}</option>
                      <option v-for="item in mappingOptions" :key="item.id" :value="item.id">
                        {{ item.label }} ({{ item.count }})
                      </option>
                    </select>
                    <select v-model="column.conditionalValueSourceField" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.conditionalSelectValueSource") }}</option>
                      <option v-for="header in availableHeaders" :key="header" :value="header">{{ header }}</option>
                    </select>
                    <select v-model="column.conditionalAggregateMode" :disabled="!canEdit">
                      <option value="first">{{ $t("rules.messages.conditionalAggregate.first") }}</option>
                      <option value="sum">{{ $t("rules.messages.conditionalAggregate.sum") }}</option>
                      <option value="join_newline">{{ $t("rules.messages.conditionalAggregate.join_newline") }}</option>
                    </select>
                    <p class="hint-text">
                      {{ $t("rules.messages.conditionalHint") }}
                    </p>
                  </div>
                </template>
                <template v-else-if="column.valueMode === 'aggregate_sum'">
                  <select v-model="column.aggregateSourceField" :disabled="!canEdit">
                    <option value="">{{ $t("rules.messages.aggregateSelectSource") }}</option>
                    <option v-for="header in availableHeaders" :key="header" :value="header">{{ header }}</option>
                  </select>
                </template>
                <template v-else-if="column.valueMode === 'aggregate_sum_divide'">
                  <div class="mapping-config">
                    <select v-model="column.aggregateNumeratorField" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.aggregateSelectNumerator") }}</option>
                      <option v-for="header in availableHeaders" :key="header" :value="header">{{ header }}</option>
                    </select>
                    <select v-model="column.aggregateDenominatorField" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.aggregateSelectDenominator") }}</option>
                      <option v-for="header in availableHeaders" :key="header" :value="header">{{ header }}</option>
                    </select>
                  </div>
                </template>
                <template v-else-if="column.valueMode === 'aggregate_join'">
                  <div class="mapping-config">
                    <select v-model="column.aggregateJoinSourceField" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.aggregateJoinSelectSource") }}</option>
                      <option v-for="header in availableHeaders" :key="header" :value="header">{{ header }}</option>
                    </select>
                    <select v-model="column.aggregateJoinDelimiter" :disabled="!canEdit">
                      <option value="newline">{{ $t("rules.messages.aggregateJoinDelimiter.newline") }}</option>
                      <option value="space">{{ $t("rules.messages.aggregateJoinDelimiter.space") }}</option>
                    </select>
                  </div>
                </template>
                <template v-else-if="column.valueMode === 'copy_output'">
                  <select v-model="column.copyFromTargetField" :disabled="!canEdit">
                    <option value="">{{ $t("rules.messages.copyOutputSelectSource") }}</option>
                    <option
                      v-for="target in outputTemplateVariables.filter((item) => !getColumnTargetFields(column).includes(item))"
                      :key="target"
                      :value="target"
                    >
                      {{ target }}
                    </option>
                  </select>
                </template>
                <template v-else-if="column.valueMode === 'format_date'">
                  <div class="mapping-config">
                    <select v-model="column.dateSourceField" :disabled="!canEdit">
                      <option value="">{{ $t("rules.messages.dateSelectSource") }}</option>
                      <option v-for="header in availableHeaders" :key="header" :value="header">{{ header }}</option>
                    </select>
                    <input
                      v-model="column.dateOutputFormat"
                      type="text"
                      :disabled="!canEdit"
                      :placeholder="$t('rules.messages.dateFormatPlaceholder')"
                    />
                  </div>
                </template>
                <template v-else-if="column.valueMode === 'expression'">
                  <div class="mapping-config">
                    <textarea
                      v-model="column.expressionText"
                      rows="3"
                      :disabled="!canEdit"
                      :placeholder="$t('rules.messages.expressionPlaceholder')"
                    />
                    <p class="hint-text">{{ $t("rules.messages.expressionHint") }}</p>
                  </div>
                </template>
                <template v-else>
                  <select v-model="column.sourceField" :disabled="!canEdit">
                    <option value="">{{ $t("rules.messages.selectHeader") }}</option>
                    <option v-for="header in availableHeaders" :key="header" :value="header">{{ header }}</option>
                  </select>
                </template>
              </td>
              <td>
                <template v-if="draftRule.resultFill.enabled">
                  <div class="mapping-config">
                    <div
                      v-for="fieldRule in getResultFillRulesByColumn(column)"
                      :key="`fill-inline-${column.id}-${fieldRule.targetField}`"
                      class="fill-rule-inline-block"
                    >
                      <span v-if="getColumnTargetFields(column).length > 1" class="fill-rule-target-label">{{ fieldRule.targetField }}</span>
                      <select v-model="fieldRule.valueMode" :disabled="!canEdit" @change="handleResultFillFieldModeChange(fieldRule)">
                        <option v-for="mode in resultFillValueModes" :key="`inline-fill-mode-${fieldRule.targetField}-${mode}`" :value="mode">
                          {{ $t(`rules.resultFillModes.${mode}`) }}
                        </option>
                      </select>
                      <template v-if="fieldRule.valueMode === 'constant'">
                        <input
                          v-model="fieldRule.constantValue"
                          type="text"
                          :disabled="!canEdit"
                          :placeholder="$t('rules.fields.placeholderValue')"
                        />
                      </template>
                      <template v-else-if="fieldRule.valueMode === 'mapping'">
                        <div class="mapping-config">
                          <select v-model="fieldRule.sourceField" :disabled="!canEdit">
                            <option value="">{{ $t("rules.messages.selectHeader") }}</option>
                            <option v-for="header in availableHeaders" :key="`inline-fill-source-${fieldRule.targetField}-${header}`" :value="header">
                              {{ header }}
                            </option>
                          </select>
                          <select v-model="fieldRule.mappingSection" :disabled="!canEdit">
                            <option value="">{{ $t("rules.messages.selectMapping") }}</option>
                            <option v-for="item in mappingOptions" :key="`inline-fill-mapping-${fieldRule.targetField}-${item.id}`" :value="item.id">
                              {{ item.label }} ({{ item.count }})
                            </option>
                          </select>
                        </div>
                      </template>
                      <template v-else-if="fieldRule.valueMode === 'mapping_multi'">
                        <div class="mapping-config">
                          <div class="group-options mapping-multi-options">
                            <label
                              v-for="header in availableHeaders"
                              :key="`inline-fill-multi-source-${fieldRule.targetField}-${header}`"
                              class="group-option"
                            >
                              <input
                                type="checkbox"
                                :checked="fieldRule.mappingSourceFields.includes(header)"
                                :disabled="!canEdit"
                                @change="toggleResultFillMappingSourceField(fieldRule, header)"
                              />
                              <button
                                type="button"
                                class="group-option-btn"
                                :class="{ active: fieldRule.mappingSourceFields.includes(header) }"
                                :disabled="!canEdit"
                                @click.prevent="toggleResultFillMappingSourceField(fieldRule, header)"
                              />
                              <span :title="header">{{ header }}</span>
                            </label>
                          </div>
                          <select v-model="fieldRule.mappingSection" :disabled="!canEdit">
                            <option value="">{{ $t("rules.messages.selectMapping") }}</option>
                            <option
                              v-for="item in mappingOptions"
                              :key="`inline-fill-multi-mapping-${fieldRule.targetField}-${item.id}`"
                              :value="item.id"
                            >
                              {{ item.label }} ({{ item.count }})
                            </option>
                          </select>
                        </div>
                      </template>
                      <template v-else-if="fieldRule.valueMode === 'copy_output'">
                        <select v-model="fieldRule.copyFromTargetField" :disabled="!canEdit">
                          <option value="">{{ $t("rules.messages.copyOutputSelectSource") }}</option>
                          <option
                            v-for="target in resultFillTargetFields.filter((item) => item !== fieldRule.targetField)"
                            :key="`inline-fill-copy-${fieldRule.targetField}-${target}`"
                            :value="target"
                          >
                            {{ target }}
                          </option>
                        </select>
                      </template>
                    </div>
                    <p v-if="getResultFillRulesByColumn(column).length === 0" class="hint-text">
                      {{ $t("rules.messages.resultFillNoFields") }}
                    </p>
                  </div>
                </template>
                <template v-else>
                  <span class="hint-text">{{ $t("rules.messages.resultFillDisabledConfig") }}</span>
                </template>
              </td>
              <td>
                <button type="button" class="link-btn danger" :disabled="!canEdit" @click="removeOutputColumn(column.id)">
                  {{ $t("rules.actions.removeField") }}
                </button>
              </td>
            </tr>
          </tbody>
          </table>

          <button type="button" class="secondary-btn" :disabled="!canEdit" @click="addOutputColumn">
          {{ $t("rules.actions.addField") }}
          </button>
        </div>
      </section>

      <section class="editor-section">
        <h3 class="editor-section-title">{{ $t("rules.editor.sheetTemplateTitle") }}</h3>
        <div class="editor-group">

          <div class="editor-setting-row">
          <span class="editor-setting-label">{{ $t("rules.fields.sheetTitleEnabled") }}</span>
          <label class="switch" :aria-label="$t('rules.fields.sheetTitleEnabled')">
            <input
              :checked="draftRule.sheetTemplate.titleEnabled"
              type="checkbox"
              :disabled="!canEdit"
              @change="handleTitleEnabledChange"
            />
            <span class="switch-track">
              <span class="switch-thumb" />
            </span>
          </label>
          </div>

          <template v-if="draftRule.sheetTemplate.titleEnabled">
          <div class="editor-setting-row template-header-row">
            <span class="editor-setting-label">{{ $t("rules.fields.titleTemplate") }}</span>
            <div class="template-header-panel">
              <label class="field-block template-editor">
                <input
                  v-model="draftRule.sheetTemplate.titleTemplate"
                  type="text"
                  :disabled="!canEdit"
                />
              </label>
              <p class="hint-text template-inline-hint">
                {{
                  draftRule.sheetTemplate.titleEnabled
                    ? $t("rules.messages.titleTemplateHint")
                    : $t("rules.messages.titleTemplateEmpty")
                }}
              </p>
            </div>
          </div>

          <div class="template-variables-full">
            <div class="template-variable-group">
              <span class="template-variable-label">{{ $t("rules.fields.availableSourceVariables") }}</span>
              <div class="template-variable-list">
                <button
                  v-for="variableKey in sourceTemplateVariables"
                  :key="`source-${variableKey}`"
                  type="button"
                  class="template-variable-chip"
                  :disabled="!canEdit"
                  @click="insertTitleVariable(variableKey)"
                >
                  {{ variableKey }}
                </button>
              </div>
            </div>

            <div class="template-variable-group">
              <span class="template-variable-label">{{ $t("rules.fields.availableOutputVariables") }}</span>
              <div class="template-variable-list">
                <button
                  v-for="variableKey in outputTemplateVariables"
                  :key="`output-${variableKey}`"
                  type="button"
                  class="template-variable-chip"
                  :disabled="!canEdit"
                  @click="insertTitleVariable(variableKey)"
                >
                  {{ variableKey }}
                </button>
              </div>
            </div>

            <p v-if="availableTemplateVariables.length === 0" class="hint-text">
              {{ $t("rules.messages.noTemplateVariables") }}
            </p>
            <p v-else class="hint-text">
              {{ $t("rules.messages.titleVariableHint") }}
            </p>
          </div>

          <div class="editor-setting-row">
          <span class="editor-setting-label">{{ $t("rules.fields.headerRowIndex") }}</span>
          <label class="field-block">
            <input
              v-model.number="draftRule.sheetTemplate.headerRowIndex"
              type="number"
              min="1"
              :disabled="!canEdit"
            />
          </label>
          </div>

          <div class="editor-setting-row">
          <span class="editor-setting-label">{{ $t("rules.fields.dataStartRowIndex") }}</span>
          <label class="field-block">
            <input
              v-model.number="draftRule.sheetTemplate.dataStartRowIndex"
              type="number"
              min="1"
              :disabled="!canEdit"
            />
          </label>
          </div>

          <p class="hint-text template-merge-hint">
          {{
            $t("rules.messages.mergePreview", {
              range: mergeRangeEndCell,
              headerRow: draftRule.sheetTemplate.headerRowIndex,
              dataRow: draftRule.sheetTemplate.dataStartRowIndex,
            })
          }}
          </p>

          <div class="template-operation-block">
          <h4 class="sub-group-title template-operation-title">{{ $t("rules.fields.operation") }}</h4>
          <div class="template-conflict-list">
            <div v-if="usedTitleVariables.length === 0" class="template-conflict-empty">
              {{ $t("rules.messages.noTitleVariablesUsed") }}
            </div>

            <div
              v-for="config in draftRule.sheetTemplate.variableConfigs"
              :key="config.variableKey"
              class="template-conflict-row"
              :class="{ 'has-placeholder': config.conflictMode === 'placeholder' }"
            >
              <span class="template-conflict-name">{{ config.variableKey }}</span>
              <select v-model="config.conflictMode" :disabled="!canEdit">
                <option v-for="mode in titleConflictModes" :key="mode" :value="mode">
                  {{ $t(`rules.conflictModes.${mode}`) }}
                </option>
              </select>
              <input
                v-if="config.conflictMode === 'placeholder'"
                v-model="config.placeholderValue"
                type="text"
                :disabled="!canEdit"
                :placeholder="$t('rules.fields.placeholderValue')"
              />
            </div>
          </div>
          </div>
          </template>
        </div>
      </section>

      <section class="editor-section">
        <h3 class="editor-section-title">{{ $t("rules.editor.totalRowTitle") }}</h3>
        <div class="editor-group">
          <div class="editor-setting-row">
            <span class="editor-setting-label">{{ $t("rules.fields.totalRowEnabled") }}</span>
            <label class="switch" :aria-label="$t('rules.fields.totalRowEnabled')">
              <input
                :checked="draftRule.totalRow.enabled"
                type="checkbox"
                :disabled="!canEdit"
                @change="handleTotalRowEnabledChange"
              />
              <span class="switch-track">
                <span class="switch-thumb" />
              </span>
            </label>
          </div>
          <p class="hint-text">{{ $t("rules.messages.totalRowHint") }}</p>

          <template v-if="draftRule.totalRow.enabled">
            <div class="editor-setting-row">
              <span class="editor-setting-label">{{ $t("rules.fields.totalRowLabel") }}</span>
              <label class="field-block">
                <input v-model="draftRule.totalRow.label" type="text" :disabled="!canEdit" />
              </label>
            </div>

            <div class="editor-setting-row">
              <span class="editor-setting-label">{{ $t("rules.fields.totalRowLabelField") }}</span>
              <label class="field-block">
                <select v-model="draftRule.totalRow.labelField" :disabled="!canEdit || totalRowTargetFields.length === 0">
                  <option value="">{{ $t("rules.messages.totalRowLabelFieldFirstColumn") }}</option>
                  <option
                    v-for="targetField in totalRowTargetFields"
                    :key="`total-row-label-${targetField}`"
                    :value="targetField"
                  >
                    {{ targetField }}
                  </option>
                </select>
              </label>
            </div>

            <div class="group-sub-block">
              <h4 class="sub-group-title">{{ $t("rules.fields.totalRowSumFields") }}</h4>
              <div class="group-options group-sub-content">
                <label v-for="targetField in totalRowTargetFields" :key="`total-row-sum-${targetField}`" class="group-option">
                  <input
                    type="checkbox"
                    :checked="draftRule.totalRow.sumFields.includes(targetField)"
                    :disabled="!canEdit"
                    @change="toggleTotalRowSumField(targetField)"
                  />
                  <button
                    type="button"
                    class="group-option-btn"
                    :class="{ active: draftRule.totalRow.sumFields.includes(targetField) }"
                    :disabled="!canEdit"
                    @click.prevent="toggleTotalRowSumField(targetField)"
                  />
                  <span :title="targetField">{{ targetField }}</span>
                </label>
              </div>
              <div class="selected-fields group-sub-content">
                <span
                  v-for="targetField in draftRule.totalRow.sumFields"
                  :key="`total-row-selected-${targetField}`"
                  class="selected-field-chip"
                >
                  {{ targetField }}
                </span>
                <p v-if="totalRowTargetFields.length === 0" class="hint-text">
                  {{ $t("rules.messages.totalRowNoFields") }}
                </p>
                <p v-else-if="draftRule.totalRow.sumFields.length === 0" class="hint-text">
                  {{ $t("rules.messages.totalRowSumFieldsHint") }}
                </p>
              </div>
            </div>
          </template>
        </div>
      </section>

      <section v-if="validationErrors.length > 0" class="editor-group error-group">
        <p v-for="error in validationErrors" :key="error">{{ error }}</p>
      </section>
      <section v-if="actionMessage" class="editor-group success-group">
        <p>{{ actionMessage }}</p>
      </section>
    </section>

    <footer class="editor-footer">
      <button v-if="activeRuleId" type="button" class="secondary-btn danger-outline" :disabled="!canEdit" @click="handleDeleteCurrentRule">
        {{ $t("rules.actions.delete") }}
      </button>
      <div class="editor-footer-actions">
        <button type="button" class="secondary-btn" :disabled="!canEdit || isSaving" @click="handleSaveRule(false)">
          {{ isSaving ? $t("rules.actions.saving") : $t("rules.actions.save") }}
        </button>
        <button type="button" class="secondary-btn" :disabled="!canEdit || isSaving" @click="handleSaveRule(true)">
          {{ $t("rules.actions.saveAndClose") }}
        </button>
      </div>
    </footer>
  </main>
</template>

<style scoped>
.editor-page {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  background: var(--bg-main);
  color: var(--text-main);
  padding: 14px;
  display: grid;
  gap: 10px;
  grid-template-rows: auto 1fr auto;
  overflow: hidden;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.editor-header h1 {
  margin: 0;
  font-size: var(--fs-xl);
}

.editor-body {
  min-height: 0;
  overflow: auto;
  display: grid;
  gap: 14px;
  align-content: start;
  padding-right: 2px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.editor-body::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.editor-section {
  display: grid;
  gap: 8px;
}

.editor-section-title {
  margin: 0;
  min-height: 22px;
  display: flex;
  align-items: center;
  line-height: 1;
  font-size: var(--fs-sm);
  color: var(--text-muted);
  font-weight: 600;
}

.editor-group {
  border: 1px solid var(--stroke-soft);
  border-radius: 12px;
  background: var(--bg-card);
  padding: 12px;
  display: grid;
  gap: 10px;
}

.sub-group-title {
  margin: 2px 0 0;
  font-size: var(--fs-caption);
  color: var(--text-muted);
  font-weight: 600;
}

.group-sub-block {
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: var(--bg-input);
  padding: 12px 14px;
  display: grid;
  gap: 8px;
}

.group-sub-block .sub-group-title {
  margin: 0;
}

.group-sub-content {
  margin-inline: 2px;
}

.group-sub-inline-row {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

.group-sub-inline-row .sub-group-title {
  margin: 0;
}

.group-sub-inline-row select {
  justify-self: end;
  width: min(100%, 720px);
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 7px 9px;
}

.field-block {
  display: grid;
  gap: 6px;
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.editor-setting-row {
  display: grid;
  grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: var(--bg-input);
  min-height: 50px;
  padding: 8px 12px;
}

.editor-setting-row > :last-child {
  justify-self: end;
  width: min(100%, 720px);
}

.editor-setting-row .field-block {
  justify-items: end;
}

.editor-setting-row .switch {
  width: auto;
}

.editor-setting-row.template-header-row > :last-child {
  justify-self: stretch;
  width: 100%;
  max-width: none;
}

.editor-setting-row.template-header-row .field-block {
  justify-items: stretch;
}

.editor-setting-row.template-header-row {
  align-items: start;
}

.editor-setting-row.template-header-row .editor-setting-label {
  display: flex;
  align-items: center;
  min-height: 34px;
}

.editor-setting-label {
  color: var(--text-main);
  font-size: var(--fs-caption);
  line-height: 1.35;
}

.field-block input[type="text"],
.field-block input[type="number"],
.field-block select,
.field-block textarea,
.rule-table input[type="text"],
.rule-table select {
  width: 100%;
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 7px 9px;
}

.field-block input[type="text"]:focus-visible,
.field-block input[type="number"]:focus-visible,
.field-block select:focus-visible,
.field-block textarea:focus-visible,
.rule-table input[type="text"]:focus-visible,
.rule-table select:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.field-block textarea {
  resize: vertical;
  min-height: 96px;
}

.source-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  justify-content: flex-end;
}

.hidden-file {
  display: none;
}

.secondary-btn {
  border: 1px solid var(--btn-border);
  border-radius: 8px;
  background: var(--btn-bg);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1;
  padding: 8px 11px;
  cursor: pointer;
}

.secondary-btn:hover:not(:disabled) {
  background: var(--btn-bg-hover);
}

.secondary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.danger-outline {
  border-color: var(--danger);
  color: var(--danger);
}

.source-file {
  font-size: var(--fs-caption);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
  max-width: min(100%, 360px);
}

.header-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.header-chip {
  border: 1px solid var(--stroke-soft);
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-main);
  font-size: var(--fs-caption);
  padding: 3px 8px;
}

.hint-text {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.sample-table-wrap {
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  overflow: hidden;
}

.sample-table {
  width: 100%;
  border-collapse: collapse;
}

.sample-table th,
.sample-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--stroke-soft);
  font-size: var(--fs-caption);
}

.sample-table th {
  color: var(--text-muted);
  font-weight: 600;
}

.group-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
  max-height: 220px;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.group-options::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.group-option {
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-main);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: var(--fs-caption);
  min-height: 38px;
  cursor: pointer;
}

.group-option input[type="radio"],
.group-option input[type="checkbox"] {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.group-option-btn {
  width: 16px;
  height: 16px;
  margin: 0;
  flex: 0 0 auto;
  border: 1px solid var(--stroke-soft);
  border-radius: 999px;
  background: transparent;
  box-shadow: inset 0 0 0 3px transparent;
  cursor: pointer;
  padding: 0;
}

.group-option-btn.active {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: inset 0 0 0 3px var(--bg-card);
}

.group-option span {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.selected-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.selected-field-chip {
  border: 1px solid var(--stroke-soft);
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-main);
  font-size: var(--fs-caption);
  padding: 2px 8px;
}

.rule-table {
  width: 100%;
  border-collapse: collapse;
}

.rule-table th,
.rule-table td {
  border-bottom: 1px solid var(--stroke-soft);
  padding: 8px 6px;
  text-align: left;
  vertical-align: middle;
}

.draggable-row {
  cursor: default;
}

.draggable-row.sorting {
  opacity: 0.45;
}

.draggable-row.sort-over td {
  border-top: 1px solid var(--accent);
}

.rule-table th {
  color: var(--text-muted);
  font-size: var(--fs-caption);
  font-weight: 600;
}

.sort-col {
  width: 56px;
}

.operation-col {
  width: 90px;
}

.drag-handle-btn {
  border: 1px solid var(--stroke-soft);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-muted);
  font-size: var(--fs-caption);
  line-height: 1;
  padding: 4px 7px;
  cursor: grab;
  user-select: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.drag-handle-btn:active {
  cursor: grabbing;
}

.mapping-config {
  display: grid;
  gap: 6px;
}

.fill-rule-inline-block {
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  padding: 8px;
  display: grid;
  gap: 6px;
}

.fill-rule-target-label {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.mapping-multi-options {
  max-height: 132px;
  overflow: auto;
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  padding: 6px;
}

.mapping-config select,
.mapping-config input,
.mapping-config textarea {
  width: 100%;
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 7px 9px;
}

.switch {
  display: inline-flex;
  align-items: center;
}

.switch input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  border: 0;
  padding: 0;
  clip: rect(0 0 0 0);
  overflow: hidden;
}

.switch-track {
  width: 40px;
  height: 24px;
  border: 1px solid var(--btn-border);
  border-radius: 999px;
  background: var(--switch-track-bg);
  display: inline-flex;
  align-items: center;
  padding: 2px;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.switch-thumb {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: var(--switch-thumb);
  transition: transform 120ms ease;
}

.switch input:checked + .switch-track {
  background: var(--switch-track-active);
  border-color: var(--accent);
}

.switch input:checked + .switch-track .switch-thumb {
  transform: translateX(16px);
}

.switch input:focus-visible + .switch-track {
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.switch input:disabled + .switch-track {
  opacity: 0.6;
}

.template-header-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
  width: 100%;
  justify-items: stretch;
}

.template-input-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  gap: 6px;
}

.template-editor {
  min-width: 0;
  width: 100%;
  justify-items: stretch;
}

.template-inline-hint {
  margin: 0;
  white-space: normal;
  text-align: left;
}

.template-variables-full {
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: var(--bg-input);
  padding: 10px 12px;
  display: grid;
  gap: 10px;
}

.template-variable-group {
  display: grid;
  gap: 6px;
  width: 100%;
}

.template-variable-label {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.template-variable-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.template-variable-chip {
  border: 1px solid var(--stroke-soft);
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-caption);
  line-height: 1;
  padding: 6px 9px;
  cursor: pointer;
}

.template-variable-chip:hover:not(:disabled) {
  background: var(--bg-strong);
}

.template-variable-chip:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.template-row-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 220px));
  gap: 10px;
}

.template-merge-hint {
  margin: 0;
  text-align: right;
}

.template-conflict-list {
  display: grid;
  gap: 8px;
}

.template-operation-block {
  display: grid;
  gap: 8px;
}

.template-operation-title {
  margin: 0;
}

.template-conflict-empty {
  border: 1px dashed var(--stroke-soft);
  border-radius: 10px;
  color: var(--text-muted);
  font-size: var(--fs-caption);
  padding: 10px;
}

.template-conflict-row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(160px, 220px);
  gap: 10px;
  align-items: center;
}

.template-conflict-row.has-placeholder {
  grid-template-columns: minmax(120px, 1fr) minmax(160px, 220px) minmax(0, 1fr);
}

.template-conflict-row select {
  justify-self: end;
  width: 100%;
}

.template-conflict-name {
  color: var(--text-main);
  font-size: var(--fs-caption);
  word-break: break-all;
}

.link-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--fs-caption);
  cursor: pointer;
  padding: 0;
}

.link-btn:hover:not(:disabled) {
  color: var(--text-main);
}

.link-btn.danger:hover:not(:disabled) {
  color: var(--danger);
}

.link-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.error-group {
  border-color: var(--danger);
}

.error-group p {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-caption);
}

.success-group p {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.editor-footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

@media (max-width: 900px) {
  .editor-setting-row {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }

  .template-header-panel,
  .template-row-grid,
  .template-conflict-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .template-input-row {
    align-items: start;
  }

  .template-inline-hint {
    white-space: normal;
    text-align: left;
  }

  .template-merge-hint {
    text-align: right;
  }
}
</style>
