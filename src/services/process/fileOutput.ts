import { invoke } from "@tauri-apps/api/core";
import { downloadDir, join } from "@tauri-apps/api/path";

const EXPORT_DIRECTORY_STORAGE_KEY = "settings.exportDirectory";
const DEFAULT_FALLBACK_EXPORT_DIRECTORY = "~/Downloads";

type WriteBinaryPayload = {
  path: string;
  contentBase64: string;
};

function normalizePath(value: string): string {
  return value.trim();
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_");
  return sanitized || "output";
}

function stripExtension(fileName: string): string {
  const normalized = fileName.trim();
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex <= 0) {
    return normalized || "source";
  }
  return normalized.slice(0, dotIndex);
}

function formatTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  const second = `${date.getSeconds()}`.padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function resolveFallbackDirectory(): Promise<string> {
  try {
    const fromSystem = await downloadDir();
    return normalizePath(fromSystem) || DEFAULT_FALLBACK_EXPORT_DIRECTORY;
  } catch {
    return DEFAULT_FALLBACK_EXPORT_DIRECTORY;
  }
}

export async function resolveExportDirectory(preferredDirectory = ""): Promise<string> {
  const normalizedPreferred = normalizePath(preferredDirectory);
  if (normalizedPreferred) {
    return normalizedPreferred;
  }

  if (typeof window !== "undefined") {
    const fromStorage = normalizePath(window.localStorage.getItem(EXPORT_DIRECTORY_STORAGE_KEY) ?? "");
    if (fromStorage) {
      return fromStorage;
    }
  }

  return resolveFallbackDirectory();
}

export async function resolveOutputPath(
  sourceFileName: string,
  ruleName: string,
  preferredDirectory = "",
): Promise<string> {
  const directory = await resolveExportDirectory(preferredDirectory);
  const sourceStem = sanitizeSegment(stripExtension(sourceFileName));
  const normalizedRuleName = sanitizeSegment(ruleName || "rule");
  const fileName = `${sourceStem}-${normalizedRuleName}-${formatTimestamp()}.xlsx`;
  return join(directory, fileName);
}

export async function writeBinaryToPath(path: string, bytes: Uint8Array): Promise<void> {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) {
    throw new Error("输出路径无效。");
  }

  await invoke("write_binary_file", {
    path: normalizedPath,
    contentBase64: toBase64(bytes),
  } satisfies WriteBinaryPayload);
}
