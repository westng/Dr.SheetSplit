<script setup lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEngineRuleStore, useMappingStore, useUiStore } from "../../store";
import type { EngineRuleDefinition, EngineRuleOutputField, EngineRuleSource } from "../../types/engineRule";
import { validateEngineRuleDraft } from "../../utils/engineRuleValidator";
import { basenameFromPath } from "../../utils/nativeFile";
import {
  buildSheetPreview,
  readSpreadsheetSheetHeader,
  parseSpreadsheetPath,
  type SpreadsheetPreview,
  type SpreadsheetSheetPreview,
} from "../../utils/spreadsheetParser";
import { useImportSettings } from "../../composables/useImportSettings";
import { runEngineProcessTask } from "../../services/engineProcess";
import type { TaskHistoryLogItem } from "../../types/history";

type RuntimeSourceState = {
  datasetId: string;
  inspectJobId: string;
  filePath: string;
  fileName: string;
  sheetName: string;
  preview: SpreadsheetPreview | null;
  sheetPreview: SpreadsheetSheetPreview | null;
  loading: boolean;
  error: string;
};

type ValidationState = {
  ran: boolean;
  passed: boolean;
  errors: string[];
};

const { t } = useI18n();
const { engineRules, reloadEngineRules } = useEngineRuleStore();
const { mappingGroups } = useMappingStore();
const { activeMenu } = useUiStore();
const { allowedImportFormats } = useImportSettings();

const selectedRuleId = ref("");
const runtimeSources = ref<Record<string, RuntimeSourceState>>({});
const validationState = ref<ValidationState>({
  ran: false,
  passed: false,
  errors: [],
});
const expandedSources = ref<Record<string, boolean>>({});
const isProcessing = ref(false);
const processLogs = ref<TaskHistoryLogItem[]>([]);
const runError = ref("");
const runSummary = ref<{
  outputPath: string;
  sheetCount: number;
  rowCount: number;
} | null>(null);
const MAX_PROCESS_LOGS = 200;
const EXPORT_DIRECTORY_STORAGE_KEY = "settings.exportDirectory";

const availableRules = computed(() =>
  engineRules.value
    .filter((rule) => rule.enabled)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
);

const selectedRule = computed<EngineRuleDefinition | null>(
  () => availableRules.value.find((rule) => rule.id === selectedRuleId.value) ?? null,
);

const overallReady = computed(() => {
  if (!selectedRule.value) {
    return false;
  }
  return selectedRule.value.sources.every((source) => {
    const state = runtimeSources.value[source.id];
    return Boolean((state?.filePath || state?.datasetId) && state?.sheetName && state?.sheetPreview && !state?.error);
  });
});

const sourceReadyCount = computed(() => {
  if (!selectedRule.value) {
    return 0;
  }
  return selectedRule.value.sources.filter((source) => {
    const state = runtimeSources.value[source.id];
    return Boolean((state?.filePath || state?.datasetId) && state?.sheetName && state?.sheetPreview && !state?.error);
  }).length;
});

const canStart = computed(() =>
  Boolean(selectedRule.value) && overallReady.value && !isProcessing.value,
);

const displayProcessLogs = computed(() => [...processLogs.value].reverse());

function createRuntimeSourceState(source: EngineRuleSource): RuntimeSourceState {
  return {
    datasetId: "",
    inspectJobId: "",
    filePath: "",
    fileName: source.sourceFileName.trim(),
    sheetName: source.sourceSheetName.trim(),
    preview: null,
    sheetPreview: null,
    loading: false,
    error: "",
  };
}

function formatLogTime(date = new Date()): string {
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  const second = `${date.getSeconds()}`.padStart(2, "0");
  return `${hour}:${minute}:${second}`;
}

function appendProcessLog(message: string, level: "info" | "success" | "error" = "info"): void {
  const normalized = message.trim();
  if (!normalized) {
    return;
  }
  const latest = processLogs.value[processLogs.value.length - 1];
  if (latest && latest.message === normalized && latest.level === level) {
    return;
  }
  processLogs.value.push({
    id: crypto.randomUUID(),
    level,
    time: formatLogTime(),
    message: normalized,
  });
  if (processLogs.value.length > MAX_PROCESS_LOGS) {
    processLogs.value.splice(0, processLogs.value.length - MAX_PROCESS_LOGS);
  }
}

function clearProcessState(): void {
  processLogs.value = [];
  runError.value = "";
  runSummary.value = null;
}

function resolvePreferredExportDirectory(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return String(window.localStorage.getItem(EXPORT_DIRECTORY_STORAGE_KEY) ?? "").trim();
}

function ensureRuntimeSourceState(source: EngineRuleSource): RuntimeSourceState {
  const existing = runtimeSources.value[source.id];
  if (existing) {
    return existing;
  }
  const created = createRuntimeSourceState(source);
  runtimeSources.value = {
    ...runtimeSources.value,
    [source.id]: created,
  };
  return created;
}

function getRuntimeSourceState(source: EngineRuleSource): RuntimeSourceState {
  return ensureRuntimeSourceState(source);
}

function isSourceExpanded(sourceId: string): boolean {
  return Boolean(expandedSources.value[sourceId]);
}

function toggleSourceExpanded(sourceId: string): void {
  expandedSources.value = {
    ...expandedSources.value,
    [sourceId]: !expandedSources.value[sourceId],
  };
}

function sourceLabel(index: number): string {
  return t("engineProcess.sourceLabel", { index: index + 1 });
}

function resolveOutputLabel(field: EngineRuleOutputField, index: number): string {
  const fixedName = field.fieldName.trim();
  if (fixedName) {
    return fixedName;
  }
  if (field.nameMode === "source_field" && field.nameSourceField.trim()) {
    return field.nameSourceField.trim();
  }
  return t("engineRules.labels.outputCard", { index: index + 1 });
}

function resolveSourceHeaders(sourceId: string): string[] {
  return runtimeSources.value[sourceId]?.sheetPreview?.headers ?? [];
}

function resolveStableOutputFieldNames(rule: EngineRuleDefinition): string[] {
  return rule.outputFields
    .filter((field) => field.nameMode === "fixed" && field.fieldName.trim())
    .map((field) => field.fieldName.trim());
}

function hasSourceField(sourceId: string, field: string): boolean {
  const normalized = field.trim();
  if (!normalized) {
    return true;
  }
  return resolveSourceHeaders(sourceId).includes(normalized);
}

function getSourceName(rule: EngineRuleDefinition, sourceId: string): string {
  const index = rule.sources.findIndex((source) => source.id === sourceId);
  if (index < 0) {
    return t("engineRules.labels.unset");
  }
  return sourceLabel(index);
}

function pushMissingFieldError(
  errors: string[],
  rule: EngineRuleDefinition,
  sourceId: string,
  fieldName: string,
  contextLabel: string,
  extraFieldNames: readonly string[] = [],
): void {
  if (!fieldName.trim()) {
    return;
  }
  if (hasSourceField(sourceId, fieldName) || extraFieldNames.includes(fieldName.trim())) {
    return;
  }
  errors.push(
    t("engineProcess.messages.missingField", {
      source: getSourceName(rule, sourceId),
      field: fieldName,
      context: contextLabel,
    }),
  );
}

function validateRuntime(rule: EngineRuleDefinition): string[] {
  const errors = [...validateEngineRuleDraft(rule).errors];
  const groupFieldLabels = rule.result.groupFields.map((field) => field.label.trim()).filter(Boolean);
  const stableOutputFieldNames = resolveStableOutputFieldNames(rule);
  const sharedResolvableFieldNames = Array.from(new Set([...groupFieldLabels, ...stableOutputFieldNames]));

  rule.sources.forEach((source, index) => {
    const state = runtimeSources.value[source.id];
    if (!state?.filePath && !state?.datasetId) {
      errors.push(
        t("engineProcess.messages.sourceUploadRequired", {
          source: sourceLabel(index),
        }),
      );
      return;
    }
    if (!state.sheetName.trim()) {
      errors.push(
        t("engineProcess.messages.sourceSheetRequired", {
          source: sourceLabel(index),
        }),
      );
      return;
    }
    if (!state.sheetPreview) {
      errors.push(
        t("engineProcess.messages.sourceHeaderRequired", {
          source: sourceLabel(index),
        }),
      );
    }
  });

  rule.relations.forEach((relation, index) => {
    pushMissingFieldError(errors, rule, relation.leftSourceId, relation.leftField, `${t("engineRules.editor.relationsTitle")} #${index + 1}`);
    pushMissingFieldError(errors, rule, relation.rightSourceId, relation.rightField, `${t("engineRules.editor.relationsTitle")} #${index + 1}`);
  });

  rule.result.groupFields.forEach((field, index) => {
    pushMissingFieldError(errors, rule, field.sourceTableId, field.sourceField, `${t("engineRules.editor.resultTitle")} #${index + 1}`);
  });

  if (rule.result.rowCompletion.enabled && rule.result.rowCompletion.sourceTableId && rule.result.rowCompletion.sourceField) {
    pushMissingFieldError(
      errors,
      rule,
      rule.result.rowCompletion.sourceTableId,
      rule.result.rowCompletion.sourceField,
      t("engineRules.editor.rowCompletionTitle"),
    );
  }

  if (
    rule.result.sheetConfig.mode === "split_field" &&
    rule.result.sheetConfig.splitFieldScope === "source_field" &&
    rule.result.sheetConfig.splitSourceTableId &&
    rule.result.sheetConfig.splitField
  ) {
    pushMissingFieldError(
      errors,
      rule,
      rule.result.sheetConfig.splitSourceTableId,
      rule.result.sheetConfig.splitField,
      t("engineRules.editor.sheetTitle"),
    );
  }

  rule.outputFields.forEach((field, index) => {
    const outputLabel = resolveOutputLabel(field, index);
    const usesPrimarySourceField =
      field.valueMode !== "expression" &&
      field.valueMode !== "constant" &&
      field.valueMode !== "mapping" &&
      field.valueMode !== "fill" &&
      field.valueMode !== "dynamic_columns" &&
      field.valueMode !== "dynamic_group_sum" &&
      field.valueMode !== "dynamic_group_avg";
    if (usesPrimarySourceField && field.sourceTableId && field.sourceField) {
      pushMissingFieldError(errors, rule, field.sourceTableId, field.sourceField, outputLabel);
    }

    if (field.nameSourceTableId && field.nameSourceField) {
      pushMissingFieldError(errors, rule, field.nameSourceTableId, field.nameSourceField, `${outputLabel} / ${t("engineRules.fields.nameSourceField")}`);
    }

    field.mappingSourceFields.forEach((name) => {
      pushMissingFieldError(
        errors,
        rule,
        field.sourceTableId,
        name,
        `${outputLabel} / ${t("engineRules.fields.mappingSourceFields")}`,
        sharedResolvableFieldNames,
      );
    });
    field.nameMappingSourceFields.forEach((name) => {
      pushMissingFieldError(errors, rule, field.nameSourceTableId, name, `${outputLabel} / ${t("engineRules.fields.nameMappingSourceFields")}`);
    });
    field.filters.forEach((filter) => {
      pushMissingFieldError(errors, rule, field.sourceTableId, filter.field, `${outputLabel} / ${t("engineRules.fields.filters")}`);
    });
    field.matchConditions.forEach((condition) => {
      if (condition.resultField.trim() && !groupFieldLabels.includes(condition.resultField.trim())) {
        errors.push(
          t("engineProcess.messages.missingResultField", {
            field: condition.resultField,
            output: outputLabel,
          }),
        );
      }
      pushMissingFieldError(
        errors,
        rule,
        field.sourceTableId,
        condition.sourceField,
        `${outputLabel} / ${t("engineRules.fields.matchConditions")}`,
      );
    });

    if (field.valueMode === "dynamic_columns" && field.dynamicColumnConfig.enabled) {
      pushMissingFieldError(errors, rule, field.sourceTableId, field.dynamicColumnConfig.columnField, `${outputLabel} / ${t("engineRules.fields.dynamicColumnField")}`);
      pushMissingFieldError(errors, rule, field.sourceTableId, field.dynamicColumnConfig.valueField, `${outputLabel} / ${t("engineRules.fields.dynamicValueField")}`);
    }

    if (field.valueMode === "dynamic_group_sum" || field.valueMode === "dynamic_group_avg") {
      const dynamicFieldExists = rule.outputFields.some(
        (candidate) =>
          candidate.id === field.dynamicGroupAggregateConfig.sourceFieldId &&
          candidate.valueMode === "dynamic_columns" &&
          candidate.dynamicColumnConfig.enabled,
      );
      if (field.dynamicGroupAggregateConfig.sourceFieldId.trim() && !dynamicFieldExists) {
        errors.push(
          t("engineProcess.messages.missingDynamicAggregateSource", {
            output: outputLabel,
          }),
        );
      }
    }

    if (field.valueMode === "text_aggregate" && field.textAggregateConfig.sortField) {
      pushMissingFieldError(errors, rule, field.sourceTableId, field.textAggregateConfig.sortField, `${outputLabel} / ${t("engineRules.fields.textAggregateSortField")}`);
    }
  });

  return Array.from(new Set(errors.map((item) => item.trim()).filter(Boolean)));
}

async function queueSourceInspectJob(_rule: EngineRuleDefinition, source: EngineRuleSource): Promise<RuntimeSourceState> {
  const state = ensureRuntimeSourceState(source);
  if (!state.filePath) {
    return state;
  }

  state.loading = true;
  state.error = "";
  state.sheetPreview = null;

  try {
    const preview = state.datasetId && state.preview
      ? state.preview
      : await parseSpreadsheetPath(state.filePath);
    const preferredSheetName = state.sheetName.trim() || source.sourceSheetName.trim();
    const resolvedSheetName = preferredSheetName && preview.sheets.some((sheet) => sheet.name === preferredSheetName)
      ? preferredSheetName
      : (preview.sheets[0]?.name ?? "");

    if (!resolvedSheetName) {
      throw new Error(t("engineProcess.messages.sourceLoadFailed"));
    }

    const header = await readSpreadsheetSheetHeader(preview.datasetId, resolvedSheetName);
    state.loading = false;
    state.error = "";
    state.preview = preview;
    state.datasetId = preview.datasetId;
    state.fileName = preview.fileName || state.fileName;
    state.sheetName = resolvedSheetName;
    state.sheetPreview = buildSheetPreview({
      ...header,
      dataMode: header.dataMode ?? "header",
    }, {
      headerRowIndex: source.sourceHeaderRowIndex,
      groupHeaderRowIndex: source.sourceGroupHeaderRowIndex,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    state.loading = false;
    state.preview = null;
    state.sheetPreview = null;
    state.datasetId = "";
    state.error = t("engineProcess.messages.sourceLoadFailed", {
      source: getSourceName(_rule, source.id),
      reason: reason || "-",
    });
  }

  return state;
}

async function ensureSourceDatasetLoaded(source: EngineRuleSource): Promise<RuntimeSourceState> {
  const state = ensureRuntimeSourceState(source);
  if (state.datasetId || !state.filePath) {
    return state;
  }
  if (state.loading) {
    throw new Error(t("engineProcess.messages.preparingSources"));
  }
  throw new Error(state.error || t("engineProcess.messages.preparingSources"));
}

async function uploadSourceFile(_rule: EngineRuleDefinition, source: EngineRuleSource): Promise<void> {
  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Spreadsheet",
        extensions: allowedImportFormats.value,
      },
    ],
  });
  if (!selected || Array.isArray(selected)) {
    return;
  }

  const state = ensureRuntimeSourceState(source);
  state.error = "";
  state.loading = false;
  validationState.value = {
    ran: false,
    passed: false,
    errors: [],
  };

  try {
    state.preview = null;
    state.sheetPreview = null;
    state.datasetId = "";
    state.inspectJobId = "";
    state.filePath = selected;
    state.fileName = basenameFromPath(selected) || source.sourceFileName || t("engineProcess.messages.noFileTemplate");
    state.sheetName = source.sourceSheetName.trim();
    void queueSourceInspectJob(_rule, source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    state.preview = null;
    state.sheetPreview = null;
    state.datasetId = "";
    state.filePath = "";
    state.error = t("engineProcess.messages.sourceLoadFailed", {
      source: getSourceName(_rule, source.id),
      reason: reason || "-",
    });
  }
}

async function handleSourceSheetChange(rule: EngineRuleDefinition, source: EngineRuleSource): Promise<void> {
  validationState.value = {
    ran: false,
    passed: false,
    errors: [],
  };
  void queueSourceInspectJob(rule, source);
}

async function runValidation(): Promise<void> {
  const rule = selectedRule.value;
  if (!rule) {
    validationState.value = {
      ran: true,
      passed: false,
      errors: [t("engineProcess.messages.noRuleSelected")],
    };
    return;
  }

  const errors = validateRuntime(rule);
  validationState.value = {
    ran: true,
    passed: errors.length === 0,
    errors,
  };
}

function goToRuleEngine(): void {
  activeMenu.value = "engineRules";
}

async function handleStartProcess(): Promise<void> {
  const rule = selectedRule.value;
  if (!rule || isProcessing.value) {
    return;
  }

  const errors = validateRuntime(rule);
  validationState.value = {
    ran: true,
    passed: errors.length === 0,
    errors,
  };
  if (errors.length > 0) {
    appendProcessLog(t("engineProcess.messages.validationBlocked"), "error");
    return;
  }

  clearProcessState();
  isProcessing.value = true;
  appendProcessLog(t("engineProcess.messages.processStarted", { rule: rule.name || t("engineRules.library.unnamed") }));

  try {
    appendProcessLog(t("engineProcess.messages.preparingSources"));
    const preparedSources = await Promise.all(
      rule.sources.map(async (source) => {
        const state = await ensureSourceDatasetLoaded(source);
        return {
          sourceId: source.id,
          datasetId: state.datasetId,
          sheetName: state.sheetName,
          fileName: state.fileName,
        };
      }),
    );

    const result = await runEngineProcessTask(
      {
        rule,
        sources: preparedSources,
        mappingGroups: mappingGroups.value,
        exportDirectory: resolvePreferredExportDirectory(),
      },
      {
        onLog: appendProcessLog,
      },
    );

    runSummary.value = {
      outputPath: result.outputPath,
      sheetCount: result.sheetCount,
      rowCount: result.rowCount,
    };
    appendProcessLog(
      t("engineProcess.messages.processCompleted", {
        sheets: result.sheetCount,
        rows: result.rowCount,
        output: result.outputPath,
      }),
      "success",
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    runError.value = reason || t("engineProcess.messages.processFailed");
    appendProcessLog(t("engineProcess.messages.processFailedWithReason", { reason: runError.value }), "error");
  } finally {
    isProcessing.value = false;
  }
}

watch(
  availableRules,
  (rules) => {
    if (!selectedRuleId.value && rules.length > 0) {
      selectedRuleId.value = rules[0].id;
      return;
    }
    if (selectedRuleId.value && !rules.some((rule) => rule.id === selectedRuleId.value)) {
      selectedRuleId.value = rules[0]?.id ?? "";
    }
  },
  { immediate: true },
);

watch(
  selectedRule,
  (rule) => {
    const nextStates: Record<string, RuntimeSourceState> = {};
    if (rule) {
      rule.sources.forEach((source) => {
        const existing = runtimeSources.value[source.id];
        nextStates[source.id] = existing
          ? {
              ...existing,
              fileName: existing.fileName || source.sourceFileName,
              sheetName: existing.sheetName || source.sourceSheetName,
            }
          : createRuntimeSourceState(source);
      });
    }
    runtimeSources.value = nextStates;
    expandedSources.value = {};
    validationState.value = {
      ran: false,
      passed: false,
      errors: [],
    };
    clearProcessState();
  },
  { immediate: true },
);

void reloadEngineRules();
</script>

<template>
  <div class="engine-process-page">
    <section class="engine-process-toolbar">
      <div class="toolbar-copy">
        <p class="toolbar-eyebrow">{{ $t("sidebar.engineProcess.title") }}</p>
        <div class="toolbar-headline">
          <h3>{{ $t("engineProcess.title") }}</h3>
          <span v-if="selectedRule" class="toolbar-badge">
            {{ selectedRule.name || $t("engineRules.library.unnamed") }}
          </span>
        </div>
        <p class="toolbar-description">{{ $t("engineProcess.subtitle") }}</p>
      </div>
      <div class="toolbar-actions">
        <button type="button" class="secondary-btn" @click="goToRuleEngine">
          {{ $t("engineProcess.actions.openRuleEngine") }}
        </button>
      </div>
    </section>

    <div class="engine-process-layout">
      <section class="panel rule-panel">
        <div class="panel-header">
          <div>
            <h4>{{ $t("engineProcess.ruleListTitle") }}</h4>
            <p class="panel-subtitle">{{ $t("engineProcess.executionHint") }}</p>
          </div>
          <span class="panel-count">{{ availableRules.length }}</span>
        </div>
        <p v-if="availableRules.length === 0" class="empty-copy">
          {{ $t("engineProcess.noRules") }}
        </p>
        <label v-else class="rule-select-field">
          <span>{{ $t("engineProcess.ruleListTitle") }}</span>
          <select v-model="selectedRuleId">
            <option v-for="rule in availableRules" :key="rule.id" :value="rule.id">
              {{ rule.name || $t("engineRules.library.unnamed") }}
            </option>
          </select>
        </label>
      </section>

      <template v-if="selectedRule">
        <section class="process-flow-stack">
          <section class="panel summary-panel">
            <div class="panel-header panel-header-wide">
              <div>
                <h4>{{ selectedRule.name || $t("engineRules.library.unnamed") }}</h4>
                <p class="panel-subtitle">{{ selectedRule.description || $t("engineProcess.ruleSummaryEmpty") }}</p>
              </div>
              <div class="summary-badges">
                <span class="summary-badge">{{ $t(`engineRules.ruleTypes.${selectedRule.ruleType}`) }}</span>
                <span class="summary-badge">{{ $t("engineProcess.sourceCount", { count: selectedRule.sources.length }) }}</span>
                <span class="summary-badge" :class="overallReady ? 'ready' : 'pending'">
                  {{ overallReady ? $t("engineProcess.ready") : $t("engineProcess.pending") }}
                </span>
              </div>
            </div>

            <div class="summary-strip">
              <article class="summary-stat">
                <span class="summary-stat-label">{{ $t("engineProcess.sourcesTitle") }}</span>
                <strong>{{ sourceReadyCount }}/{{ selectedRule.sources.length }}</strong>
              </article>
              <article class="summary-stat">
                <span class="summary-stat-label">{{ $t("engineProcess.validationTitle") }}</span>
                <strong>
                  {{
                    !validationState.ran
                      ? $t("engineProcess.validationIdle")
                      : validationState.passed
                        ? $t("engineProcess.validationPassed")
                        : $t("engineProcess.validationFailed")
                  }}
                </strong>
              </article>
              <article class="summary-stat">
                <span class="summary-stat-label">{{ $t("engineProcess.processTitle") }}</span>
                <strong>
                  {{
                    isProcessing
                      ? $t("engineProcess.actions.processing")
                      : runSummary
                        ? $t("engineProcess.processSuccessTitle")
                        : runError
                          ? $t("engineProcess.processFailedTitle")
                          : $t("engineProcess.processIdleTitle")
                  }}
                </strong>
              </article>
            </div>
          </section>

          <section class="panel sources-panel">
            <div class="panel-header">
              <div>
                <h4>{{ $t("engineProcess.sourcesTitle") }}</h4>
                <p class="panel-subtitle">{{ $t("engineProcess.executionHint") }}</p>
              </div>
              <span class="panel-count">{{ sourceReadyCount }}/{{ selectedRule.sources.length }}</span>
            </div>

            <div class="source-list">
              <article v-for="(source, index) in selectedRule.sources" :key="source.id" class="source-card">
                <div class="source-card-top">
                  <div class="source-main">
                    <div class="source-title-row">
                      <strong>{{ sourceLabel(index) }}</strong>
                      <span
                        class="source-state-badge"
                        :class="{
                          loading: getRuntimeSourceState(source).loading,
                          ready: !!getRuntimeSourceState(source).sheetPreview && !getRuntimeSourceState(source).error,
                          error: !!getRuntimeSourceState(source).error,
                        }"
                      >
                        {{
                          getRuntimeSourceState(source).loading
                            ? $t("engineRules.messages.uploading")
                            : getRuntimeSourceState(source).error
                              ? $t("engineProcess.processFailedTitle")
                              : getRuntimeSourceState(source).sheetPreview
                                ? $t("engineProcess.ready")
                                : $t("engineProcess.pending")
                        }}
                      </span>
                    </div>
                    <div class="source-compact-meta">
                      <span class="source-inline-item">
                        {{ getRuntimeSourceState(source).fileName || source.sourceFileName || $t("engineProcess.messages.noFileTemplate") }}
                      </span>
                      <span class="source-inline-item">
                        {{ getRuntimeSourceState(source).sheetName || source.sourceSheetName || $t("engineRules.messages.selectSheet") }}
                      </span>
                    </div>
                  </div>
                  <div class="source-actions">
                    <button
                      type="button"
                      class="secondary-btn"
                      :disabled="isProcessing"
                      @click="uploadSourceFile(selectedRule, source)"
                    >
                      {{ $t("engineProcess.actions.uploadSource") }}
                    </button>
                    <button type="button" class="text-btn" @click="toggleSourceExpanded(source.id)">
                      {{ isSourceExpanded(source.id) ? $t("mapping.actions.collapse") : $t("mapping.actions.expand") }}
                    </button>
                  </div>
                </div>

                <div v-if="isSourceExpanded(source.id)" class="source-card-details">
                  <div class="source-grid">
                    <label class="field-block">
                      <span>{{ $t("engineProcess.sourceFile") }}</span>
                      <input :value="getRuntimeSourceState(source).fileName" type="text" readonly />
                    </label>

                    <label class="field-block">
                      <span>{{ $t("engineRules.fields.sourceSheet") }}</span>
                      <select
                        v-model="getRuntimeSourceState(source).sheetName"
                        :disabled="!getRuntimeSourceState(source).preview || getRuntimeSourceState(source).loading"
                        @change="handleSourceSheetChange(selectedRule, source)"
                      >
                        <option value="">{{ $t("engineRules.messages.selectSheet") }}</option>
                        <option
                          v-for="sheet in getRuntimeSourceState(source).preview?.sheets ?? []"
                          :key="sheet.name"
                          :value="sheet.name"
                        >
                          {{ sheet.name }}
                        </option>
                      </select>
                    </label>

                    <label class="field-block compact-field">
                      <span>{{ $t("engineRules.fields.headerRowIndex") }}</span>
                      <input :value="source.sourceHeaderRowIndex" type="text" readonly />
                    </label>

                    <label class="field-block compact-field">
                      <span>{{ $t("engineRules.fields.groupHeaderRowIndex") }}</span>
                      <input :value="source.sourceGroupHeaderRowIndex" type="text" readonly />
                    </label>
                  </div>

                  <p v-if="getRuntimeSourceState(source).error" class="feedback-text error">
                    {{ getRuntimeSourceState(source).error }}
                  </p>
                  <p v-else-if="getRuntimeSourceState(source).sheetPreview" class="feedback-text success">
                    {{ $t("engineProcess.detectedHeaders", { count: getRuntimeSourceState(source).sheetPreview?.headers.length ?? 0 }) }}
                  </p>

                  <details v-if="getRuntimeSourceState(source).sheetPreview?.headers?.length" class="header-disclosure">
                    <summary class="header-disclosure-summary">
                      <span>{{ $t("engineProcess.detectedHeaders", { count: getRuntimeSourceState(source).sheetPreview?.headers.length ?? 0 }) }}</span>
                      <span class="header-disclosure-hint">{{ getRuntimeSourceState(source).sheetName || source.sourceSheetName }}</span>
                    </summary>
                    <div class="header-chip-list">
                      <span
                        v-for="header in getRuntimeSourceState(source).sheetPreview?.headers ?? []"
                        :key="`${source.id}-${header}`"
                        class="header-chip"
                      >
                        {{ header }}
                      </span>
                    </div>
                  </details>
                </div>
              </article>
            </div>
          </section>

          <section class="panel side-panel">
            <div class="sub-panel-header">
              <h5>{{ $t("engineProcess.validationTitle") }}</h5>
              <button type="button" class="secondary-btn" :disabled="!selectedRule" @click="runValidation">
                {{ $t("engineProcess.actions.validateRule") }}
              </button>
            </div>

            <p class="panel-subtitle">{{ $t("engineProcess.validationHint") }}</p>

            <div
              class="validation-result"
              :class="validationState.ran ? (validationState.passed ? 'passed' : 'failed') : 'idle'"
            >
              <strong>
                {{
                  !validationState.ran
                    ? $t("engineProcess.validationIdle")
                    : validationState.passed
                      ? $t("engineProcess.validationPassed")
                      : $t("engineProcess.validationFailed")
                }}
              </strong>
              <span>
                {{
                  validationState.ran
                    ? validationState.passed
                      ? $t("engineProcess.validationPassedHint")
                      : $t("engineProcess.validationFailedHint", { count: validationState.errors.length })
                    : $t("engineProcess.validationIdleHint")
                }}
              </span>
            </div>

            <ul v-if="validationState.ran && validationState.errors.length > 0" class="error-list">
              <li v-for="error in validationState.errors" :key="error">
                {{ error }}
              </li>
            </ul>
          </section>

          <section class="panel side-panel">
            <div class="sub-panel-header">
              <h5>{{ $t("engineProcess.processTitle") }}</h5>
              <button type="button" class="primary-btn accent-btn" :disabled="!canStart" @click="handleStartProcess">
                {{ isProcessing ? $t("engineProcess.actions.processing") : $t("engineProcess.actions.startProcess") }}
              </button>
            </div>

            <p class="panel-subtitle">{{ $t("engineProcess.processHint") }}</p>

            <div v-if="runSummary" class="validation-result passed">
              <strong>{{ $t("engineProcess.processSuccessTitle") }}</strong>
              <span>
                {{ $t("engineProcess.processSuccessHint", { sheets: runSummary.sheetCount, rows: runSummary.rowCount }) }}
              </span>
              <span class="path-text">{{ runSummary.outputPath }}</span>
            </div>

            <div v-else-if="runError" class="validation-result failed">
              <strong>{{ $t("engineProcess.processFailedTitle") }}</strong>
              <span>{{ runError }}</span>
            </div>

            <div v-else class="validation-result idle">
              <strong>{{ $t("engineProcess.processIdleTitle") }}</strong>
              <span>{{ $t("engineProcess.processIdleHint") }}</span>
            </div>

            <div class="log-board">
              <div class="log-board-header">
                <strong>{{ $t("engineProcess.logsTitle") }}</strong>
                <span>{{ processLogs.length }}</span>
              </div>
              <div v-if="displayProcessLogs.length > 0" class="log-stream">
                <p v-for="logItem in displayProcessLogs" :key="logItem.id" class="log-line">
                  <span class="log-time">{{ logItem.time }}</span>
                  <span class="log-message" :class="logItem.level">{{ logItem.message }}</span>
                </p>
              </div>
              <p v-else class="empty-copy">{{ $t("engineProcess.logsEmpty") }}</p>
            </div>
          </section>
        </section>
      </template>

      <section v-else class="panel empty-state">
        <h4>{{ $t("engineProcess.noRules") }}</h4>
        <p>{{ $t("engineProcess.noRulesHint") }}</p>
        <button type="button" class="primary-btn" @click="goToRuleEngine">
          {{ $t("engineProcess.actions.openRuleEngine") }}
        </button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.engine-process-page {
  min-height: 0;
  display: grid;
  gap: 16px;
}

.engine-process-toolbar,
.panel,
.source-card,
.validation-result,
.header-chip,
.summary-badge,
.summary-stat,
.toolbar-badge,
.source-state-badge,
.empty-state {
  border: 1px solid var(--stroke-soft);
  background: var(--bg-card);
  border-radius: 18px;
}

.engine-process-toolbar,
.panel,
.source-card,
.empty-state {
  box-shadow: var(--shadow-soft);
}

.engine-process-toolbar {
  padding: 18px 20px;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 18px;
}

.toolbar-copy {
  display: grid;
  gap: 6px;
}

.toolbar-eyebrow {
  margin: 0;
  font-size: var(--fs-caption);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
}

.toolbar-headline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.toolbar-copy h3 {
  margin: 0;
  font-size: 22px;
  line-height: 1.2;
}

.toolbar-description {
  margin: 0;
  max-width: 720px;
  color: var(--text-muted);
}

.toolbar-badge {
  padding: 6px 10px;
  font-size: var(--fs-caption);
  color: var(--accent);
}

.toolbar-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.engine-process-layout {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.panel {
  min-height: 0;
  padding: 16px;
  display: grid;
  gap: 14px;
  overflow: hidden;
}

.rule-panel {
  grid-template-columns: minmax(0, 1fr);
}

.process-flow-stack {
  min-height: 0;
  display: grid;
  gap: 16px;
  align-content: start;
}

.panel-header,
.panel-header-wide,
.sub-panel-header,
.log-board-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.panel-header h4,
.sub-panel-header h5,
.empty-state h4 {
  margin: 0;
  font-size: 16px;
}

.panel-header-wide {
  align-items: flex-start;
  flex-wrap: wrap;
}

.panel-subtitle,
.empty-copy,
.empty-state p {
  margin: 0;
  color: var(--text-muted);
}

.panel-count {
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.summary-badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.summary-badge {
  padding: 6px 10px;
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.summary-badge.ready {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, var(--stroke-soft));
}

.summary-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.summary-stat,
.side-panel {
  padding: 14px;
}

.summary-stat {
  display: grid;
  gap: 4px;
  background: var(--bg-input);
}

.summary-stat-label {
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.summary-stat strong {
  font-size: 16px;
}

.source-list {
  display: grid;
  gap: 12px;
}

.source-card {
  padding: 14px;
  display: grid;
  gap: 12px;
}

.source-card-top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.source-main {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.source-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}

.source-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.source-main strong,
.source-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-meta {
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.source-compact-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.source-inline-item {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--stroke-soft);
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-muted);
  font-size: var(--fs-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-state-badge {
  padding: 4px 8px;
  font-size: var(--fs-caption);
  color: var(--text-muted);
  background: var(--bg-input);
}

.source-state-badge.ready,
.source-state-badge.loading {
  color: var(--accent);
}

.source-state-badge.error {
  color: var(--danger, #d34b4b);
}

.source-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 120px 120px;
  gap: 10px;
}

.source-card-details {
  display: grid;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--stroke-soft);
}

.field-block {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.rule-select-field {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.field-block span {
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.rule-select-field span {
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.field-block input,
.field-block select,
.rule-select-field select {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--stroke-soft);
  background: var(--bg-input);
  color: var(--text-main);
  border-radius: 12px;
  padding: 10px 12px;
  outline: none;
}

.feedback-text {
  margin: 0;
  font-size: var(--fs-sm);
}

.feedback-text.success {
  color: var(--accent);
}

.feedback-text.error {
  color: var(--danger, #d34b4b);
}

.path-text {
  display: block;
  word-break: break-all;
  color: var(--text-main);
}

.header-disclosure {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--stroke-soft);
  padding-top: 10px;
}

.header-disclosure-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  list-style: none;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.header-disclosure-summary::-webkit-details-marker {
  display: none;
}

.header-disclosure-hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-caption);
}

.header-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 156px;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.header-chip-list::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.header-chip {
  max-width: 240px;
  padding: 6px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-caption);
  color: var(--text-muted);
  background: var(--bg-input);
}

.validation-result {
  padding: 14px 16px;
  display: grid;
  gap: 4px;
}

.validation-result strong {
  font-size: var(--fs-sm);
}

.validation-result span {
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.validation-result.passed {
  border-color: color-mix(in srgb, var(--accent) 35%, var(--stroke-soft));
}

.validation-result.failed {
  border-color: color-mix(in srgb, #d34b4b 35%, var(--stroke-soft));
}

.error-list {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 8px;
  color: var(--danger, #d34b4b);
}

.log-board {
  display: grid;
  gap: 10px;
  min-height: 0;
}

.log-board-header {
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.log-stream {
  margin: 0;
  padding: 12px 14px;
  display: grid;
  gap: 6px;
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  background: var(--bg-input);
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.log-stream::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.log-line {
  margin: 0;
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 0;
}

.log-time {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.log-message {
  min-width: 0;
  word-break: break-word;
  font-size: var(--fs-sm);
  color: var(--text-main);
}

.log-message.success {
  color: var(--accent);
}

.log-message.error {
  color: var(--danger, #d34b4b);
}

.empty-state {
  min-height: 280px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  text-align: center;
  padding: 24px;
}

.primary-btn,
.secondary-btn {
  border-radius: 12px;
  padding: 10px 14px;
  font: inherit;
  cursor: pointer;
  transition: transform 120ms ease, border-color 120ms ease, background-color 120ms ease;
}

.primary-btn {
  border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent);
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-input));
  color: var(--text-main);
}

.accent-btn {
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, var(--bg-input)), color-mix(in srgb, var(--accent) 30%, var(--bg-card)));
}

.secondary-btn {
  border: 1px solid var(--stroke-soft);
  background: var(--bg-input);
  color: var(--text-main);
}

.text-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
  padding: 0;
}

.primary-btn:hover:not(:disabled),
.secondary-btn:hover:not(:disabled),
.text-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.primary-btn:disabled,
.secondary-btn:disabled,
.text-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.sub-panel-header {
  flex-wrap: wrap;
}

@media (max-width: 860px) {
  .engine-process-toolbar,
  .source-card-top,
  .source-actions {
    flex-direction: column;
  }

  .toolbar-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .source-actions {
    align-items: stretch;
  }

  .summary-strip {
    grid-template-columns: 1fr;
  }

  .source-grid {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 640px) {
  .source-grid {
    grid-template-columns: 1fr;
  }

  .summary-badges {
    justify-content: flex-start;
  }
}
</style>
