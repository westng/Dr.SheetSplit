import { invoke } from "@tauri-apps/api/core";
import { getText } from "../utils/http";

const SLOGAN_API_URL =
  "https://api.southerly.top/api/yiyan?msg=%E8%AF%97%E8%AF%8D&output=json";

function normalize(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseSlogan(payload: unknown): string | null {
  const direct = normalize(payload);
  if (direct) {
    return direct;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as Record<string, unknown>;
  const candidates = [
    data.data,
    data.content,
    data.text,
    data.result,
    data.msg,
    data.hitokoto,
    data.yiyan,
  ];

  for (const candidate of candidates) {
    const text = normalize(candidate);
    if (text) {
      return text;
    }

    if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      const nestedText =
        normalize(nested.content) ??
        normalize(nested.text) ??
        normalize(nested.result) ??
        normalize(nested.msg);
      if (nestedText) {
        return nestedText;
      }
    }
  }

  return null;
}

export async function fetchSloganApi(): Promise<string> {
  try {
    const text = await invoke<string>("fetch_slogan");
    const normalized = text.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  } catch {
    // Fall through to fetch fallback below.
  }

  const body = await getText(SLOGAN_API_URL);
  const payload =
    (() => {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return body;
      }
    })();
  const parsed = parseSlogan(payload);
  if (!parsed) {
    throw new Error("invalid slogan payload");
  }
  return parsed;
}
