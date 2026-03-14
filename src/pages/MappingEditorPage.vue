<script setup lang="ts">
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { useMappingStore } from "../store";
import type { MappingEntry } from "../types/mapping";

type MappingEditorPayload = {
  groupId: string | null;
};

const MAIN_WINDOW_LABEL = "main";

const appWindow = getCurrentWindow();
const route = useRoute();
const { t } = useI18n();
const {
  mappingGroups,
  isMappingStoreReady,
  getGroupById,
  updateGroupMeta,
  setGroupEntries,
} = useMappingStore();

const activeGroupId = ref("");
const groupName = ref("");
const groupDescription = ref("");
const editableRows = ref<MappingEntry[]>([]);
const errorMessage = ref("");
const successMessage = ref("");

let unlistenSetGroup: UnlistenFn | undefined;

function resolveGroupIdFromQuery(): string | null {
  const queryGroupId = route.query.groupId;
  if (typeof queryGroupId !== "string") {
    return null;
  }
  const normalized = queryGroupId.trim();
  return normalized || null;
}

function hydrateFromGroup(groupId: string): void {
  const group = getGroupById(groupId);
  if (!group) {
    errorMessage.value = t("mapping.editor.errors.groupNotFound");
    return;
  }

  activeGroupId.value = group.id;
  groupName.value = group.name;
  groupDescription.value = group.description;
  editableRows.value = group.entries.map((row) => ({ source: row.source, target: row.target }));
  errorMessage.value = "";
  successMessage.value = "";
}

function resolveAndHydrateTargetGroup(groupId: string | null): void {
  if (groupId) {
    hydrateFromGroup(groupId);
    return;
  }

  const fallback = mappingGroups.value[0];
  if (!fallback) {
    errorMessage.value = t("mapping.panel.noData");
    return;
  }
  hydrateFromGroup(fallback.id);
}

function addRow(): void {
  editableRows.value.push({ source: "", target: "" });
}

function removeRow(index: number): void {
  editableRows.value.splice(index, 1);
}

function normalizeRows(): MappingEntry[] {
  const normalized: MappingEntry[] = [];

  for (let index = 0; index < editableRows.value.length; index += 1) {
    const row = editableRows.value[index];
    const source = row.source.trim();
    const target = row.target.trim();
    if (!source && !target) {
      continue;
    }
    if (!source || !target) {
      throw new Error(
        t("mapping.editor.errors.rowIncomplete", {
          index: index + 1,
        }),
      );
    }
    normalized.push({ source, target });
  }

  return normalized;
}

async function saveChanges(shouldClose = false): Promise<void> {
  if (!isMappingStoreReady.value || !activeGroupId.value) {
    return;
  }

  errorMessage.value = "";
  successMessage.value = "";

  const trimmedName = groupName.value.trim();
  if (!trimmedName) {
    errorMessage.value = t("mapping.editor.errors.groupNameRequired");
    return;
  }

  try {
    const rows = normalizeRows();
    await updateGroupMeta(activeGroupId.value, {
      name: trimmedName,
      description: groupDescription.value.trim(),
    });
    await setGroupEntries(activeGroupId.value, rows);
    await emitTo(MAIN_WINDOW_LABEL, "mapping-data-updated", {
      groupId: activeGroupId.value,
    });
    successMessage.value = t("mapping.editor.saved");

    if (shouldClose) {
      await closeWindow();
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : t("mapping.errors.unknown");
  }
}

async function closeWindow(): Promise<void> {
  errorMessage.value = "";
  try {
    await appWindow.close();
  } catch (closeError) {
    try {
      await appWindow.destroy();
    } catch (destroyError) {
      const reason = destroyError instanceof Error ? destroyError.message : String(destroyError ?? "");
      errorMessage.value = t("mapping.editor.errors.closeFailed", { reason });
      if (closeError instanceof Error && closeError.message.trim()) {
        errorMessage.value = `${errorMessage.value} (${closeError.message})`;
      }
    }
  }
}

watch(
  () => isMappingStoreReady.value,
  (isReady) => {
    if (!isReady) {
      return;
    }
    resolveAndHydrateTargetGroup(resolveGroupIdFromQuery());
  },
  { immediate: true },
);

void listen<MappingEditorPayload>("mapping-editor:set-group", (event) => {
  resolveAndHydrateTargetGroup(event.payload.groupId);
}).then((unlisten) => {
  unlistenSetGroup = unlisten;
});

appWindow.onCloseRequested(() => {
  unlistenSetGroup?.();
});
</script>

<template>
  <main class="editor-page">
    <header class="editor-header">
      <h1>{{ $t("mapping.editor.title") }}</h1>
      <button type="button" class="secondary-btn" @click="closeWindow">
        {{ $t("mapping.editor.close") }}
      </button>
    </header>

    <section class="editor-body">
      <div class="group-meta-grid">
        <label class="meta-field">
          <span>{{ $t("mapping.editor.groupName") }}</span>
          <input v-model="groupName" type="text" :disabled="!isMappingStoreReady" />
        </label>
        <label class="meta-field">
          <span>{{ $t("mapping.editor.groupDescription") }}</span>
          <input v-model="groupDescription" type="text" :disabled="!isMappingStoreReady" />
        </label>
      </div>

      <table class="editor-table">
        <thead>
          <tr>
            <th>{{ $t("mapping.editor.sourceColumn") }}</th>
            <th>{{ $t("mapping.editor.targetColumn") }}</th>
            <th class="operation-col">{{ $t("mapping.editor.operationColumn") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="editableRows.length === 0">
            <td colspan="3" class="empty-cell">
              {{ $t("mapping.editor.emptyState") }}
            </td>
          </tr>
          <tr v-for="(row, index) in editableRows" :key="`${activeGroupId}-${index}`">
            <td>
              <input v-model="row.source" type="text" />
            </td>
            <td>
              <input v-model="row.target" type="text" />
            </td>
            <td class="operation-col">
              <button type="button" class="secondary-btn danger-btn" @click="removeRow(index)">
                {{ $t("mapping.editor.removeRow") }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="errorMessage" class="status-text error-text">{{ errorMessage }}</p>
      <p v-if="successMessage" class="status-text success-text">{{ successMessage }}</p>
    </section>

    <footer class="editor-footer">
      <button type="button" class="secondary-btn" :disabled="!isMappingStoreReady" @click="addRow">
        {{ $t("mapping.editor.addRow") }}
      </button>
      <button type="button" class="secondary-btn" :disabled="!isMappingStoreReady || !activeGroupId" @click="resolveAndHydrateTargetGroup(activeGroupId)">
        {{ $t("mapping.editor.reset") }}
      </button>
      <button type="button" class="secondary-btn" :disabled="!isMappingStoreReady || !activeGroupId" @click="saveChanges()">
        {{ $t("mapping.editor.save") }}
      </button>
      <button type="button" class="secondary-btn" :disabled="!isMappingStoreReady || !activeGroupId" @click="saveChanges(true)">
        {{ $t("mapping.editor.saveAndClose") }}
      </button>
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
  padding: 16px;
  display: grid;
  gap: 12px;
  grid-template-rows: auto 1fr auto;
  overflow: hidden;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.editor-header h1 {
  margin: 0;
  font-size: var(--fs-xl);
}

.editor-body {
  border: 1px solid var(--stroke-soft);
  border-radius: 12px;
  background: var(--bg-card);
  padding: 10px;
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  display: grid;
  gap: 10px;
  align-content: start;
}

.editor-body::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.group-meta-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.meta-field {
  display: grid;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.editor-table {
  width: 100%;
  border-collapse: collapse;
}

.editor-table th,
.editor-table td {
  border-bottom: 1px solid var(--stroke-soft);
  padding: 8px;
  text-align: left;
  vertical-align: middle;
}

.editor-table th {
  font-size: var(--fs-sm);
  color: var(--text-muted);
  font-weight: 600;
}

.editor-table input,
.meta-field input {
  width: 100%;
  border-radius: 8px;
  border: 1px solid var(--stroke-soft);
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 7px 9px;
}

.operation-col {
  width: 140px;
}

.empty-cell {
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-sm);
  padding: 24px 0;
}

.status-text {
  margin: 0;
  font-size: var(--fs-sm);
}

.error-text {
  color: var(--danger);
}

.success-text {
  color: var(--text-muted);
}

.editor-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.secondary-btn {
  border: 1px solid var(--btn-border);
  border-radius: 8px;
  background: var(--btn-bg);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1;
  padding: 9px 12px;
  cursor: pointer;
}

.secondary-btn:hover:not(:disabled) {
  background: var(--btn-bg-hover);
}

.secondary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.danger-btn {
  border-color: var(--stroke-soft);
}

@media (max-width: 760px) {
  .group-meta-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
