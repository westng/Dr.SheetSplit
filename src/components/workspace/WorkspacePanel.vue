<script setup lang="ts">
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { runProcessTask } from "../../services/process";
import type { ProcessTaskStage } from "../../services/process/types";
import type { CreateTaskHistoryInput, TaskHistoryLogItem } from "../../types/history";
import { useHistoryStore, useMappingStore, useRuleStore } from "../../store";
import { useImportSettings } from "../../composables/useImportSettings";
import { basenameFromPath } from "../../utils/nativeFile";
import {
  buildSheetPreview,
  inspectSpreadsheetPath,
  parseSpreadsheetFile,
  readSpreadsheetSheetHeader,
  readSpreadsheetSheetHeaderFromPath,
  type SpreadsheetPreview,
  type SpreadsheetSheetData,
  type SpreadsheetSheetPreview,
} from "../../utils/spreadsheetParser";
import { validateRuleCompatibility } from "../../utils/ruleValidator";

const { t } = useI18n();
const { rules, isRuleStoreReady } = useRuleStore();
const { mappingGroups } = useMappingStore();
const { recordTask } = useHistoryStore();
const { allowedImportFormats, allowedImportAccept, allowedImportDisplay, isAllowedImportFile } = useImportSettings();
const PROCESS_LOG_EVENT = "process-log";

const sourceFileInputRef = ref<HTMLInputElement | null>(null);
const processLogListRef = ref<HTMLUListElement | null>(null);
const selectedRuleId = ref("");
const sourcePreview = ref<SpreadsheetPreview | null>(null);
const selectedSheetName = ref("");
const selectedSheetData = ref<SpreadsheetSheetData | null>(null);
const sourceFileName = ref("");
const sourceFilePath = ref("");
const isParsingSource = ref(false);
const isDragOver = ref(false);
const loadError = ref("");
const runMessage = ref("");
const isProcessing = ref(false);
const processLogs = ref<TaskHistoryLogItem[]>([]);
const isCheckingCompatibility = ref(false);
const compatibilityResult = ref<{
  isCompatible: boolean;
  errors: string[];
}>({
  isCompatible: false,
  errors: [],
});
let unlistenProcessLog: UnlistenFn | undefined;
const compatibilityCache = new Map<string, { isCompatible: boolean; errors: string[] }>();

const selectedRule = computed(() => rules.value.find((item) => item.id === selectedRuleId.value) ?? null);
const selectedSheetPreview = computed<SpreadsheetSheetPreview | null>(() => {
  if (!selectedSheetData.value) {
    return null;
  }
  return buildSheetPreview(selectedSheetData.value, {
    headerRowIndex: selectedRule.value?.sourceHeaderRowIndex ?? 1,
    groupHeaderRowIndex: selectedRule.value?.sourceGroupHeaderRowIndex ?? 0,
    groupName: selectedRule.value?.sourceGroupName ?? "",
  });
});
const selectedRuleSignature = computed(() => (selectedRule.value ? JSON.stringify(selectedRule.value) : ""));
const sheetHeaderSignature = computed(() => selectedSheetPreview.value?.headers.join("\u0001") ?? "");
const mappingSignature = computed(() =>
  mappingGroups.value
    .map((group) => `${group.id}:${group.entries.length}`)
    .join("|"),
);
const canStart = computed(
  () =>
    Boolean(selectedRule.value) &&
    Boolean(selectedSheetPreview.value) &&
    compatibilityResult.value.isCompatible &&
    !isCheckingCompatibility.value &&
    !isParsingSource.value &&
    !isProcessing.value,
);
const displayProcessLogs = computed(() => [...processLogs.value].reverse());
const dynamicSheetPreview = computed(() => {
  if (!selectedRule.value || !selectedSheetPreview.value) {
    return [] as string[];
  }

  if (selectedRule.value.groupByFields.length === 0) {
    return [t("workspace.messages.noDynamicSplitPreview", { sheet: selectedSheetPreview.value.name })];
  }

  const excludeSet = resolveGroupExcludeSet(selectedRule.value);
  const preview = new Set<string>();
  for (const row of selectedSheetPreview.value.sampleRows) {
    if (!matchesSourceFilters(selectedRule.value, row)) {
      continue;
    }
    const groupField = selectedRule.value.groupByFields[0];
    const groupValue = String(row[groupField] ?? "").trim();
    if (groupValue && excludeSet.has(groupValue)) {
      continue;
    }

    const key = selectedRule.value.groupByFields
      .map((field) => row[field] ?? "")
      .map((item) => String(item).trim())
      .join(" | ");
    if (key) {
      preview.add(key);
    }
    if (preview.size >= 10) {
      break;
    }
  }
  return Array.from(preview);
});

function matchesSourceFilters(
  rule: NonNullable<typeof selectedRule.value>,
  row: Record<string, string>,
): boolean {
  if (rule.sourceFilters.length === 0) {
    return true;
  }

  return rule.sourceFilters.every((filter) => {
    const field = filter.field.trim();
    if (!field) {
      return true;
    }
    const value = String(row[field] ?? "").trim();
    if (filter.operator === "contains_any") {
      return filter.keywords.some((keyword) => keyword && value.includes(keyword));
    }
    return true;
  });
}

function splitExcludeText(value: string): string[] {
  return value
    .split(/[\n\r,，\s]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveGroupExcludeSet(rule: NonNullable<typeof selectedRule.value>): Set<string> {
  if (!rule.groupByFields[0]) {
    return new Set<string>();
  }

  if (rule.groupExcludeMode === "manual_values") {
    return new Set(splitExcludeText(rule.groupExcludeValuesText));
  }

  if (rule.groupExcludeMode === "mapping_group_source" && rule.groupExcludeMappingSection) {
    const group = mappingGroups.value.find((item) => item.id === rule.groupExcludeMappingSection);
    if (!group) {
      return new Set<string>();
    }
    return new Set(group.entries.map((entry) => entry.source.trim()).filter(Boolean));
  }

  return new Set<string>();
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

  void nextTick(() => {
    const element = processLogListRef.value;
    if (!element) {
      return;
    }
    element.scrollTop = 0;
  });
}

function clearProcessLogs(): void {
  processLogs.value = [];
}

function resetCompatibilityResult(): void {
  compatibilityResult.value = {
    isCompatible: false,
    errors: [],
  };
}

function buildCompatibilityCacheKey(): string {
  return [
    selectedRuleSignature.value,
    sheetHeaderSignature.value,
    mappingSignature.value,
  ].join("::");
}

function snapshotProcessLogs(): TaskHistoryLogItem[] {
  return processLogs.value.map((item) => ({ ...item }));
}

async function persistTaskHistory(input: CreateTaskHistoryInput): Promise<void> {
  try {
    await recordTask(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    appendProcessLog(t("workspace.messages.historyPersistFailed", { reason: reason || "-" }), "error");
  }
}

function resolveStageMessage(stage: ProcessTaskStage): string {
  return t(`workspace.messages.logStage.${stage}`);
}

async function openSourceFilePicker(): Promise<void> {
  if (isParsingSource.value) {
    return;
  }

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

  await processSourcePath(selected);
}

function handleDropzoneKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  event.preventDefault();
  if (!isParsingSource.value) {
    openSourceFilePicker();
  }
}

function resolveInitialSheetName(preview: SpreadsheetPreview): string {
  if (!selectedRule.value) {
    return preview.sheets[0]?.name ?? "";
  }
  if (!selectedRule.value.sourceSheetName) {
    return preview.sheets[0]?.name ?? "";
  }

  const matched = preview.sheets.find((sheet) => sheet.name === selectedRule.value?.sourceSheetName);
  return matched?.name ?? preview.sheets[0]?.name ?? "";
}

async function handleSourceFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  await processSourceFile(file);
  input.value = "";
}

async function processSourceFile(file: File): Promise<void> {
  if (!file) {
    return;
  }

  if (!isAllowedImportFile(file)) {
    loadError.value = t("workspace.messages.invalidFormat", {
      formats: allowedImportDisplay.value,
    });
    appendProcessLog(loadError.value, "error");
    return;
  }

  isParsingSource.value = true;
  runMessage.value = "";
  loadError.value = "";

  try {
    const parsed = await parseSpreadsheetFile(file);
    sourcePreview.value = parsed;
    selectedSheetData.value = null;
    sourceFileName.value = parsed.fileName;
    sourceFilePath.value = "";
    selectedSheetName.value = resolveInitialSheetName(parsed);

    if (parsed.sheets.length === 0) {
      loadError.value = t("workspace.messages.noSheetFound");
      appendProcessLog(loadError.value, "error");
    } else {
      appendProcessLog(
        t("workspace.messages.logSourceLoaded", {
          file: parsed.fileName,
          sheet: selectedSheetName.value,
          count: parsed.sheets.length,
        }),
        "info",
      );
    }
  } catch (error) {
    console.error("Failed to parse source file in workspace.", error);
    sourcePreview.value = null;
    selectedSheetData.value = null;
    selectedSheetName.value = "";
    sourceFileName.value = "";
    sourceFilePath.value = "";
    loadError.value = `${t("workspace.messages.loadFailed")} ${toErrorMessage(error)}`.trim();
    appendProcessLog(loadError.value, "error");
  } finally {
    isParsingSource.value = false;
  }
}

async function processSourcePath(filePath: string): Promise<void> {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    return;
  }

  if (!isAllowedImportFile(normalizedPath)) {
    loadError.value = t("workspace.messages.invalidFormat", {
      formats: allowedImportDisplay.value,
    });
    appendProcessLog(loadError.value, "error");
    return;
  }

  isParsingSource.value = true;
  runMessage.value = "";
  loadError.value = "";

  try {
    const parsed = await inspectSpreadsheetPath(normalizedPath);
    sourcePreview.value = parsed;
    selectedSheetData.value = null;
    sourceFileName.value = parsed.fileName || basenameFromPath(normalizedPath);
    sourceFilePath.value = normalizedPath;
    selectedSheetName.value = resolveInitialSheetName(parsed);

    if (parsed.sheets.length === 0) {
      loadError.value = t("workspace.messages.noSheetFound");
      appendProcessLog(loadError.value, "error");
    } else {
      appendProcessLog(
        t("workspace.messages.logSourceLoaded", {
          file: sourceFileName.value,
          sheet: selectedSheetName.value,
          count: parsed.sheets.length,
        }),
        "info",
      );
    }
  } catch (error) {
    console.error("Failed to parse source file from path in workspace.", error);
    sourcePreview.value = null;
    selectedSheetData.value = null;
    selectedSheetName.value = "";
    sourceFileName.value = basenameFromPath(normalizedPath);
    sourceFilePath.value = "";
    loadError.value = `${t("workspace.messages.loadFailed")} ${toErrorMessage(error)}`.trim();
    appendProcessLog(loadError.value, "error");
  } finally {
    isParsingSource.value = false;
  }
}

function handleDragEnter(event: DragEvent): void {
  event.preventDefault();
  if (!isParsingSource.value) {
    isDragOver.value = true;
  }
}

function handleDragOver(event: DragEvent): void {
  event.preventDefault();
  if (!isParsingSource.value) {
    isDragOver.value = true;
  }
}

function handleDragLeave(event: DragEvent): void {
  event.preventDefault();
  const currentTarget = event.currentTarget as HTMLElement | null;
  const nextTarget = event.relatedTarget as Node | null;
  if (currentTarget && nextTarget && currentTarget.contains(nextTarget)) {
    return;
  }
  isDragOver.value = false;
}

async function handleDrop(event: DragEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  isDragOver.value = false;
  if (isParsingSource.value) {
    return;
  }

  const file = event.dataTransfer?.files?.[0];
  if (!file) {
    return;
  }

  const filePath = String((file as File & { path?: string }).path ?? "").trim();
  if (filePath) {
    await processSourcePath(filePath);
    return;
  }

  await processSourceFile(file);
}

function resolveExportDirectory(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return String(window.localStorage.getItem("settings.exportDirectory") ?? "").trim();
}

function toErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    const normalized = error.trim();
    if (normalized) {
      return normalized;
    }
  }

  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) {
      return message;
    }
  }

  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    for (const key of ["message", "error", "details", "reason", "data"]) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    try {
      const serialized = JSON.stringify(candidate);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      return t("workspace.messages.processFailedGeneric");
    }
  }

  return t("workspace.messages.processFailedGeneric");
}

async function handleStartProcess(): Promise<void> {
  if (!canStart.value || !selectedRule.value || !selectedSheetPreview.value || !sourcePreview.value) {
    return;
  }

  const startedAtMs = Date.now();
  const historyRuleName = selectedRule.value.name || t("rules.library.unnamed");
  const historySourceFileName = sourceFileName.value || sourcePreview.value?.fileName || "source.xlsx";
  const historySourceSheetName = selectedSheetPreview.value.name;

  isProcessing.value = true;
  clearProcessLogs();
  runMessage.value = t("workspace.messages.processing");
  loadError.value = "";
  appendProcessLog(
    t("workspace.messages.logStart", {
      rule: selectedRule.value.name || t("rules.library.unnamed"),
      sheet: selectedSheetPreview.value.name,
    }),
  );

  try {
    const result = await runProcessTask({
      rule: selectedRule.value,
      mappingGroups: [...mappingGroups.value],
      datasetId: sourcePreview.value.datasetId,
      sourceFilePath: sourceFilePath.value,
      sourceSheetName: historySourceSheetName,
      sourceFileName: historySourceFileName,
      exportDirectory: resolveExportDirectory(),
      unmatchedFallback: "未知错误",
    }, {
      onStage: (stage) => {
        appendProcessLog(resolveStageMessage(stage));
      },
    });

    runMessage.value = t("workspace.messages.processSuccess", {
      path: result.outputPath,
      sheets: result.sheetCount,
      rows: result.rowCount,
    });
    appendProcessLog(runMessage.value, "success");

    const finishedAtMs = Date.now();
    await persistTaskHistory({
      status: "success",
      ruleId: selectedRule.value.id,
      ruleName: historyRuleName,
      sourceFileName: historySourceFileName,
      sourceSheetName: historySourceSheetName,
      outputPath: result.outputPath,
      sheetCount: result.sheetCount,
      rowCount: result.rowCount,
      errorMessage: "",
      resultPayload: {
        outputPath: result.outputPath,
        engineOutput: result.engineOutput,
      },
      logs: snapshotProcessLogs(),
      startedAtMs,
      finishedAtMs,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
    });
  } catch (error) {
    runMessage.value = "";
    const reason = toErrorMessage(error);
    loadError.value = t("workspace.messages.processFailed", { reason });
    appendProcessLog(t("workspace.messages.logFailed", { reason }), "error");

    const finishedAtMs = Date.now();
    await persistTaskHistory({
      status: "failed",
      ruleId: selectedRule.value.id,
      ruleName: historyRuleName,
      sourceFileName: historySourceFileName,
      sourceSheetName: historySourceSheetName,
      outputPath: "",
      sheetCount: 0,
      rowCount: 0,
      errorMessage: reason,
      resultPayload: null,
      logs: snapshotProcessLogs(),
      startedAtMs,
      finishedAtMs,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
    });
  } finally {
    isProcessing.value = false;
  }
}

function preventWindowFileDrop(event: DragEvent): void {
  event.preventDefault();
}

onMounted(async () => {
  window.addEventListener("dragover", preventWindowFileDrop);
  window.addEventListener("drop", preventWindowFileDrop);
  unlistenProcessLog = await listen<{ message?: string }>(PROCESS_LOG_EVENT, (event) => {
    if (!isProcessing.value) {
      return;
    }
    const message = String(event.payload?.message ?? "").trim();
    if (!message) {
      return;
    }
    appendProcessLog(message);
  });
});

onUnmounted(() => {
  window.removeEventListener("dragover", preventWindowFileDrop);
  window.removeEventListener("drop", preventWindowFileDrop);
  unlistenProcessLog?.();
});

watch(
  [() => sourcePreview.value?.datasetId ?? "", sourceFilePath, selectedSheetName, selectedRuleId],
  async ([datasetId, filePath, sheetName, ruleId], _previous, onCleanup) => {
    if ((!datasetId && !filePath) || !sheetName || !ruleId) {
      selectedSheetData.value = null;
      return;
    }

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    try {
      const sheetData = datasetId
        ? await readSpreadsheetSheetHeader(datasetId, sheetName)
        : await readSpreadsheetSheetHeaderFromPath(filePath, sheetName);
      if (!cancelled) {
        selectedSheetData.value = sheetData;
      }
    } catch (error) {
      if (!cancelled) {
        selectedSheetData.value = null;
        loadError.value = `${t("workspace.messages.loadFailed")} ${toErrorMessage(error)}`.trim();
        appendProcessLog(loadError.value, "error");
      }
    }
  },
  { immediate: true },
);

watch(
  [selectedRuleSignature, sheetHeaderSignature, mappingSignature],
  ([ruleSignature, headerSignature], _previous, onCleanup) => {
    if (!ruleSignature || !headerSignature || !selectedRule.value || !selectedSheetPreview.value) {
      isCheckingCompatibility.value = false;
      resetCompatibilityResult();
      return;
    }

    const cacheKey = buildCompatibilityCacheKey();
    const cached = compatibilityCache.get(cacheKey);
    if (cached) {
      isCheckingCompatibility.value = false;
      compatibilityResult.value = cached;
      return;
    }

    isCheckingCompatibility.value = true;
    const timeoutId = window.setTimeout(() => {
      const nextResult = validateRuleCompatibility(
        selectedRule.value!,
        selectedSheetPreview.value!.headers,
        mappingGroups.value,
      );
      compatibilityCache.set(cacheKey, nextResult);
      compatibilityResult.value = nextResult;
      isCheckingCompatibility.value = false;
    }, 80);

    onCleanup(() => {
      window.clearTimeout(timeoutId);
    });
  },
  { immediate: true },
);
</script>

<template>
  <section class="workspace">
    <article class="surface surface-upload">
      <input ref="sourceFileInputRef" type="file" :accept="allowedImportAccept" class="hidden-file"
        @change="handleSourceFileChange" />
      <div class="dropzone" :class="{ 'is-dragover': isDragOver }" :aria-disabled="isParsingSource" role="button"
        tabindex="0" @click="openSourceFilePicker" @keydown="handleDropzoneKeydown" @dragenter="handleDragEnter"
        @dragover="handleDragOver" @dragleave="handleDragLeave" @drop="handleDrop">
        <span class="dropzone-title">{{ $t("workspace.importFile") }}</span>
        <span class="dropzone-description">{{ $t("workspace.messages.dropHint", { formats: allowedImportDisplay })
          }}</span>
        <button type="button" class="dropzone-action" :disabled="isParsingSource" @click.stop="openSourceFilePicker">
          {{ isParsingSource ? $t("workspace.messages.parsing") : $t("workspace.chooseExcel") }}
        </button>
      </div>

    </article>

    <article v-if="sourceFileName || sourcePreview" class="surface source-summary">
      <div class="inline-field-row import-row">
        <div class="inline-field-copy">
          <h3>{{ $t("workspace.messages.importSummary") }}</h3>
          <p class="import-file-name">{{ sourceFileName }}</p>
        </div>
        <div v-if="sourcePreview" class="inline-field-control import-control">
          <span class="summary-label">{{ $t("workspace.messages.sheet") }}</span>
          <div class="summary-select-wrap">
            <select v-model="selectedSheetName">
              <option v-for="sheet in sourcePreview.sheets" :key="sheet.name" :value="sheet.name">
                {{ sheet.name }}
              </option>
            </select>
          </div>
        </div>
        <div v-else class="inline-field-control import-control" />
      </div>
    </article>

    <article class="surface">
      <div class="inline-field-row">
        <div class="inline-field-copy">
          <h3>{{ $t("workspace.messages.ruleSelection") }}</h3>
          <p class="inline-field-hint">
            {{
              selectedRule
                ? selectedRule.name || $t("rules.library.unnamed")
                : $t("workspace.messages.selectRule")
            }}
          </p>
        </div>
        <div class="inline-field-control">
          <select v-model="selectedRuleId" :disabled="!isRuleStoreReady">
            <option value="">{{ $t("workspace.messages.selectRule") }}</option>
            <option v-for="rule in rules" :key="rule.id" :value="rule.id">{{ rule.name || $t("rules.library.unnamed") }}
            </option>
          </select>
        </div>
      </div>
      <p v-if="selectedRule" class="hint">
        {{ $t("workspace.messages.ruleMeta", { sheet: selectedRule.sourceSheetName || "-" }) }}
      </p>
    </article>

    <article class="surface run-zone">
      <div class="run-row">
        <div>
          <h3>{{ $t("workspace.taskRunner") }}</h3>
          <p class="hint">
            {{ canStart ? $t("workspace.messages.validationPassed") : $t("workspace.messages.validationRequired") }}
          </p>
        </div>
        <button type="button" class="primary" :disabled="!canStart" @click="handleStartProcess">
          {{ isProcessing ? $t("workspace.messages.processing") : $t("workspace.startProcess") }}
        </button>
      </div>

      <p v-if="loadError" class="error">{{ loadError }}</p>
      <p v-else-if="isCheckingCompatibility" class="hint">
        {{ $t("workspace.messages.validationChecking") }}
      </p>
      <ul v-else-if="compatibilityResult.errors.length > 0" class="error-list">
        <li v-for="error in compatibilityResult.errors" :key="error">{{ error }}</li>
      </ul>
      <p v-else-if="selectedRule && selectedSheetPreview" class="ok-text">
        {{ $t("workspace.messages.compatible") }}
      </p>
      <p v-if="runMessage" class="ok-text">{{ runMessage }}</p>
    </article>

    <article class="surface log-zone">
      <h3>{{ $t("workspace.processingLog") }}</h3>
      <ul ref="processLogListRef" class="log-list">
        <li v-if="displayProcessLogs.length === 0" class="log-empty">
          {{ $t("workspace.messages.logEmpty") }}
        </li>
        <li v-for="log in displayProcessLogs" :key="log.id" class="log-item" :class="`log-${log.level}`">
          <span class="log-time">{{ log.time }}</span>
          <span class="log-message">{{ log.message }}</span>
        </li>
      </ul>
    </article>

    <article class="surface result-zone">
      <h3>{{ $t("workspace.outputPreview") }}</h3>
      <p class="hint">{{ $t("workspace.messages.dynamicSheetHint") }}</p>
      <ul>
        <li v-if="dynamicSheetPreview.length === 0">{{ $t("workspace.messages.noPreview") }}</li>
        <li v-for="sheetName in dynamicSheetPreview" :key="sheetName">{{ sheetName }}</li>
      </ul>
    </article>
  </section>
</template>

<style scoped>
.workspace {
  --field-control-width: 360px;
  display: grid;
  gap: 10px;
}

.surface {
  border: 1px solid var(--stroke-soft);
  border-radius: 12px;
  background: var(--bg-card);
  padding: 12px;
  display: grid;
  gap: 8px;
}

.surface-upload {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
}

.surface h3 {
  margin: 0;
  color: var(--text-main);
  font-size: var(--fs-sm);
}

.inline-field-row {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.inline-field-copy {
  display: grid;
  gap: 4px;
}

.inline-field-hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.inline-field-control {
  min-width: 0;
  width: min(var(--field-control-width), 100%);
  justify-self: end;
  display: flex;
  justify-content: flex-end;
}

.inline-field-control select {
  /* width: 100%; */
}

.dropzone {
  width: 100%;
  min-height: 154px;
  border: 1px dashed var(--stroke-soft);
  border-radius: 16px;
  background: var(--bg-card);
  color: var(--text-main);
  padding: 20px 16px;
  display: grid;
  place-items: center;
  gap: 10px;
  text-align: center;
  cursor: pointer;
  transition: border-color 160ms ease, background-color 160ms ease;
}

.dropzone:hover:not(:disabled),
.dropzone.is-dragover {
  background: var(--bg-card);
  border-color: var(--accent);
}

.dropzone[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.72;
}

.dropzone-title {
  font-size: var(--fs-2xl);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.dropzone-description {
  color: var(--text-muted);
  font-size: var(--fs-lg);
}

.dropzone-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 136px;
  min-height: 48px;
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  background: var(--bg-input);
  color: var(--text-main);
  font-size: var(--fs-lg);
  font-weight: 600;
  padding: 0 18px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hidden-file {
  display: none;
}

.hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.source-summary {
  gap: 0;
}

.summary-label {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.summary-select-wrap {
  width: 100%;
}

.summary-select-wrap select {
  width: 100%;
}

.import-row {
  align-items: start;
}

.import-file-name {
  margin: 0;
  color: var(--text-main);
  font-size: var(--fs-sm);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.import-control {
  width: min(var(--field-control-width), 100%);
  justify-self: end;
  display: grid;
  gap: 6px;
  justify-items: stretch;
  text-align: left;
}

.select-wrap {
  display: grid;
  gap: 6px;
  min-width: 260px;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

input,
select,
button {
  border-radius: 8px;
  border: 1px solid var(--stroke-soft);
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 8px 10px;
}

button {
  cursor: pointer;
}

button:hover:not(:disabled) {
  background: var(--bg-strong);
  border-color: var(--btn-border);
}

button:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}

.run-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #ffffff;
  font-weight: 600;
}

.primary:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent);
  filter: brightness(1.08);
}

.error {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-caption);
}

.error-list {
  margin: 0;
  padding-left: 0;
  color: var(--danger);
  font-size: var(--fs-caption);
  display: grid;
  gap: 4px;
}

.error-list li {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 35%, var(--stroke-soft));
}

.ok-text {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}

li {
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: var(--fs-caption);
  color: var(--text-main);
  background: var(--bg-input);
}

.log-list {
  max-height: 180px;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.log-list::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.log-list>li {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
}

.log-item {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--stroke-soft);
}

.log-item:last-child {
  border-bottom: none;
}

.log-time {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.log-message {
  overflow-wrap: anywhere;
}

.log-empty {
  color: var(--text-muted);
}

.log-success {
  color: var(--text-main);
}

.log-error {
  color: var(--danger);
}

@media (max-width: 700px) {
  .dropzone {
    min-height: 136px;
  }

  .dropzone-title {
    font-size: var(--fs-xl);
  }

  .dropzone-description,
  .dropzone-action {
    font-size: var(--fs-md);
  }

  .summary-select-wrap,
  .import-control {
    width: 100%;
  }

  .inline-field-row {
    grid-template-columns: minmax(0, 1fr);
    align-items: stretch;
  }

  .import-control {
    justify-items: stretch;
  }

  .inline-field-control select {
    width: 100%;
  }

  .run-row {
    flex-direction: column;
    align-items: stretch;
  }

  .select-wrap {
    min-width: 0;
    width: 100%;
  }
}
</style>
