import { ref, watch } from "vue";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

const SETTINGS_KEYS = {
  appearanceMode: "settings.appearanceMode",
  liquidGlassMode: "settings.liquidGlassMode",
  accentColor: "settings.accentColor",
} as const;

const APPEARANCE_SYNC_EVENT = "appearance-settings-updated";

export const appearanceOptions = [
  { id: "auto", labelKey: "appearanceOptions.auto" },
  { id: "light", labelKey: "appearanceOptions.light" },
  { id: "dark", labelKey: "appearanceOptions.dark" },
] as const;

export const liquidGlassOptions = [
  { id: "transparent", labelKey: "liquidGlassOptions.transparent" },
  { id: "tinted", labelKey: "liquidGlassOptions.tinted" },
] as const;

export const accentColors = [
  { id: "rainbow", labelKey: "accentColors.rainbow", hex: "#8e8e93" },
  { id: "blue", labelKey: "accentColors.blue", hex: "#0a84ff" },
  { id: "purple", labelKey: "accentColors.purple", hex: "#9b59b6" },
  { id: "pink", labelKey: "accentColors.pink", hex: "#ff5ea8" },
  { id: "red", labelKey: "accentColors.red", hex: "#ff5a5f" },
  { id: "orange", labelKey: "accentColors.orange", hex: "#ff9f0a" },
  { id: "yellow", labelKey: "accentColors.yellow", hex: "#ffd60a" },
  { id: "green", labelKey: "accentColors.green", hex: "#34c759" },
  { id: "gray", labelKey: "accentColors.gray", hex: "#8e8e93" },
] as const;

type AppearanceMode = (typeof appearanceOptions)[number]["id"];
type LiquidGlassMode = (typeof liquidGlassOptions)[number]["id"];
type AccentColor = (typeof accentColors)[number]["id"];

type AppearanceSettingsSnapshot = {
  appearanceMode: AppearanceMode;
  liquidGlassMode: LiquidGlassMode;
  accentColor: AccentColor;
};

const appearanceMode = ref<AppearanceMode>("dark");
const liquidGlassMode = ref<LiquidGlassMode>("transparent");
const accentColor = ref<AccentColor>("blue");
const systemPrefersDark = ref(true);

let isAppearanceInitialized = false;
let isApplyingRemoteSync = false;
let releaseMediaQueryListener: (() => void) | undefined;
let removeStorageListener: (() => void) | undefined;
let unlistenAppearanceSync: UnlistenFn | undefined;

function hexToRgbString(hex: string): string {
  const normalized = hex.trim().replace("#", "");
  const fullHex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((channel) => `${channel}${channel}`)
          .join("")
      : normalized;

  if (!/^[0-9a-fA-F]{6}$/.test(fullHex)) {
    return "10, 132, 255";
  }

  const red = Number.parseInt(fullHex.slice(0, 2), 16);
  const green = Number.parseInt(fullHex.slice(2, 4), 16);
  const blue = Number.parseInt(fullHex.slice(4, 6), 16);
  return `${red}, ${green}, ${blue}`;
}

function isAppearanceMode(value: string): value is AppearanceMode {
  return appearanceOptions.some((item) => item.id === value);
}

function isLiquidGlassMode(value: string): value is LiquidGlassMode {
  return liquidGlassOptions.some((item) => item.id === value);
}

function isAccentColor(value: string): value is AccentColor {
  return accentColors.some((item) => item.id === value);
}

function getCurrentSnapshot(): AppearanceSettingsSnapshot {
  return {
    appearanceMode: appearanceMode.value,
    liquidGlassMode: liquidGlassMode.value,
    accentColor: accentColor.value,
  };
}

function hasSnapshotChanged(nextSnapshot: AppearanceSettingsSnapshot): boolean {
  return (
    nextSnapshot.appearanceMode !== appearanceMode.value ||
    nextSnapshot.liquidGlassMode !== liquidGlassMode.value ||
    nextSnapshot.accentColor !== accentColor.value
  );
}

function resolveThemeMode(mode: AppearanceMode): "light" | "dark" {
  if (mode === "auto") {
    return systemPrefersDark.value ? "dark" : "light";
  }
  return mode;
}

function applyAppearanceSettings(snapshot: AppearanceSettingsSnapshot): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  const accentHex = accentColors.find((item) => item.id === snapshot.accentColor)?.hex ?? "#0a84ff";
  const resolvedTheme = resolveThemeMode(snapshot.appearanceMode);
  const accentRgb = hexToRgbString(accentHex);
  const focusAlpha = resolvedTheme === "dark" ? 0.32 : 0.24;

  root.dataset.theme = resolvedTheme;
  root.dataset.glass = snapshot.liquidGlassMode;
  root.style.setProperty("--accent", accentHex);
  root.style.setProperty("--accent-strong", accentHex);
  root.style.setProperty("--focus-ring", `rgba(${accentRgb}, ${focusAlpha})`);
}

function readSnapshotFromStorage(): AppearanceSettingsSnapshot {
  if (typeof window === "undefined") {
    return getCurrentSnapshot();
  }

  const savedAppearance = window.localStorage.getItem(SETTINGS_KEYS.appearanceMode);
  const savedLiquidGlass = window.localStorage.getItem(SETTINGS_KEYS.liquidGlassMode);
  const savedAccent = window.localStorage.getItem(SETTINGS_KEYS.accentColor);

  return {
    appearanceMode: savedAppearance && isAppearanceMode(savedAppearance) ? savedAppearance : "dark",
    liquidGlassMode:
      savedLiquidGlass && isLiquidGlassMode(savedLiquidGlass) ? savedLiquidGlass : "transparent",
    accentColor: savedAccent && isAccentColor(savedAccent) ? savedAccent : "blue",
  };
}

function writeSnapshotToStorage(snapshot: AppearanceSettingsSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(SETTINGS_KEYS.appearanceMode, snapshot.appearanceMode);
  window.localStorage.setItem(SETTINGS_KEYS.liquidGlassMode, snapshot.liquidGlassMode);
  window.localStorage.setItem(SETTINGS_KEYS.accentColor, snapshot.accentColor);
}

function applySnapshot(snapshot: AppearanceSettingsSnapshot): void {
  appearanceMode.value = snapshot.appearanceMode;
  liquidGlassMode.value = snapshot.liquidGlassMode;
  accentColor.value = snapshot.accentColor;
  applyAppearanceSettings(snapshot);
}

function bindSystemAppearance(): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  systemPrefersDark.value = mediaQuery.matches;

  const handleChange = (event: MediaQueryListEvent): void => {
    systemPrefersDark.value = event.matches;
    applyAppearanceSettings(getCurrentSnapshot());
  };

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleChange);
    releaseMediaQueryListener = () => mediaQuery.removeEventListener("change", handleChange);
    return;
  }

  mediaQuery.addListener(handleChange);
  releaseMediaQueryListener = () => mediaQuery.removeListener(handleChange);
}

function bindStorageSync(): void {
  if (typeof window === "undefined") {
    return;
  }

  const handleStorage = (event: StorageEvent): void => {
    if (
      event.key !== SETTINGS_KEYS.appearanceMode &&
      event.key !== SETTINGS_KEYS.liquidGlassMode &&
      event.key !== SETTINGS_KEYS.accentColor
    ) {
      return;
    }

    const nextSnapshot = readSnapshotFromStorage();
    if (!hasSnapshotChanged(nextSnapshot)) {
      applyAppearanceSettings(nextSnapshot);
      return;
    }

    isApplyingRemoteSync = true;
    applySnapshot(nextSnapshot);
  };

  window.addEventListener("storage", handleStorage);
  removeStorageListener = () => window.removeEventListener("storage", handleStorage);
}

async function bindTauriAppearanceSync(): Promise<void> {
  try {
    unlistenAppearanceSync = await listen<AppearanceSettingsSnapshot>(APPEARANCE_SYNC_EVENT, (event) => {
      const nextSnapshot = event.payload;
      if (!nextSnapshot || !hasSnapshotChanged(nextSnapshot)) {
        applyAppearanceSettings(getCurrentSnapshot());
        return;
      }

      isApplyingRemoteSync = true;
      applySnapshot(nextSnapshot);
    });
  } catch {
    unlistenAppearanceSync = undefined;
  }
}

async function broadcastAppearanceSettings(snapshot: AppearanceSettingsSnapshot): Promise<void> {
  try {
    await emit(APPEARANCE_SYNC_EVENT, snapshot);
  } catch {
    // Browser-only dev mode does not provide Tauri event transport.
  }
}

export function initializeAppearanceSettings(): void {
  if (isAppearanceInitialized) {
    return;
  }

  isAppearanceInitialized = true;
  bindSystemAppearance();
  bindStorageSync();

  const initialSnapshot = readSnapshotFromStorage();
  applySnapshot(initialSnapshot);

  watch(
    [appearanceMode, liquidGlassMode, accentColor],
    async () => {
      const snapshot = getCurrentSnapshot();
      writeSnapshotToStorage(snapshot);
      applyAppearanceSettings(snapshot);

      if (isApplyingRemoteSync) {
        isApplyingRemoteSync = false;
        return;
      }

      await broadcastAppearanceSettings(snapshot);
    },
    { flush: "post" },
  );

  void bindTauriAppearanceSync();
}

export function disposeAppearanceSettings(): void {
  releaseMediaQueryListener?.();
  releaseMediaQueryListener = undefined;
  removeStorageListener?.();
  removeStorageListener = undefined;
  unlistenAppearanceSync?.();
  unlistenAppearanceSync = undefined;
  isAppearanceInitialized = false;
}

export function useAppearanceSettings() {
  return {
    appearanceMode,
    liquidGlassMode,
    accentColor,
  };
}
