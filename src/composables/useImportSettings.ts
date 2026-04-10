import { computed, ref, watch } from "vue";

const SETTINGS_KEYS = {
  allowedImportFormats: "settings.allowedImportFormats",
} as const;

const BUILTIN_IMPORT_FORMATS = ["xlsx", "xls", "csv"] as const;
const allowedImportFormats = ref<string[]>([...BUILTIN_IMPORT_FORMATS]);

let isImportSettingsInitialized = false;

function normalizeExtension(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, "");
}

function isValidExtension(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
}

function normalizeImportFormats(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [...BUILTIN_IMPORT_FORMATS];
  }

  const deduped = Array.from(
    new Set(
      value
        .map((item) => normalizeExtension(String(item)))
        .filter((item) => isValidExtension(item)),
    ),
  );

  return mergeWithBuiltinFormats(deduped);
}

function mergeWithBuiltinFormats(items: string[]): string[] {
  return Array.from(new Set([...BUILTIN_IMPORT_FORMATS, ...items]));
}

function normalizeImportFormatsText(value: string): string[] {
  const parsed = value
    .split(/[,，\s]+/g)
    .map((item) => normalizeExtension(item))
    .filter((item) => isValidExtension(item));
  return mergeWithBuiltinFormats(parsed);
}

function getFileExtension(fileName: string): string {
  const normalized = fileName.trim().toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === normalized.length - 1) {
    return "";
  }
  return normalized.slice(dotIndex + 1);
}

function readSettingsFromStorage(): void {
  if (typeof window === "undefined") {
    return;
  }
  const saved = window.localStorage.getItem(SETTINGS_KEYS.allowedImportFormats);
  if (!saved) {
    allowedImportFormats.value = [...BUILTIN_IMPORT_FORMATS];
    return;
  }

  try {
    const parsed = JSON.parse(saved) as unknown;
    allowedImportFormats.value = normalizeImportFormats(parsed);
  } catch {
    allowedImportFormats.value = [...BUILTIN_IMPORT_FORMATS];
  }
}

export function initializeImportSettings(): void {
  if (isImportSettingsInitialized) {
    return;
  }
  isImportSettingsInitialized = true;

  readSettingsFromStorage();
  watch(
    allowedImportFormats,
    (nextFormats) => {
      if (typeof window === "undefined") {
        return;
      }
      window.localStorage.setItem(SETTINGS_KEYS.allowedImportFormats, JSON.stringify(nextFormats));
    },
    { deep: true },
  );
}

export function useImportSettings() {
  initializeImportSettings();

  const allowedImportAccept = computed(() => allowedImportFormats.value.map((item) => `.${item}`).join(","));
  const allowedImportDisplay = computed(() =>
    allowedImportFormats.value.map((item) => item.toUpperCase()).join(" / "),
  );

  function setAllowedImportFormatsFromText(value: string): string[] {
    const normalized = normalizeImportFormatsText(value);
    allowedImportFormats.value = normalized;
    return normalized;
  }

  function isAllowedImportFile(file: File | string): boolean {
    const fileName = typeof file === "string" ? file : file.name;
    const extension = getFileExtension(fileName);
    return allowedImportFormats.value.includes(extension);
  }

  return {
    builtinImportFormats: [...BUILTIN_IMPORT_FORMATS],
    allowedImportFormats,
    allowedImportAccept,
    allowedImportDisplay,
    setAllowedImportFormatsFromText,
    isAllowedImportFile,
  };
}
