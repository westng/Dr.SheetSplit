import { invoke } from "@tauri-apps/api/core";
import { createApp } from "vue";
import App from "./App.vue";
import { initializeAppearanceSettings } from "./composables/useAppearanceSettings";
import { i18n } from "./i18n";
import { router } from "./router";
import { initializeLocaleStore } from "./store";

function serializeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function appendAppLog(level: "INFO" | "WARN" | "ERROR", message: string): Promise<void> {
  const normalized = message.trim();
  if (!normalized) {
    return;
  }
  try {
    await invoke("append_app_log", { level, message: normalized });
  } catch {
  }
}

function installGlobalErrorLogging(): void {
  window.addEventListener("error", (event) => {
    const detail = [
      event.message,
      event.filename ? `file=${event.filename}` : "",
      event.lineno ? `line=${event.lineno}` : "",
      event.colno ? `col=${event.colno}` : "",
      event.error ? serializeUnknownError(event.error) : "",
    ]
      .filter(Boolean)
      .join(" | ");
    void appendAppLog("ERROR", `[frontend:error] ${detail}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    void appendAppLog("ERROR", `[frontend:unhandledrejection] ${serializeUnknownError(event.reason)}`);
  });
}

initializeLocaleStore();
initializeAppearanceSettings();
installGlobalErrorLogging();

const app = createApp(App);
app.config.errorHandler = (error, _instance, info) => {
  void appendAppLog("ERROR", `[vue:error] ${info} | ${serializeUnknownError(error)}`);
};

void appendAppLog("INFO", "[frontend] application bootstrapped");

app.use(router).use(i18n).mount("#app");
