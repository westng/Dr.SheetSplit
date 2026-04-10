import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { downloadDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { computed, onMounted, ref, watch } from "vue";
import { i18n } from "../i18n";

const RELEASE_PAGE_URL = "https://github.com/westng/Dr.SheetSplit/releases";
const SETTINGS_KEYS = {
  autoCheck: "settings.autoCheckUpdates",
  exportDirectory: "settings.exportDirectory",
} as const;

export function useUpdater() {
  const autoCheckUpdates = ref(true);
  const exportDirectory = ref("~/Downloads");
  const currentVersion = ref("1.0.0");
  const latestVersion = ref("");
  const pendingUpdate = ref<Update | null>(null);
  const updateStatus = ref<
    | "idle"
    | "checking"
    | "available"
    | "latest"
    | "downloading"
    | "installing"
    | "installed"
    | "error"
  >("idle");
  const updateMessageKey = ref("updater.status.idle");
  const updateMessageParams = ref<Record<string, number | string>>({});
  const updateMessageRaw = ref("");
  const updateMessage = computed(() => {
    void i18n.global.locale.value;
    if (updateMessageRaw.value) {
      return updateMessageRaw.value;
    }
    return i18n.global.t(updateMessageKey.value, updateMessageParams.value);
  });
  const updateProgress = ref("");

  function setUpdateMessage(key: string, params: Record<string, number | string> = {}): void {
    updateMessageRaw.value = "";
    updateMessageKey.value = key;
    updateMessageParams.value = params;
  }

  async function chooseExportDirectory(): Promise<void> {
    const selected = await open({
      title: i18n.global.t("settings.exportDirectory.prompt"),
      directory: true,
      multiple: false,
      defaultPath: exportDirectory.value,
    });

    if (!selected) {
      return;
    }

    const nextPath = Array.isArray(selected) ? selected[0] : selected;
    if (!nextPath) {
      return;
    }

    const trimmed = nextPath.trim();
    if (trimmed.length > 0) {
      exportDirectory.value = trimmed;
    }
  }

  function normalizeVersion(version: string): string {
    return version.trim().replace(/^v/i, "").split("-")[0];
  }

  function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return i18n.global.t("updater.status.operationFailed");
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function checkForUpdates(manual = true): Promise<void> {
    if (!autoCheckUpdates.value && !manual) {
      return;
    }

    updateStatus.value = "checking";
    updateProgress.value = "";
    setUpdateMessage("updater.status.checking");

    try {
      const update = await check();
      pendingUpdate.value = update;

      if (update) {
        latestVersion.value = normalizeVersion(update.version);
        updateStatus.value = "available";
        setUpdateMessage("updater.status.available", {
          latest: latestVersion.value,
          current: currentVersion.value,
        });
        return;
      }

      latestVersion.value = "";
      updateStatus.value = "latest";
      setUpdateMessage("updater.status.latest", { current: currentVersion.value });
    } catch (error) {
      pendingUpdate.value = null;
      updateStatus.value = "error";
      const message = toErrorMessage(error);
      if (message.includes("endpoints")) {
        setUpdateMessage("updater.status.endpointMissing");
        return;
      }
      updateMessageRaw.value = message;
    }
  }

  async function downloadAndInstallUpdate(): Promise<void> {
    if (!pendingUpdate.value) {
      updateStatus.value = "error";
      setUpdateMessage("updater.status.noPending");
      return;
    }

    try {
      updateStatus.value = "downloading";
      updateProgress.value = "";

      let totalBytes: number | undefined;
      let downloadedBytes = 0;

      await pendingUpdate.value.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength;
          setUpdateMessage("updater.status.downloading");
          return;
        }

        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          if (totalBytes && totalBytes > 0) {
            const percent = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
            updateProgress.value = `${percent}%`;
          } else {
            updateProgress.value = formatBytes(downloadedBytes);
          }
          return;
        }

        if (event.event === "Finished") {
          updateStatus.value = "installing";
          setUpdateMessage("updater.status.installing");
        }
      });

      updateStatus.value = "installed";
      setUpdateMessage("updater.status.installed");
      updateProgress.value = "";
      pendingUpdate.value = null;
      await invoke("restart_app");
    } catch (error) {
      updateStatus.value = "error";
      updateMessageRaw.value = toErrorMessage(error);
    }
  }

  async function openReleasePage(): Promise<void> {
    await openUrl(RELEASE_PAGE_URL);
  }

  watch(autoCheckUpdates, (enabled) => {
    localStorage.setItem(SETTINGS_KEYS.autoCheck, JSON.stringify(enabled));
    if (enabled) {
      void checkForUpdates(false);
    }
  });

  watch(exportDirectory, (path) => {
    localStorage.setItem(SETTINGS_KEYS.exportDirectory, path);
  });

  onMounted(async () => {
    const savedAutoCheck = localStorage.getItem(SETTINGS_KEYS.autoCheck);
    if (savedAutoCheck !== null) {
      autoCheckUpdates.value = savedAutoCheck === "true";
    }

    const savedExportDirectory = localStorage.getItem(SETTINGS_KEYS.exportDirectory);
    if (savedExportDirectory) {
      exportDirectory.value = savedExportDirectory;
    } else {
      try {
        exportDirectory.value = await downloadDir();
      } catch {
        exportDirectory.value = "~/Downloads";
      }
    }

    try {
      currentVersion.value = normalizeVersion(await getVersion());
    } catch {
      currentVersion.value = "1.0.0";
    }

    if (autoCheckUpdates.value) {
      void checkForUpdates(false);
    }
  });

  return {
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
  };
}
