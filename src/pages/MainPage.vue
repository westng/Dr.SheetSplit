<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import ConfigPanel from "../components/config/ConfigPanel.vue";
import HistoryDetailPanel from "../components/history/HistoryDetailPanel.vue";
import MappingPanel from "../components/mapping/MappingPanel.vue";
import WorkspacePanel from "../components/workspace/WorkspacePanel.vue";
import { useHistoryStore, useLocaleStore, useUiStore } from "../store";
import {
  accentColors,
  appearanceOptions,
  liquidGlassOptions,
  useAppearanceSettings,
} from "../composables/useAppearanceSettings";
import { useImportSettings } from "../composables/useImportSettings";
import { useOverflowMarquee } from "../composables/useOverflowMarquee";
import { useSlogan } from "../composables/useSlogan";
import { useUpdater } from "../composables/useUpdater";

const appWindow = getCurrentWindow();
const { t } = useI18n();
const { activeHistoryId, activeMenu } = useUiStore();
const { locale, localeOptions } = useLocaleStore();
const { histories, clearHistory: clearHistoryStore } = useHistoryStore();

const { sloganText } = useSlogan();
const {
  containerRef: sloganContainerRef,
  trackRef: sloganTrackRef,
  isOverflowing: isSloganOverflowing,
  marqueeStyle: sloganMarqueeStyle,
} = useOverflowMarquee(sloganText);
const { appearanceMode, liquidGlassMode, accentColor } = useAppearanceSettings();
const { allowedImportFormats, builtinImportFormats, setAllowedImportFormatsFromText } = useImportSettings();
const {
  autoCheckUpdates,
  exportDirectory,
  currentVersion,
  pendingUpdate,
  updateStatus,
  updateMessage,
  updateProgress,
  chooseExportDirectory,
  checkForUpdates,
  downloadAndInstallUpdate,
  openReleasePage,
} = useUpdater();
const GITHUB_REPO_URL = "https://github.com/westng/Dr.SheetSplit";

const historyItems = computed(() => histories.value);
const importFormatsText = ref("");
const currentYear = new Date().getFullYear();
const contentTitle = computed(() => {
  if (activeMenu.value === "rules") {
    return t("content.rules");
  }
  if (activeMenu.value === "mapping") {
    return t("content.mapping");
  }
  if (activeMenu.value === "settings") {
    return t("content.settings");
  }
  return t("content.process");
});
const footerCopyright = computed(() =>
  t("settings.footer.copyright", {
    year: currentYear,
  }),
);

function openGithubRepo(): void {
  void openUrl(GITHUB_REPO_URL);
}

function formatHistoryTime(timestampMs: number): string {
  if (!timestampMs) {
    return "-";
  }
  const date = new Date(timestampMs);
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  const hh = `${date.getHours()}`.padStart(2, "0");
  const mm = `${date.getMinutes()}`.padStart(2, "0");
  return `${m}/${d} ${hh}:${mm}`;
}

function handleTopDragFallback(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (target?.closest('[data-no-drag="true"]')) {
    return;
  }
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  void appWindow.startDragging();
}

async function clearHistory(): Promise<void> {
  await clearHistoryStore();
  activeHistoryId.value = "";
}

function syncImportFormatsText(): void {
  importFormatsText.value = allowedImportFormats.value.join(", ");
}

function applyImportFormatsText(): void {
  const next = setAllowedImportFormatsFromText(importFormatsText.value);
  importFormatsText.value = next.join(", ");
}

syncImportFormatsText();
watch(allowedImportFormats, () => {
  syncImportFormatsText();
}, { deep: true });
</script>

<template>
  <div class="main-shell">
    <div class="top-drag-region" data-tauri-drag-region="true" @mousedown.capture="handleTopDragFallback" />
    <button
      type="button"
      class="top-action-btn"
      data-no-drag="true"
      :aria-label="$t('topBar.openGithub')"
      :title="$t('topBar.openGithub')"
      @click="openGithubRepo"
    >
      <svg viewBox="0 0 24 24" class="top-action-icon" aria-hidden="true">
        <path
          d="M12 1.5a10.5 10.5 0 0 0-3.32 20.46c.53.1.72-.22.72-.5v-1.94c-2.94.64-3.56-1.24-3.56-1.24-.48-1.23-1.17-1.56-1.17-1.56-.96-.66.07-.65.07-.65 1.06.08 1.62 1.09 1.62 1.09.95 1.61 2.48 1.14 3.08.87.1-.67.37-1.14.67-1.4-2.35-.27-4.83-1.17-4.83-5.24 0-1.16.41-2.12 1.09-2.86-.1-.27-.47-1.36.1-2.84 0 0 .9-.29 2.95 1.09a10.31 10.31 0 0 1 5.37 0c2.05-1.38 2.95-1.09 2.95-1.09.57 1.48.2 2.57.1 2.84.68.74 1.09 1.7 1.09 2.86 0 4.08-2.49 4.97-4.86 5.23.38.33.72.98.72 1.97v2.92c0 .28.19.61.73.5A10.5 10.5 0 0 0 12 1.5Z" />
      </svg>
    </button>

    <aside class="sidebar">
      <header class="brand-block">
        <h1>{{ $t("app.name") }}</h1>
        <p ref="sloganContainerRef" class="brand-slogan">
          <span ref="sloganTrackRef" class="brand-slogan-track" :class="{ scrolling: isSloganOverflowing }"
            :style="sloganMarqueeStyle" :key="sloganText">
            {{ sloganText }}
          </span>
        </p>
      </header>

      <section class="nav-section">
        <h2>{{ $t("sidebar.menu") }}</h2>
        <button class="menu-card" :class="{ active: activeMenu === 'process' }" type="button"
          @click="activeMenu = 'process'; activeHistoryId = ''">
          <span class="menu-icon">+</span>
          <span class="menu-meta">
            <strong>{{ $t("sidebar.process.title") }}</strong>
            <small>{{ $t("sidebar.process.description") }}</small>
          </span>
        </button>
        <button class="menu-card" :class="{ active: activeMenu === 'rules' }" type="button"
          @click="activeMenu = 'rules'">
          <span class="menu-icon">R</span>
          <span class="menu-meta">
            <strong>{{ $t("sidebar.rules.title") }}</strong>
            <small>{{ $t("sidebar.rules.description") }}</small>
          </span>
        </button>
        <button class="menu-card" :class="{ active: activeMenu === 'mapping' }" type="button"
          @click="activeMenu = 'mapping'">
          <span class="menu-icon">M</span>
          <span class="menu-meta">
            <strong>{{ $t("sidebar.mapping.title") }}</strong>
            <small>{{ $t("sidebar.mapping.description") }}</small>
          </span>
        </button>
      </section>

      <section class="nav-section history-section">
        <div class="section-header">
          <h2>{{ $t("sidebar.history") }}</h2>
          <button
            v-if="historyItems.length > 0"
            type="button"
            class="section-link-btn"
            @click="clearHistory"
          >
            {{ $t("sidebar.clearHistory") }}
          </button>
        </div>
        <ul class="history-list">
          <li v-if="historyItems.length === 0" class="history-empty">
            {{ $t("history.empty") }}
          </li>
          <li v-for="item in historyItems" :key="item.id">
            <button type="button" class="history-card" :class="{ active: item.id === activeHistoryId }"
              @click="activeMenu = 'process'; activeHistoryId = item.id">
              <span class="history-main">
                <span class="history-name">{{ item.ruleName || $t("rules.library.unnamed") }}</span>
                <span class="history-meta">
                  {{ item.status === "success" ? $t("history.status.success") : $t("history.status.failed") }}
                </span>
              </span>
              <span class="history-time">{{ formatHistoryTime(item.startedAtMs) }}</span>
            </button>
          </li>
        </ul>
      </section>

      <button type="button" class="account-entry" :class="{ active: activeMenu === 'settings' }"
        @click="activeMenu = 'settings'">
        <span class="account-avatar">Dr.</span>
        <span class="account-name">{{ $t("sidebar.account") }}</span>
      </button>
    </aside>

    <main class="content-panel">
      <header class="content-header">
        <h2>{{ contentTitle }}</h2>
      </header>

      <section v-if="activeMenu === 'rules'" class="content-body">
        <ConfigPanel />
      </section>

      <section v-else-if="activeMenu === 'mapping'" class="content-body">
        <MappingPanel />
      </section>

      <section v-else-if="activeMenu === 'settings'" class="content-body settings-page">
        <div class="settings-group">
          <h4 class="settings-group-title">{{ $t("settings.groups.appearance") }}</h4>
          <div class="appearance-grid">
            <button v-for="option in appearanceOptions" :key="option.id" type="button" class="appearance-option"
              :class="{ active: appearanceMode === option.id }" @click="appearanceMode = option.id">
              <span class="appearance-preview" />
              <span class="appearance-label">{{ $t(option.labelKey) }}</span>
            </button>
          </div>
          <div class="settings-item settings-item-stacked">
            <div class="settings-row">
              <span class="settings-label">{{ $t("settings.appearance.liquidGlass") }}</span>
              <span class="settings-value">{{ $t("settings.appearance.liquidGlassHint") }}</span>
            </div>
            <div class="glass-options">
              <button v-for="option in liquidGlassOptions" :key="option.id" type="button" class="glass-option"
                :class="{ active: liquidGlassMode === option.id }" @click="liquidGlassMode = option.id">
                {{ $t(option.labelKey) }}
              </button>
            </div>
          </div>
          <div class="settings-item">
            <span class="settings-label">{{ $t("settings.language.label") }}</span>
            <select v-model="locale" class="language-select">
              <option v-for="option in localeOptions" :key="option.value" :value="option.value">
                {{ $t(option.labelKey) }}
              </option>
            </select>
          </div>
        </div>

        <div class="settings-group">
          <h4 class="settings-group-title">{{ $t("settings.groups.theme") }}</h4>
          <div class="settings-item">
            <span class="settings-label">{{ $t("settings.theme.color") }}</span>
            <div class="color-palette">
              <button v-for="color in accentColors" :key="color.id" type="button" class="color-dot"
                :class="{ active: accentColor === color.id }" :title="$t(color.labelKey)" :aria-label="$t(color.labelKey)"
                :style="{ backgroundColor: color.hex }" @click="accentColor = color.id" />
            </div>
          </div>
        </div>

        <div class="settings-group">
          <h4 class="settings-group-title">{{ $t("settings.groups.importExport") }}</h4>
          <div class="settings-item">
            <span class="settings-label">{{ $t("settings.exportDirectory.label") }}</span>
            <div class="directory-row">
              <input v-model="exportDirectory" type="text" class="directory-input"
                :placeholder="$t('settings.exportDirectory.placeholder')" />
              <button type="button" class="secondary-btn" @click="chooseExportDirectory">
                {{ $t("settings.exportDirectory.select") }}
              </button>
            </div>
          </div>
          <div class="settings-item settings-item-stacked">
            <div class="settings-row">
              <span class="settings-label">{{ $t("settings.importFormats.label") }}</span>
              <span class="settings-value">{{ $t("settings.importFormats.hint") }}</span>
            </div>
            <input
              v-model="importFormatsText"
              type="text"
              class="format-input"
              :placeholder="$t('settings.importFormats.placeholder')"
              @keydown.enter.prevent="applyImportFormatsText"
              @blur="applyImportFormatsText"
            />
            <p class="format-message">
              {{
                $t("settings.importFormats.builtinLocked", {
                  formats: builtinImportFormats.map((item) => item.toUpperCase()).join(", "),
                })
              }}
            </p>
          </div>
        </div>

        <div class="settings-group">
          <h4 class="settings-group-title">{{ $t("settings.groups.update") }}</h4>
          <div class="settings-item">
            <span class="settings-label">{{ $t("settings.currentVersion") }}</span>
            <span class="settings-value">v{{ currentVersion }}</span>
          </div>
          <div class="settings-item">
            <span class="settings-label">{{ $t("settings.autoCheckUpdates") }}</span>
            <label class="switch" :aria-label="$t('settings.autoCheckUpdates')">
              <input v-model="autoCheckUpdates" type="checkbox" />
              <span class="switch-track">
                <span class="switch-thumb" />
              </span>
            </label>
          </div>
          <div class="settings-item settings-item-stacked">
            <div class="update-row">
              <span class="settings-label">{{ $t("settings.updateActions") }}</span>
              <div class="update-actions">
                <button type="button" class="secondary-btn" :disabled="updateStatus === 'checking' ||
                  updateStatus === 'downloading' ||
                  updateStatus === 'installing'
                  " @click="checkForUpdates(true)">
                  {{ updateStatus === "checking" ? $t("updater.actions.checking") : $t("updater.actions.check") }}
                </button>
                <button type="button" class="secondary-btn" :disabled="updateStatus === 'checking' ||
                  updateStatus === 'downloading' ||
                  updateStatus === 'installing' ||
                  !pendingUpdate
                  " @click="downloadAndInstallUpdate">
                  {{
                    updateStatus === "downloading" || updateStatus === "installing"
                      ? $t("updater.actions.processing")
                      : $t("updater.actions.install")
                  }}
                </button>
              </div>
            </div>
            <p class="update-status" :class="`status-${updateStatus}`">
              {{ updateMessage }}
              <span v-if="updateProgress">（{{ updateProgress }}）</span>
            </p>
            <button v-if="updateStatus === 'error' || updateStatus === 'available'" type="button" class="secondary-btn"
              @click="openReleasePage">
              {{ $t("settings.openReleasePage") }}
            </button>
          </div>
        </div>

        <footer class="settings-footer">
          <p>{{ footerCopyright }}</p>
          <div class="settings-footer-meta">
            <span>{{ $t("settings.footer.author") }}</span>
            <button type="button" class="settings-footer-github" :aria-label="$t('topBar.openGithub')"
              :title="$t('topBar.openGithub')"
              @click="openGithubRepo">
              <svg viewBox="0 0 24 24" class="settings-footer-icon" aria-hidden="true">
                <path
                  d="M12 1.5a10.5 10.5 0 0 0-3.32 20.46c.53.1.72-.22.72-.5v-1.94c-2.94.64-3.56-1.24-3.56-1.24-.48-1.23-1.17-1.56-1.17-1.56-.96-.66.07-.65.07-.65 1.06.08 1.62 1.09 1.62 1.09.95 1.61 2.48 1.14 3.08.87.1-.67.37-1.14.67-1.4-2.35-.27-4.83-1.17-4.83-5.24 0-1.16.41-2.12 1.09-2.86-.1-.27-.47-1.36.1-2.84 0 0 .9-.29 2.95 1.09a10.31 10.31 0 0 1 5.37 0c2.05-1.38 2.95-1.09 2.95-1.09.57 1.48.2 2.57.1 2.84.68.74 1.09 1.7 1.09 2.86 0 4.08-2.49 4.97-4.86 5.23.38.33.72.98.72 1.97v2.92c0 .28.19.61.73.5A10.5 10.5 0 0 0 12 1.5Z" />
              </svg>
            </button>
          </div>
        </footer>
      </section>

      <section v-else class="content-body">
        <HistoryDetailPanel v-if="activeHistoryId" :history-id="activeHistoryId" @back="activeHistoryId = ''" />
        <WorkspacePanel v-else />
      </section>
    </main>
  </div>
</template>

<style scoped>
.main-shell {
  --titlebar-height: 44px;
  position: relative;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  align-items: start;
  gap: 14px;
  box-sizing: border-box;
  min-height: 100vh;
  padding: calc(var(--titlebar-height) + 12px) 18px 18px;
}

.top-drag-region {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  z-index: 40;
  height: var(--titlebar-height);
  pointer-events: auto;
  user-select: none;
  app-region: drag;
  -webkit-app-region: drag;
}

.top-action-btn {
  position: fixed;
  top: 9px;
  right: 14px;
  z-index: 41;
  width: 26px;
  height: 26px;
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-card);
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.top-action-btn:hover {
  color: var(--text-main);
  border-color: var(--accent);
}

.top-action-icon {
  width: 15px;
  height: 15px;
  fill: currentColor;
}

.sidebar {
  border: 1px solid var(--stroke-soft);
  border-radius: 18px;
  background: var(--bg-panel);
  box-shadow: var(--shadow-soft);
  backdrop-filter: saturate(135%) blur(var(--glass-blur));
}

.sidebar {
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: calc(100vh - var(--titlebar-height) - 30px);
  min-height: 0;
  overflow: hidden;
}

.content-panel {
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100vh - var(--titlebar-height) - 30px);
  min-height: 0;
  overflow: hidden;
}

.brand-block h1 {
  margin: 0;
  color: var(--text-main);
  font-size: var(--fs-2xl);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.brand-block p {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: var(--fs-lg);
}

.brand-slogan {
  white-space: nowrap;
  overflow-x: hidden;
  overflow-y: hidden;
  position: relative;
}

.brand-slogan-track {
  display: inline-block;
  will-change: transform;
}

.brand-slogan-track.scrolling {
  animation: slogan-marquee var(--marquee-duration) ease-in-out infinite alternate;
}

@keyframes slogan-marquee {
  from {
    transform: translateX(0);
  }

  to {
    transform: translateX(calc(-1 * var(--marquee-distance)));
  }
}

.nav-section {
  display: grid;
  gap: 8px;
}

.nav-section h2 {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-muted);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.section-link-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--fs-caption);
  line-height: 1;
  padding: 0;
  cursor: pointer;
}

.section-link-btn:hover {
  color: var(--text-main);
}

.menu-card {
  border: 1px solid var(--stroke-soft);
  border-radius: 16px;
  background: var(--bg-card);
  color: var(--text-main);
  padding: 14px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  cursor: pointer;
}

.menu-icon {
  width: 38px;
  height: 38px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-size: var(--fs-xl);
  line-height: 1;
  color: var(--text-main);
  background: var(--bg-strong);
}

.menu-card.active {
  border-color: var(--accent);
  background: var(--bg-strong);
}

.menu-meta {
  display: grid;
}

.menu-meta strong {
  font-size: var(--fs-lg);
  font-weight: 600;
}

.menu-meta small {
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.history-list::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.history-empty {
  border: 1px dashed var(--stroke-soft);
  border-radius: 12px;
  padding: 12px;
  color: var(--text-muted);
  font-size: var(--fs-caption);
  text-align: center;
}

.history-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.history-card {
  width: 100%;
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  background: var(--bg-card);
  color: var(--text-main);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 12px;
  font: inherit;
}

.history-card.active {
  border-color: var(--accent);
  background: var(--bg-strong);
}

.history-name {
  font-size: var(--fs-sm);
  font-weight: 500;
}

.history-main {
  min-width: 0;
  display: grid;
  gap: 2px;
  justify-items: start;
}

.history-meta {
  color: var(--text-muted);
  font-size: var(--fs-caption);
}

.history-time {
  color: var(--text-muted);
  font-size: var(--fs-caption);
  flex-shrink: 0;
}

.account-entry {
  margin-top: auto;
  flex-shrink: 0;
  width: 100%;
  border: 1px solid var(--stroke-soft);
  border-radius: 14px;
  background: var(--bg-card);
  color: var(--text-main);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.account-entry.active {
  border-color: var(--accent);
  background: var(--bg-strong);
}

.account-avatar {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--text-main);
  background: var(--bg-strong);
}

.account-name {
  font-size: var(--fs-md);
  font-weight: 600;
}

.content-header h2 {
  margin: 0;
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--text-main);
}

.content-header p {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.content-body {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.content-body::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.settings-page {
  display: grid;
  gap: 6px;
}

.settings-group {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
  margin-bottom: 20px;
  display: grid;
  gap: 8px;
  backdrop-filter: none;
}

.settings-group-title {
  margin: 0;
  min-height: 22px;
  display: flex;
  align-items: center;
  line-height: 1;
  font-size: var(--fs-sm);
  color: var(--text-muted);
  font-weight: 600;
}

.appearance-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.appearance-option {
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: var(--bg-input);
  padding: 6px;
  display: grid;
  gap: 6px;
  justify-items: center;
  cursor: pointer;
}

.appearance-option.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.appearance-preview {
  width: 100%;
  height: 26px;
  border-radius: 6px;
  background: var(--bg-strong);
}

.appearance-label {
  font-size: var(--fs-caption);
  color: var(--text-main);
}

.glass-options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.glass-option {
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 7px 10px;
  cursor: pointer;
}

.glass-option.active {
  border-color: var(--accent);
  background: var(--bg-strong);
}

.format-input {
  width: 100%;
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 8px 10px;
}

.format-input::placeholder {
  color: var(--text-muted);
}

.format-input:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.format-message {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.color-palette {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.color-dot {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  border: 1px solid var(--stroke-soft);
  cursor: pointer;
}

.color-dot.active {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.settings-item {
  border: 1px solid var(--stroke-soft);
  border-radius: 10px;
  background: var(--bg-input);
  min-height: 52px;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--fs-sm);
}

.settings-item-stacked {
  min-height: initial;
  display: grid;
  align-items: stretch;
  justify-content: initial;
  gap: 8px;
  padding-top: 10px;
  padding-bottom: 10px;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.settings-label {
  color: var(--text-main);
  font-weight: 500;
}

.settings-value {
  color: var(--text-muted);
}

.directory-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.directory-input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 8px 10px;
}

.directory-input::placeholder {
  color: var(--text-muted);
}

.directory-input:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.language-select {
  min-width: 160px;
  border: 1px solid var(--stroke-soft);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 8px 10px;
}

.language-select:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.secondary-btn {
  border: 1px solid var(--btn-border);
  border-radius: 8px;
  background: var(--btn-bg);
  color: var(--text-main);
  font: inherit;
  font-size: var(--fs-sm);
  padding: 8px 12px;
  cursor: pointer;
}

.secondary-btn:hover {
  background: var(--btn-bg-hover);
}

.secondary-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.secondary-btn:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--focus-ring);
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

.switch input:checked+.switch-track {
  background: var(--switch-track-active);
  border-color: var(--accent);
}

.switch input:checked+.switch-track .switch-thumb {
  transform: translateX(16px);
}

.switch input:focus-visible+.switch-track {
  box-shadow: 0 0 0 3px var(--focus-ring);
}

.update-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.update-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.update-status {
  margin: 2px 0 0;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.status-available,
.status-installed {
  color: var(--text-main);
}

.status-error {
  color: var(--danger);
}

.status-checking,
.status-downloading,
.status-installing,
.status-latest {
  color: var(--text-muted);
}

.settings-footer {
  margin-top: 0;
  padding-top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  text-align: center;
}

.settings-footer::before {
  content: "";
  display: block;
  width: 100%;
  border-top: 1px solid var(--stroke-soft);
  margin: 80px 0 10px;
}

.settings-footer p {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--text-muted);
  line-height: 1.4;
}

.settings-footer-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.settings-footer-github {
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.settings-footer-github:hover {
  color: var(--text-main);
}

.settings-footer-icon {
  width: 14px;
  height: 14px;
  fill: currentColor;
}

@media (max-width: 980px) {
  .main-shell {
    grid-template-columns: 1fr;
  }
}
</style>
