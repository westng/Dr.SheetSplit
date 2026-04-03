<script setup lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import EngineRuleLibrary from "./EngineRuleLibrary.vue";
import { useEngineRuleStore, useMappingStore, useUiStore } from "../../store";
import type { EngineRuleDefinition, EngineRuleOutputField, EngineRuleSource } from "../../types/engineRule";
import { validateEngineRuleDraft } from "../../utils/engineRuleValidator";
import {
  buildSheetPreview,
  parseSpreadsheetPath,
  readSpreadsheetSheetHeader,
  type SpreadsheetPreview,
  type SpreadsheetSheetPreview,
} from "../../utils/spreadsheetParser";
import { useImportSettings } from "../../composables/useImportSettings";
import { runEngineProcessTask } from "../../services/engineProcess";
import type { TaskHistoryLogItem } from "../../types/history";

type RuntimeSourceState = {
  datasetId: string;
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
const isProcessing = ref(false);
const processLogs = ref<TaskHistoryLogItem[]>([]);
const runError = ref("");
const runSummary = ref<{
  outputPath: string;
  sheetCount: number;
  rowCount: number;
} | null>(null);

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
    return Boolean(state?.datasetId && state.sheetName && state.sheetPreview && !state.error);
  });
});

const sourceReadyCount = computed(() => {
  if (!selectedRule.value) {
    return 0;
  }
  return selectedRule.value.sources.filter((source) => {
    const state = runtimeSources.value[source.id];
    return Boolean(state?.datasetId && state.sheetName && state.sheetPreview && !state.error);
  }).length;
});

const canStart = computed(() =>
  Boolean(selectedRule.value) && overallReady.value && !isProcessing.value,
);

const displayProcessLogs = computed(() => [...processLogs.value].reverse());

function createRuntimeSourceState(source: EngineRuleSource): RuntimeSourceState {
  return {
    datasetId: "",
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
}

function clearProcessState(): void {
  processLogs.value = [];
  runError.value = "";
  runSummary.value = null;
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
): void {
  if (!fieldName.trim()) {
    return;
  }
  if (hasSourceField(sourceId, fieldName)) {
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

  rule.sources.forEach((source, index) => {
    const state = runtimeSources.value[source.id];
    if (!state?.datasetId) {
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
    if (field.sourceTableId && field.sourceField) {
      pushMissingFieldError(errors, rule, field.sourceTableId, field.sourceField, outputLabel);
    }

    if (field.nameSourceTableId && field.nameSourceField) {
      pushMissingFieldError(errors, rule, field.nameSourceTableId, field.nameSourceField, `${outputLabel} / ${t("engineRules.fields.nameSourceField")}`);
    }

    field.mappingSourceFields.forEach((name) => {
      pushMissingFieldError(errors, rule, field.sourceTableId, name, `${outputLabel} / ${t("engineRules.fields.mappingSourceFields")}`);
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

    if (field.valueMode === "text_aggregate" && field.textAggregateConfig.sortField) {
      pushMissingFieldError(errors, rule, field.sourceTableId, field.textAggregateConfig.sortField, `${outputLabel} / ${t("engineRules.fields.textAggregateSortField")}`);
    }
  });

  return Array.from(new Set(errors.map((item) => item.trim()).filter(Boolean)));
}

async function loadSourceHeader(rule: EngineRuleDefinition, source: EngineRuleSource): Promise<void> {
  const state = ensureRuntimeSourceState(source);
  if (!state.datasetId || !state.sheetName.trim()) {
    state.sheetPreview = null;
    return;
  }

  state.loading = true;
  state.error = "";
  try {
    const headerData = await readSpreadsheetSheetHeader(state.datasetId, state.sheetName);
    state.sheetPreview = buildSheetPreview(headerData, {
      headerRowIndex: source.sourceHeaderRowIndex,
      groupHeaderRowIndex: source.sourceGroupHeaderRowIndex,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    state.sheetPreview = null;
    state.error = t("engineProcess.messages.headerLoadFailed", {
      source: getSourceName(rule, source.id),
      reason: reason || "-",
    });
  } finally {
    state.loading = false;
  }
}

async function uploadSourceFile(rule: EngineRuleDefinition, source: EngineRuleSource): Promise<void> {
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
  state.loading = true;
  state.error = "";
  validationState.value = {
    ran: false,
    passed: false,
    errors: [],
  };

  try {
    const preview = await parseSpreadsheetPath(selected);
    state.preview = preview;
    state.datasetId = preview.datasetId;
    state.fileName = preview.fileName;
    state.sheetName = preview.sheets.some((sheet) => sheet.name === source.sourceSheetName)
      ? source.sourceSheetName
      : preview.sheets[0]?.name ?? "";
    await loadSourceHeader(rule, source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    state.preview = null;
    state.sheetPreview = null;
    state.datasetId = "";
    state.error = t("engineProcess.messages.sourceLoadFailed", {
      source: getSourceName(rule, source.id),
      reason: reason || "-",
    });
  } finally {
    state.loading = false;
  }
}

async function handleSourceSheetChange(rule: EngineRuleDefinition, source: EngineRuleSource): Promise<void> {
  validationState.value = {
    ran: false,
    passed: false,
    errors: [],
  };
  await loadSourceHeader(rule, source);
}

function runValidation(): void {
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
    const result = await runEngineProcessTask(
      {
        rule,
        sources: rule.sources.map((source) => {
          const state = runtimeSources.value[source.id];
          return {
            sourceId: source.id,
            datasetId: state?.datasetId ?? "",
            sheetName: state?.sheetName ?? "",
            fileName: state?.fileName ?? "",
          };
        }),
        mappingGroups: mappingGroups.value,
        exportDirectory: "",
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
    <section class="engine-process-hero">
      <div class="hero-copy">
        <p class="hero-eyebrow">{{ $t("sidebar.engineProcess.title") }}</p>
        <h3>{{ $t("engineProcess.title") }}</h3>
        <p class="hero-description">{{ $t("engineProcess.subtitle") }}</p>
      </div>
      <div class="hero-actions">
        <button type="button" class="secondary-btn" @click="goToRuleEngine">
          {{ $t("engineProcess.actions.openRuleEngine") }}
        </button>
        <button type="button" class="primary-btn" :disabled="!selectedRule" @click="runValidation">
          {{ $t("engineProcess.actions.validateRule") }}
        </button>
        <button type="button" class="primary-btn accent-btn" :disabled="!canStart" @click="handleStartProcess">
          {{ isProcessing ? $t("engineProcess.actions.processing") : $t("engineProcess.actions.startProcess") }}
        </button>
      </div>
    </section>

    <div class="engine-process-layout">
      <aside class="panel rule-panel">
        <div class="panel-header">
          <h4>{{ $t("engineProcess.ruleListTitle") }}</h4>
          <span class="panel-count">{{ availableRules.length }}</span>
        </div>
        <p v-if="availableRules.length === 0" class="empty-copy">
          {{ $t("engineProcess.noRules") }}
        </p>
        <EngineRuleLibrary
          v-else
          :rules="availableRules"
          :active-rule-id="selectedRuleId"
          :disabled="false"
          :show-title="false"
          @select="selectedRuleId = $event"
        />
      </aside>

      <section class="panel workbench-panel">
        <template v-if="selectedRule">
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

          <div class="content-stack">
            <section class="sub-panel">
              <div class="sub-panel-header">
                <h5>{{ $t("engineProcess.sourcesTitle") }}</h5>
                <span class="sub-panel-meta">{{ sourceReadyCount }}/{{ selectedRule.sources.length }}</span>
              </div>

              <div class="source-list">
                <article v-for="(source, index) in selectedRule.sources" :key="source.id" class="source-card">
                  <div class="source-card-top">
                    <div class="source-main">
                      <strong>{{ sourceLabel(index) }}</strong>
                      <span class="source-meta">
                        {{ source.sourceFileName || $t("engineProcess.messages.noFileTemplate") }}
                      </span>
                    </div>
                    <button
                      type="button"
                      class="secondary-btn"
                      :disabled="getRuntimeSourceState(source).loading"
                      @click="uploadSourceFile(selectedRule, source)"
                    >
                      {{ getRuntimeSourceState(source).loading ? $t("engineRules.messages.uploading") : $t("engineProcess.actions.uploadSource") }}
                    </button>
                  </div>

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

                  <div v-if="getRuntimeSourceState(source).sheetPreview?.headers?.length" class="header-chip-list">
                    <span
                      v-for="header in getRuntimeSourceState(source).sheetPreview?.headers ?? []"
                      :key="`${source.id}-${header}`"
                      class="header-chip"
                    >
                      {{ header }}
                    </span>
                  </div>
                </article>
              </div>
            </section>

            <section class="sub-panel">
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

              <p class="pending-note">
                {{ $t("engineProcess.executionHint") }}
              </p>
            </section>

            <section class="sub-panel">
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
                <ul v-if="displayProcessLogs.length > 0" class="log-list">
                  <li v-for="logItem in displayProcessLogs" :key="logItem.id" class="log-item">
                    <span class="log-time">{{ logItem.time }}</span>
                    <span class="log-message" :class="logItem.level">{{ logItem.message }}</span>
                  </li>
                </ul>
                <p v-else class="empty-copy">{{ $t("engineProcess.logsEmpty") }}</p>
              </div>
            </section>
          </div>
        </template>

        <div v-else class="empty-state">
          <h4>{{ $t("engineProcess.noRules") }}</h4>
          <p>{{ $t("engineProcess.noRulesHint") }}</p>
          <button type="button" class="primary-btn" @click="goToRuleEngine">
            {{ $t("engineProcess.actions.openRuleEngine") }}
          </button>
        </div>
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

.engine-process-hero,
.panel,
.sub-panel,
.source-card,
.validation-result,
.header-chip,
.summary-badge,
.empty-state {
  border: 1px solid var(--stroke-soft);
  background: var(--bg-card);
  border-radius: 18px;
}

.engine-process-hero,
.panel,
.sub-panel,
.source-card,
.empty-state {
  box-shadow: var(--shadow-soft);
}

.engine-process-hero {
  padding: 18px 20px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 18px;
}

.hero-copy {
  display: grid;
  gap: 6px;
}

.hero-eyebrow {
  margin: 0;
  font-size: var(--fs-caption);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent);
}

.hero-copy h3 {
  margin: 0;
  font-size: 24px;
  line-height: 1.2;
}

.hero-description {
  margin: 0;
  max-width: 720px;
  color: var(--text-muted);
}

.hero-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.engine-process-layout {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  gap: 16px;
}

.panel {
  min-height: 0;
  padding: 16px;
  display: grid;
  gap: 14px;
  overflow: hidden;
}

.rule-panel {
  grid-template-rows: auto minmax(0, 1fr);
}

.workbench-panel {
  align-content: start;
}

.panel-header,
.sub-panel-header,
.panel-header-wide {
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
}

.panel-subtitle,
.empty-copy,
.pending-note,
.empty-state p {
  margin: 0;
  color: var(--text-muted);
}

.panel-count,
.sub-panel-meta {
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

.content-stack {
  display: grid;
  gap: 14px;
}

.sub-panel {
  padding: 14px;
  display: grid;
  gap: 12px;
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

.source-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 120px 120px;
  gap: 10px;
}

.field-block {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.field-block span {
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.field-block input,
.field-block select {
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

.header-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 116px;
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.log-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
  max-height: 280px;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.log-list::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.log-item {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 10px 12px;
  border: 1px solid var(--stroke-soft);
  border-radius: 12px;
  background: var(--bg-input);
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

.primary-btn:hover:not(:disabled),
.secondary-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.primary-btn:disabled,
.secondary-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

@media (max-width: 1180px) {
  .engine-process-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 860px) {
  .engine-process-hero,
  .source-card-top {
    flex-direction: column;
  }

  .hero-actions {
    width: 100%;
    justify-content: flex-start;
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
