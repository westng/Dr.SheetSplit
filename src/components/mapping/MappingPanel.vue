<script setup lang="ts">
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useMappingStore } from "../../store";
import {
  basenameFromPath,
  chooseJsonOpenPath,
  chooseJsonSavePath,
  readTextFromPath,
  writeTextToPath,
} from "../../utils/nativeFile";
import {
  MappingParserError,
  type MappingParserErrorCode,
  parseMappingFile,
} from "../../utils/mappingParser";

const { t } = useI18n();
const {
  mappingGroups,
  isMappingStoreReady,
  createGroup,
  setGroupEntries,
  clearGroupEntries,
  deleteGroup,
  replaceGroupsByImport,
  reloadFromDisk,
} = useMappingStore();

const groupInputs: Record<string, HTMLInputElement | null> = reactive({});
const groupUploading: Record<string, boolean> = reactive({});
const groupErrors: Record<string, string> = reactive({});
const actionMessage = ref("");
const createDialogVisible = ref(false);
const createGroupName = ref("");
const createGroupDescription = ref("");
const createGroupError = ref("");
const isCreatingGroup = ref(false);

const groups = computed(() => mappingGroups.value);

const EDITOR_WINDOW_LABEL = "mapping-editor";
let unlistenMappingUpdated: UnlistenFn | undefined;

function setInputRef(groupId: string, element: HTMLInputElement | null): void {
  groupInputs[groupId] = element;
}

function openFilePicker(groupId: string): void {
  groupInputs[groupId]?.click();
}

function getParserErrorMessage(errorCode: MappingParserErrorCode): string {
  return t(`mapping.errors.${errorCode}`);
}

function toSafeFilename(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

async function handleFileChange(groupId: string, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }

  groupUploading[groupId] = true;
  groupErrors[groupId] = "";
  actionMessage.value = "";

  try {
    const entries = await parseMappingFile(file);
    await setGroupEntries(groupId, entries, file.name);
  } catch (error) {
    if (error instanceof MappingParserError) {
      groupErrors[groupId] = getParserErrorMessage(error.code);
    } else {
      groupErrors[groupId] = t("mapping.errors.unknown");
    }
  } finally {
    groupUploading[groupId] = false;
    input.value = "";
  }
}

async function clearGroup(groupId: string): Promise<void> {
  actionMessage.value = "";
  await clearGroupEntries(groupId);
  groupErrors[groupId] = "";
}

async function removeGroup(groupId: string): Promise<void> {
  const target = groups.value.find((item) => item.id === groupId);
  if (!target) {
    return;
  }

  const confirmed = await confirm(
    t("mapping.panel.deleteConfirm", {
      name: target.name,
    }),
  );
  if (!confirmed) {
    return;
  }

  try {
    await deleteGroup(groupId);
    delete groupErrors[groupId];
    delete groupUploading[groupId];
    delete groupInputs[groupId];
    actionMessage.value = t("mapping.panel.deleteSuccess", {
      name: target.name,
    });
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : t("mapping.panel.deleteFailed");
  }
}

function downloadTemplate(groupName: string): void {
  const sourceHeader = t("mapping.templateHeaders.source");
  const targetHeader = t("mapping.templateHeaders.target");
  const csvContent = `${sourceHeader},${targetHeader}\n`;
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const safeName = toSafeFilename(groupName) || "mapping";
  link.href = objectUrl;
  link.download = `${safeName}-template.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

async function exportGroup(groupId: string): Promise<void> {
  const group = groups.value.find((item) => item.id === groupId);
  if (!group) {
    return;
  }

  try {
    const safeName = toSafeFilename(group.name) || group.id;
    const selectedPath = await chooseJsonSavePath(
      t("mapping.panel.exportSingleSelectTitle"),
      `${safeName}.json`,
    );
    if (!selectedPath) {
      return;
    }

    const payload = JSON.stringify(group, null, 2);
    await writeTextToPath(selectedPath, payload);
    actionMessage.value = t("mapping.panel.exportSingleSuccess", { name: group.name });
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : t("mapping.panel.exportFailed");
  }
}

async function importMappings(): Promise<void> {
  try {
    const selectedPath = await chooseJsonOpenPath(t("mapping.panel.importSelectTitle"));
    if (!selectedPath) {
      return;
    }

    const confirmed = await confirm(
      t("mapping.panel.importConfirm", {
        file: basenameFromPath(selectedPath),
      }),
    );
    if (!confirmed) {
      return;
    }

    const fileText = await readTextFromPath(selectedPath);
    const payload = JSON.parse(fileText) as unknown;
    const importedCount = await replaceGroupsByImport(payload);
    actionMessage.value = t("mapping.panel.importSuccess", { count: importedCount });
  } catch (error) {
    if (error instanceof SyntaxError) {
      actionMessage.value = t("mapping.panel.importInvalidJson");
      return;
    }
    actionMessage.value = error instanceof Error ? error.message : t("mapping.panel.importFailed");
  }
}

async function exportAllMappings(): Promise<void> {
  try {
    const dateSuffix = new Date().toISOString().slice(0, 10);
    const selectedPath = await chooseJsonSavePath(
      t("mapping.panel.exportAllSelectTitle"),
      `dr-sheetsplit-mappings-${dateSuffix}.json`,
    );
    if (!selectedPath) {
      return;
    }

    const payload = JSON.stringify(groups.value, null, 2);
    await writeTextToPath(selectedPath, payload);
    actionMessage.value = t("mapping.panel.exportSuccess");
  } catch (error) {
    actionMessage.value = error instanceof Error ? error.message : t("mapping.panel.exportFailed");
  }
}

function sanitizeCreateGroupName(inputName: string): string {
  return inputName.trim().replace(/\s+/g, " ");
}

function sanitizeCreateGroupDescription(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function openCreateGroupDialog(): void {
  createDialogVisible.value = true;
  createGroupName.value = "";
  createGroupDescription.value = "";
  createGroupError.value = "";
}

function closeCreateGroupDialog(): void {
  if (isCreatingGroup.value) {
    return;
  }
  createDialogVisible.value = false;
  createGroupError.value = "";
}

function validateCreateGroup(): string | null {
  const normalizedName = sanitizeCreateGroupName(createGroupName.value);
  if (!normalizedName) {
    return t("mapping.panel.createRequired");
  }

  const duplicated = groups.value.some(
    (item) => item.name.trim().toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
  );
  if (duplicated) {
    return t("mapping.panel.createDuplicate", { name: normalizedName });
  }

  return null;
}

async function submitCreateGroup(): Promise<void> {
  const validationError = validateCreateGroup();
  if (validationError) {
    createGroupError.value = validationError;
    return;
  }

  isCreatingGroup.value = true;
  createGroupError.value = "";
  try {
    const created = await createGroup(
      sanitizeCreateGroupName(createGroupName.value),
      sanitizeCreateGroupDescription(createGroupDescription.value),
    );
    createDialogVisible.value = false;
    actionMessage.value = "";
    await openGroupEditor(created.id);
  } catch (error) {
    createGroupError.value = error instanceof Error ? error.message : t("mapping.panel.createFailed");
  } finally {
    isCreatingGroup.value = false;
  }
}

async function openGroupEditor(groupId: string): Promise<void> {
  actionMessage.value = "";
  groupErrors[groupId] = "";
  const windowUrl = `/#/mapping-editor?groupId=${encodeURIComponent(groupId)}`;

  try {
    const existingWindow = await WebviewWindow.getByLabel(EDITOR_WINDOW_LABEL);
    if (existingWindow) {
      await emitTo(EDITOR_WINDOW_LABEL, "mapping-editor:set-group", { groupId });
      await existingWindow.setFocus();
      return;
    }

    const editorWindow = new WebviewWindow(EDITOR_WINDOW_LABEL, {
      url: windowUrl,
      title: t("mapping.editor.windowTitle"),
      width: 980,
      height: 680,
      minWidth: 860,
      minHeight: 520,
      resizable: true,
      center: true,
    });

    void editorWindow.once("tauri://error", (event) => {
      const reason = event.payload instanceof Error ? event.payload.message : String(event.payload ?? "");
      groupErrors[groupId] = t("mapping.errors.editorOpenFailed", { reason });
    });
    void editorWindow.once("tauri://created", () => {
      void emitTo(EDITOR_WINDOW_LABEL, "mapping-editor:set-group", { groupId });
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    groupErrors[groupId] = t("mapping.errors.editorOpenFailed", { reason });
  }
}

onMounted(async () => {
  unlistenMappingUpdated = await listen("mapping-data-updated", () => {
    void reloadFromDisk();
  });
});

onUnmounted(() => {
  unlistenMappingUpdated?.();
});
</script>

<template>
  <section class="mapping-panel">
    <div class="mapping-toolbar">
      <button
        type="button"
        class="mapping-action-card create-card"
        :disabled="!isMappingStoreReady"
        @click="openCreateGroupDialog"
      >
        <span class="mapping-action-title">{{ $t("mapping.actions.create") }}</span>
        <span class="mapping-action-description">{{ $t("mapping.panel.createHint") }}</span>
      </button>

      <button type="button" class="mapping-action-card" :disabled="!isMappingStoreReady" @click="importMappings">
        <span class="mapping-action-title">{{ $t("mapping.actions.importAll") }}</span>
        <span class="mapping-action-description">{{ $t("mapping.panel.importHint") }}</span>
      </button>

      <button type="button" class="mapping-action-card" :disabled="!isMappingStoreReady" @click="exportAllMappings">
        <span class="mapping-action-title">{{ $t("mapping.actions.exportAll") }}</span>
        <span class="mapping-action-description">{{ $t("mapping.panel.exportHint") }}</span>
      </button>
    </div>

    <p v-if="actionMessage" class="mapping-message">{{ actionMessage }}</p>
    <p v-else-if="!isMappingStoreReady" class="mapping-message">{{ $t("mapping.loading") }}</p>

    <div
      v-if="createDialogVisible"
      class="create-group-overlay"
      @click.self="closeCreateGroupDialog"
    >
      <div class="create-group-dialog">
        <h4>{{ $t("mapping.panel.createDialogTitle") }}</h4>
        <label class="create-group-field">
          <span>{{ $t("mapping.panel.createNameLabel") }}</span>
          <input
            v-model="createGroupName"
            type="text"
            :placeholder="$t('mapping.panel.createNamePlaceholder')"
            :disabled="isCreatingGroup"
            @keydown.enter.prevent="submitCreateGroup"
          />
        </label>
        <label class="create-group-field">
          <span>{{ $t("mapping.panel.createDescriptionLabel") }}</span>
          <input
            v-model="createGroupDescription"
            type="text"
            :placeholder="$t('mapping.panel.createDescriptionPlaceholder')"
            :disabled="isCreatingGroup"
            @keydown.enter.prevent="submitCreateGroup"
          />
        </label>
        <p v-if="createGroupError" class="create-group-error">{{ createGroupError }}</p>
        <div class="create-group-actions">
          <button type="button" class="dialog-action-btn" :disabled="isCreatingGroup" @click="closeCreateGroupDialog">
            {{ $t("mapping.actions.cancel") }}
          </button>
          <button type="button" class="dialog-action-btn primary" :disabled="isCreatingGroup" @click="submitCreateGroup">
            {{ isCreatingGroup ? $t("mapping.actions.creating") : $t("mapping.actions.confirmCreate") }}
          </button>
        </div>
      </div>
    </div>

    <div class="mapping-list-shell">
      <div class="mapping-list-head">
        <h3>{{ $t("mapping.panel.title") }}</h3>
      </div>

      <p v-if="groups.length === 0" class="mapping-empty">
        {{ $t("mapping.panel.noData") }}
      </p>

      <ul v-else class="mapping-list">
        <li v-for="group in groups" :key="group.id" class="mapping-row">
          <input
            :ref="(element) => setInputRef(group.id, element as HTMLInputElement | null)"
            type="file"
            class="mapping-file-input"
            accept=".json,.csv,.xlsx,.xls"
            @change="handleFileChange(group.id, $event)"
          />

          <button type="button" class="mapping-row-main" :disabled="!isMappingStoreReady" @click="openGroupEditor(group.id)">
            <span class="mapping-row-title">{{ group.name }}</span>
            <span class="mapping-row-meta">{{ group.description || $t("mapping.panel.noDescription") }}</span>
            <span class="mapping-row-submeta">
              {{ $t("mapping.panel.rowCountCompact", { count: group.entries.length }) }}
              <template v-if="group.lastImportedFileName">
                · {{ $t("mapping.panel.fileMeta", { file: group.lastImportedFileName }) }}
              </template>
            </span>
          </button>

          <div class="mapping-row-actions">
            <button
              type="button"
              class="action-link"
              :disabled="groupUploading[group.id] || !isMappingStoreReady"
              @click="openFilePicker(group.id)"
            >
              {{
                groupUploading[group.id]
                  ? $t("mapping.actions.uploading")
                  : group.entries.length > 0
                    ? $t("mapping.actions.replace")
                    : $t("mapping.actions.upload")
              }}
            </button>
            <button
              type="button"
              class="action-link"
              :disabled="!isMappingStoreReady"
              @click="openGroupEditor(group.id)"
            >
              {{ $t("mapping.actions.edit") }}
            </button>
            <button type="button" class="action-link" :disabled="!isMappingStoreReady" @click="downloadTemplate(group.name)">
              {{ $t("mapping.actions.downloadTemplate") }}
            </button>
            <button type="button" class="action-link" :disabled="!isMappingStoreReady" @click="exportGroup(group.id)">
              {{ $t("mapping.actions.export") }}
            </button>
            <button
              type="button"
              class="action-link danger"
              :disabled="group.entries.length === 0 || groupUploading[group.id] || !isMappingStoreReady"
              @click="clearGroup(group.id)"
            >
              {{ $t("mapping.actions.clear") }}
            </button>
            <button
              type="button"
              class="action-link danger"
              :disabled="groupUploading[group.id] || !isMappingStoreReady"
              @click="removeGroup(group.id)"
            >
              {{ $t("mapping.actions.delete") }}
            </button>
          </div>

          <p v-if="groupErrors[group.id]" class="mapping-error">{{ groupErrors[group.id] }}</p>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.mapping-panel {
  position: relative;
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: 12px;
}

.mapping-toolbar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.mapping-action-card {
  width: 100%;
  min-height: 88px;
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  background: var(--bg-card);
  color: var(--text-main);
  padding: 14px 18px;
  display: grid;
  gap: 6px;
  align-content: center;
  text-align: left;
  cursor: pointer;
  transition: border-color 160ms ease, background-color 160ms ease;
}

.mapping-action-card:hover:not(:disabled) {
  background: var(--bg-input);
  border-color: var(--accent);
}

.mapping-action-card:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.create-card {
  border-style: dashed;
}

.mapping-action-title {
  font-size: var(--fs-md);
  font-weight: 600;
}

.mapping-action-description {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.mapping-message {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.create-group-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.36);
}

.create-group-dialog {
  width: min(560px, 100%);
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--stroke-soft);
  border-radius: 12px;
  background: var(--bg-main);
}

.create-group-dialog h4 {
  margin: 0;
  color: var(--text-main);
  font-size: var(--fs-lg);
  font-weight: 600;
}

.create-group-field {
  display: grid;
  gap: 8px;
}

.create-group-field span {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.create-group-field input {
  height: 38px;
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: var(--bg-card);
  color: var(--text-main);
  padding: 0 12px;
  font: inherit;
  font-size: var(--fs-sm);
}

.create-group-field input:focus {
  outline: none;
  border-color: var(--accent);
}

.create-group-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-caption);
}

.create-group-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
}

.dialog-action-btn {
  min-width: 84px;
  height: 34px;
  border: 1px solid var(--stroke-soft);
  border-radius: 9px;
  background: var(--bg-card);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-caption);
  cursor: pointer;
}

.dialog-action-btn.primary {
  border-color: var(--accent);
  background: var(--bg-input);
}

.dialog-action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.mapping-list-shell {
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 10px;
}

.mapping-list-head h3 {
  margin: 0;
  color: var(--text-main);
  font-size: var(--fs-lg);
  font-weight: 600;
}

.mapping-empty {
  margin: 0;
  border: 1px dashed var(--stroke-soft);
  border-radius: 12px;
  padding: 12px;
  color: var(--text-muted);
  font-size: var(--fs-caption);
  text-align: center;
}

.mapping-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  align-content: start;
  grid-auto-rows: max-content;
  gap: 8px;
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.mapping-list::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.mapping-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  min-height: 72px;
  padding: 10px 14px;
  border: 1px solid var(--stroke-soft);
  border-radius: 12px;
  background: var(--bg-card);
}

.mapping-file-input {
  display: none;
}

.mapping-row-main {
  border: none;
  background: transparent;
  padding: 0;
  display: grid;
  gap: 4px;
  text-align: left;
  cursor: pointer;
}

.mapping-row-title {
  color: var(--text-main);
  font-size: var(--fs-md);
  font-weight: 600;
}

.mapping-row-meta,
.mapping-row-submeta {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.mapping-row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.action-link {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--fs-caption);
  line-height: 1;
  padding: 0;
  cursor: pointer;
}

.action-link:hover:not(:disabled) {
  color: var(--text-main);
}

.action-link.danger:hover:not(:disabled) {
  color: var(--danger);
}

.action-link:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}

.mapping-error {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-caption);
}

@media (max-width: 880px) {
  .mapping-toolbar {
    grid-template-columns: minmax(0, 1fr);
  }

  .mapping-row {
    grid-template-columns: minmax(0, 1fr);
  }

  .mapping-row-actions {
    justify-content: flex-start;
  }

  .create-group-overlay {
    padding: 12px;
  }
}
</style>
