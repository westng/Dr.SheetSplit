<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TaskHistoryDetail } from "../../types/history";
import { useHistoryStore } from "../../store";

const props = defineProps<{
  historyId: string;
}>();

const emit = defineEmits<{
  back: [];
}>();

const { t } = useI18n();
const { getHistoryDetail } = useHistoryStore();

const isLoading = ref(false);
const loadError = ref("");
const detail = ref<TaskHistoryDetail | null>(null);
const activeResultSheetName = ref("");

const detailStatusLabel = computed(() => {
  if (!detail.value) {
    return "";
  }
  return detail.value.status === "success" ? t("history.status.success") : t("history.status.failed");
});

const sheetSummaries = computed(() => {
  if (!detail.value?.resultPayload?.engineOutput?.sheets) {
    return [] as Array<{ name: string; rows: number }>;
  }
  return detail.value.resultPayload.engineOutput.sheets.map((sheet) => ({
    name: sheet.name,
    rows: sheet.rows.length,
  }));
});
const resultSheets = computed(() => detail.value?.resultPayload?.engineOutput?.sheets ?? []);
const activeResultSheet = computed(() => {
  if (resultSheets.value.length === 0) {
    return null;
  }
  if (!activeResultSheetName.value) {
    return resultSheets.value[0];
  }
  return resultSheets.value.find((sheet) => sheet.name === activeResultSheetName.value) ?? resultSheets.value[0];
});

function formatDateTime(timestampMs: number): string {
  if (!timestampMs) {
    return "-";
  }
  const date = new Date(timestampMs);
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  const ss = `${date.getSeconds()}`.padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formatDuration(durationMs: number): string {
  const normalized = Math.max(0, Math.floor(durationMs));
  if (normalized < 1000) {
    return `${normalized}ms`;
  }
  return `${(normalized / 1000).toFixed(2)}s`;
}

function selectResultSheet(sheetName: string): void {
  activeResultSheetName.value = sheetName;
}

async function loadDetail(historyId: string): Promise<void> {
  if (!historyId) {
    detail.value = null;
    loadError.value = "";
    return;
  }

  isLoading.value = true;
  loadError.value = "";
  activeResultSheetName.value = "";
  try {
    const next = await getHistoryDetail(historyId);
    if (!next) {
      detail.value = null;
      loadError.value = t("history.detail.notFound");
      return;
    }
    detail.value = next;
    activeResultSheetName.value = next.resultPayload?.engineOutput?.sheets?.[0]?.name ?? "";
  } catch (error) {
    detail.value = null;
    loadError.value = error instanceof Error ? error.message : t("history.detail.loadFailed");
  } finally {
    isLoading.value = false;
  }
}

watch(
  () => props.historyId,
  (historyId) => {
    void loadDetail(historyId);
  },
  { immediate: true },
);
</script>

<template>
  <section class="history-detail">
    <header class="history-detail-header">
      <div class="history-detail-title">
        <h3>{{ $t("history.detail.title") }}</h3>
        <p class="hint-text">{{ $t("history.detail.subtitle") }}</p>
      </div>
      <button type="button" class="secondary-btn" @click="emit('back')">
        {{ $t("history.detail.back") }}
      </button>
    </header>

    <section v-if="isLoading" class="surface">
      <p class="hint-text">{{ $t("history.detail.loading") }}</p>
    </section>

    <section v-else-if="loadError" class="surface">
      <p class="error-text">{{ loadError }}</p>
    </section>

    <template v-else-if="detail">
      <article class="surface detail-basic">
        <div class="detail-row">
          <span class="detail-label">{{ $t("history.detail.status") }}</span>
          <span class="status-tag" :class="`status-${detail.status}`">{{ detailStatusLabel }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t("history.detail.rule") }}</span>
          <span class="detail-value">{{ detail.ruleName }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t("history.detail.source") }}</span>
          <span class="detail-value">{{ detail.sourceFileName }} / {{ detail.sourceSheetName || "-" }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t("history.detail.startedAt") }}</span>
          <span class="detail-value">{{ formatDateTime(detail.startedAtMs) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t("history.detail.finishedAt") }}</span>
          <span class="detail-value">{{ formatDateTime(detail.finishedAtMs) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t("history.detail.duration") }}</span>
          <span class="detail-value">{{ formatDuration(detail.durationMs) }}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">{{ $t("history.detail.outputPath") }}</span>
          <span class="detail-value path">{{ detail.outputPath || "-" }}</span>
        </div>
        <div v-if="detail.errorMessage" class="detail-row">
          <span class="detail-label">{{ $t("history.detail.error") }}</span>
          <span class="detail-value error-text">{{ detail.errorMessage }}</span>
        </div>
      </article>

      <article class="surface">
        <h4>{{ $t("history.detail.result") }}</h4>
        <p class="hint-text">
          {{ $t("history.detail.summary", { sheets: detail.sheetCount, rows: detail.rowCount }) }}
        </p>
        <ul class="sheet-list">
          <li v-if="sheetSummaries.length === 0" class="hint-text">{{ $t("history.detail.noSheets") }}</li>
          <li v-for="sheet in sheetSummaries" :key="sheet.name" class="sheet-item">
            <span>{{ sheet.name }}</span>
            <span>{{ sheet.rows }}</span>
          </li>
        </ul>

        <div v-if="resultSheets.length > 0" class="result-tabs">
          <button
            v-for="sheet in resultSheets"
            :key="sheet.name"
            type="button"
            class="result-tab-btn"
            :class="{ active: sheet.name === activeResultSheet?.name }"
            @click="selectResultSheet(sheet.name)"
          >
            {{ sheet.name }}
          </button>
        </div>

        <div v-if="activeResultSheet" class="result-table-wrap">
          <table class="result-table">
            <thead>
              <tr>
                <th v-for="header in activeResultSheet.headers" :key="header">{{ header }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="activeResultSheet.rows.length === 0">
                <td :colspan="Math.max(1, activeResultSheet.headers.length)" class="result-empty-cell">
                  {{ $t("history.detail.noRows") }}
                </td>
              </tr>
              <tr v-for="(row, rowIndex) in activeResultSheet.rows" :key="`${activeResultSheet.name}-${rowIndex}`">
                <td v-for="(cell, cellIndex) in row" :key="`${rowIndex}-${cellIndex}`">
                  {{ cell }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="hint-text">{{ $t("history.detail.noSheets") }}</p>

      </article>

      <article class="surface">
        <h4>{{ $t("history.detail.logs") }}</h4>
        <ul class="log-list">
          <li v-if="detail.logs.length === 0" class="hint-text">{{ $t("history.detail.noLogs") }}</li>
          <li v-for="log in detail.logs" :key="log.id" class="log-item" :class="`log-${log.level}`">
            <span class="log-time">{{ log.time }}</span>
            <span class="log-message">{{ log.message }}</span>
          </li>
        </ul>
      </article>
    </template>
  </section>
</template>

<style scoped>
.history-detail {
  display: grid;
  gap: 10px;
}

.history-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.history-detail-title h3 {
  margin: 0;
  font-size: var(--fs-lg);
  color: var(--text-main);
}

.hint-text {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.surface {
  border: 1px solid var(--stroke-soft);
  border-radius: 12px;
  background: var(--bg-card);
  padding: 12px;
  display: grid;
  gap: 8px;
}

.surface h4 {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-main);
}

.result-tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.result-tabs::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.result-tab-btn {
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-caption);
  line-height: 1;
  padding: 7px 10px;
  cursor: pointer;
  white-space: nowrap;
}

.result-tab-btn.active {
  border-color: var(--accent);
  background: var(--bg-strong);
}

.result-table-wrap {
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: var(--bg-input);
  overflow: auto;
  max-height: 360px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.result-table-wrap::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.result-table {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
}

.result-table th,
.result-table td {
  border-bottom: 1px solid var(--stroke-soft);
  border-right: 1px solid var(--stroke-soft);
  padding: 6px 8px;
  font-size: var(--fs-caption);
  color: var(--text-main);
  text-align: center;
  vertical-align: middle;
  white-space: nowrap;
}

.result-table th:last-child,
.result-table td:last-child {
  border-right: none;
}

.result-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-card);
  font-weight: 700;
}

.result-empty-cell {
  color: var(--text-muted);
}

.detail-basic {
  gap: 10px;
}

.detail-row {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

.detail-label {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.detail-value {
  color: var(--text-main);
  font-size: var(--fs-sm);
  word-break: break-all;
}

.detail-value.path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: var(--fs-caption);
}

.status-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  border: 1px solid var(--stroke-soft);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: var(--fs-caption);
}

.status-tag.status-success {
  color: var(--accent);
  border-color: var(--accent);
}

.status-tag.status-failed {
  color: var(--danger);
  border-color: var(--danger);
}

.sheet-list,
.log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}

.sheet-item {
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  padding: 7px 9px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-caption);
  color: var(--text-main);
}

.log-item {
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  padding: 7px 9px;
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
}

.log-item.log-error {
  border-color: color-mix(in oklab, var(--danger) 45%, var(--stroke-soft));
}

.log-time {
  color: var(--text-muted);
  font-size: var(--fs-caption);
  line-height: 1.4;
}

.log-message {
  color: var(--text-main);
  font-size: var(--fs-caption);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.error-text {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-caption);
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

.secondary-btn:hover {
  background: var(--btn-bg-hover);
}

@media (max-width: 900px) {
  .detail-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
}
</style>
