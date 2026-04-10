import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

type TextFilePayload = {
  path: string;
  content: string;
};

type FilePathPayload = {
  path: string;
};

function normalizePath(value: string): string {
  return value.trim();
}

export function basenameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || normalized;
}

export function ensureExtension(path: string, extension: string): string {
  const normalized = normalizePath(path);
  if (!normalized) {
    return normalized;
  }
  const expected = extension.startsWith(".") ? extension : `.${extension}`;
  if (normalized.toLocaleLowerCase().endsWith(expected.toLocaleLowerCase())) {
    return normalized;
  }
  return `${normalized}${expected}`;
}

export async function chooseJsonSavePath(title: string, defaultPath: string): Promise<string | null> {
  const selected = await save({
    title,
    defaultPath,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });

  if (!selected) {
    return null;
  }
  return ensureExtension(selected, ".json");
}

export async function chooseJsonOpenPath(title: string): Promise<string | null> {
  const selected = await open({
    title,
    multiple: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!selected || Array.isArray(selected)) {
    return null;
  }
  return normalizePath(selected);
}

export async function writeTextToPath(path: string, content: string): Promise<void> {
  await invoke("write_text_file", {
    path: normalizePath(path),
    content,
  } satisfies TextFilePayload);
}

export async function readTextFromPath(path: string): Promise<string> {
  return invoke<string>("read_text_file", {
    path: normalizePath(path),
  } satisfies FilePathPayload);
}
