<script setup lang="ts">
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { confirm } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useEngineRuleStore } from "../../store";
import {
  cloneEngineRuleDefinition,
  type EngineRuleDefinition,
} from "../../types/engineRule";
import EngineRuleLibrary from "./EngineRuleLibrary.vue";
import {
  basenameFromPath,
  chooseJsonOpenPath,
  chooseJsonSavePath,
  readTextFromPath,
  writeTextToPath,
} from "../../utils/nativeFile";

type EngineRuleEditorPayload = {
  ruleId: string | null;
};

const ENGINE_RULE_EDITOR_WINDOW_LABEL = "engine-rule-editor";

const { t } = useI18n();
const {
  engineRules,
  engineRuleStoreError,
  saveEngineRule,
  deleteEngineRule,
  replaceEngineRulesByImport,
  getEngineRuleById,
  reloadEngineRules,
} = useEngineRuleStore();

const activeRuleId = ref("");
const panelError = ref("");
const actionMessage = ref("");
const isOperating = ref(false);

let unlistenRuleUpdated: UnlistenFn | undefined;

const canOperate = computed(() => !isOperating.value);

function resetMessages(): void {
  panelError.value = "";
  actionMessage.value = "";
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

async function openRuleEditor(ruleId: string | null): Promise<void> {
  resetMessages();
  const windowUrl = ruleId
    ? `/#/engine-rule-editor?ruleId=${encodeURIComponent(ruleId)}`
    : "/#/engine-rule-editor";

  try {
    const existingWindow = await WebviewWindow.getByLabel(ENGINE_RULE_EDITOR_WINDOW_LABEL);
    if (existingWindow) {
      await emitTo<EngineRuleEditorPayload>(ENGINE_RULE_EDITOR_WINDOW_LABEL, "engine-rule-editor:set-rule", { ruleId });
      await existingWindow.setFocus();
      return;
    }

    const editorWindow = new WebviewWindow(ENGINE_RULE_EDITOR_WINDOW_LABEL, {
      url: windowUrl,
      title: t("engineRules.editor.windowTitle"),
      width: 1180,
      height: 800,
      minWidth: 980,
      minHeight: 680,
      resizable: true,
      center: true,
    });

    void editorWindow.once("tauri://error", (event) => {
      const reason = event.payload instanceof Error ? event.payload.message : String(event.payload ?? "");
      panelError.value = t("engineRules.messages.editorOpenFailed", { reason });
    });
    void editorWindow.once("tauri://created", () => {
      void emitTo<EngineRuleEditorPayload>(ENGINE_RULE_EDITOR_WINDOW_LABEL, "engine-rule-editor:set-rule", { ruleId });
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? "");
    panelError.value = t("engineRules.messages.editorOpenFailed", { reason });
  }
}

async function handleCreateRule(): Promise<void> {
  activeRuleId.value = "";
  await openRuleEditor(null);
}

async function handleImportRules(): Promise<void> {
  if (!canOperate.value) {
    return;
  }

  resetMessages();
  isOperating.value = true;
  try {
    const selectedPath = await chooseJsonOpenPath(t("engineRules.messages.importSelectTitle"));
    if (!selectedPath) {
      return;
    }

    const confirmed = await confirm(
      t("engineRules.messages.importConfirm", { file: basenameFromPath(selectedPath) }),
    );
    if (!confirmed) {
      return;
    }

    const fileText = await readTextFromPath(selectedPath);
    const payload = JSON.parse(fileText) as unknown;
    const importedCount = await replaceEngineRulesByImport(payload);
    activeRuleId.value = "";
    actionMessage.value = t("engineRules.messages.importSuccess", { count: importedCount });
  } catch (error) {
    if (error instanceof SyntaxError) {
      panelError.value = t("engineRules.messages.importInvalidJson");
      return;
    }
    panelError.value = error instanceof Error ? error.message : t("engineRules.messages.importFailed");
  } finally {
    isOperating.value = false;
  }
}

async function handleExportAllRules(): Promise<void> {
  if (!canOperate.value) {
    return;
  }

  resetMessages();
  isOperating.value = true;
  try {
    const dateSuffix = new Date().toISOString().slice(0, 10);
    const selectedPath = await chooseJsonSavePath(
      t("engineRules.messages.exportAllSelectTitle"),
      `dr-sheetsplit-engine-rules-${dateSuffix}.json`,
    );
    if (!selectedPath) {
      return;
    }

    const payload = JSON.stringify(engineRules.value, null, 2);
    await writeTextToPath(selectedPath, payload);
    actionMessage.value = t("engineRules.messages.exportSuccess");
  } catch (error) {
    panelError.value = error instanceof Error ? error.message : t("engineRules.messages.exportFailed");
  } finally {
    isOperating.value = false;
  }
}

async function handleSelectRule(ruleId: string): Promise<void> {
  activeRuleId.value = ruleId;
  await openRuleEditor(ruleId);
}

async function handleExportRule(ruleId: string): Promise<void> {
  if (!canOperate.value) {
    return;
  }

  resetMessages();
  isOperating.value = true;
  try {
    const targetRule = getEngineRuleById(ruleId);
    if (!targetRule) {
      panelError.value = t("engineRules.messages.saveFailed");
      return;
    }

    const ruleName = targetRule.name.trim() || t("engineRules.library.unnamed");
    const safeName = toSafeFilename(ruleName) || ruleId;
    const selectedPath = await chooseJsonSavePath(
      t("engineRules.messages.exportSingleSelectTitle"),
      `${safeName}.json`,
    );
    if (!selectedPath) {
      return;
    }

    await writeTextToPath(selectedPath, JSON.stringify(targetRule, null, 2));
    actionMessage.value = t("engineRules.messages.exportSingleSuccess", { name: ruleName });
  } catch (error) {
    panelError.value = error instanceof Error ? error.message : t("engineRules.messages.exportFailed");
  } finally {
    isOperating.value = false;
  }
}

async function handleDuplicateRule(ruleId: string): Promise<void> {
  if (!canOperate.value) {
    return;
  }

  resetMessages();
  const original = getEngineRuleById(ruleId);
  if (!original) {
    panelError.value = t("engineRules.messages.saveFailed");
    return;
  }

  isOperating.value = true;
  try {
    const now = new Date().toISOString();
    const duplicated: EngineRuleDefinition = cloneEngineRuleDefinition(original);
    duplicated.id = crypto.randomUUID();
    duplicated.name = `${original.name || t("engineRules.library.unnamed")} ${t("engineRules.messages.copySuffix")}`;
    duplicated.createdAt = now;
    duplicated.updatedAt = now;

    const saved = await saveEngineRule(duplicated);
    actionMessage.value = t("engineRules.messages.copyCreated");
    activeRuleId.value = saved.id;
    await openRuleEditor(saved.id);
  } catch {
    panelError.value = t("engineRules.messages.saveFailed");
  } finally {
    isOperating.value = false;
  }
}

async function handleDeleteRule(ruleId: string): Promise<void> {
  if (!canOperate.value) {
    return;
  }

  resetMessages();
  const targetRule = engineRules.value.find((item) => item.id === ruleId);
  const targetName = targetRule?.name || t("engineRules.library.unnamed");
  const confirmed = await confirm(t("engineRules.messages.deleteConfirm", { name: targetName }));
  if (!confirmed) {
    return;
  }

  isOperating.value = true;
  try {
    await deleteEngineRule(ruleId);
    if (activeRuleId.value === ruleId) {
      activeRuleId.value = "";
    }
    actionMessage.value = t("engineRules.messages.deleted");
  } catch {
    panelError.value = t("engineRules.messages.saveFailed");
  } finally {
    isOperating.value = false;
  }
}

onMounted(async () => {
  unlistenRuleUpdated = await listen("engine-rule-data-updated", () => {
    void reloadEngineRules();
  });
});

onUnmounted(() => {
  unlistenRuleUpdated?.();
});
</script>

<template>
  <section class="rules-index">
    <div class="rules-toolbar">
      <button type="button" class="rule-action-card create-card" :disabled="!canOperate" @click="handleCreateRule">
        <span class="rule-action-title">{{ $t("engineRules.actions.createRule") }}</span>
        <span class="rule-action-description">{{ $t("engineRules.messages.createRuleHint") }}</span>
      </button>

      <button type="button" class="rule-action-card" :disabled="!canOperate" @click="handleImportRules">
        <span class="rule-action-title">{{ $t("engineRules.actions.importAll") }}</span>
        <span class="rule-action-description">{{ $t("engineRules.messages.importHint") }}</span>
      </button>

      <button type="button" class="rule-action-card" :disabled="!canOperate" @click="handleExportAllRules">
        <span class="rule-action-title">{{ $t("engineRules.actions.exportAll") }}</span>
        <span class="rule-action-description">{{ $t("engineRules.messages.exportHint") }}</span>
      </button>
    </div>

    <p v-if="engineRuleStoreError" class="rules-message error">
      {{ $t("engineRules.messages.dbUnavailable", { reason: engineRuleStoreError }) }}
    </p>
    <p v-else-if="panelError" class="rules-message error">{{ panelError }}</p>
    <p v-else-if="actionMessage" class="rules-message">{{ actionMessage }}</p>

    <div class="rules-list-shell">
      <div class="rules-list-head">
        <h3>{{ $t("engineRules.library.title") }}</h3>
        <span class="rules-count">{{ engineRules.length }}</span>
      </div>
      <EngineRuleLibrary
        :rules="engineRules"
        :active-rule-id="activeRuleId"
        :disabled="!canOperate"
        :show-title="false"
        @select="handleSelectRule"
        @export="handleExportRule"
        @duplicate="handleDuplicateRule"
        @remove="handleDeleteRule"
      />
    </div>
  </section>
</template>

<style scoped>
.rules-index {
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: 12px;
}

.rules-toolbar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-main);
  padding-bottom: 2px;
}

.rule-action-card {
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

.rule-action-card:hover:not(:disabled) {
  background: var(--bg-input);
  border-color: var(--accent);
}

.rule-action-card:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.create-card {
  border-style: dashed;
}

.rule-action-title {
  font-size: var(--fs-md);
  font-weight: 600;
}

.rule-action-description {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.rules-message {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-muted);
  min-height: 18px;
}

.rules-message.error {
  color: var(--danger);
}

.rules-list-shell {
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 10px;
}

.rules-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.rules-list-head h3 {
  margin: 0;
  color: var(--text-main);
  font-size: var(--fs-lg);
  font-weight: 600;
}

.rules-count {
  border: 1px solid var(--stroke-soft);
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-muted);
  font-size: var(--fs-caption);
  line-height: 1;
  padding: 4px 8px;
}

.rules-list-shell :deep(.rule-library) {
  height: 100%;
  min-height: 0;
}

@media (max-width: 780px) {
  .rules-toolbar {
    grid-template-columns: minmax(0, 1fr);
  }

  .rule-action-card {
    min-height: 96px;
  }
}
</style>
