import { invoke } from "@tauri-apps/api/core";
import type { EngineOutput, EngineSheetOutput, ProcessTaskInput } from "./types";

type EngineFailure = {
  ok?: boolean;
  error?: string;
};

function isEngineSheetOutput(value: unknown): value is EngineSheetOutput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const input = value as Partial<EngineSheetOutput>;
  return (
    typeof input.name === "string" &&
    typeof input.title === "string" &&
    typeof input.titleEnabled === "boolean" &&
    (typeof input.totalRowEnabled === "boolean" || typeof input.totalRowEnabled === "undefined") &&
    typeof input.groupHeaderEnabled === "boolean" &&
    typeof input.groupHeaderLabel === "string" &&
    typeof input.groupHeaderStartColumnIndex === "number" &&
    typeof input.headerRowIndex === "number" &&
    typeof input.dataStartRowIndex === "number" &&
    typeof input.reservedFooterRows === "number" &&
    Array.isArray(input.headers) &&
    Array.isArray(input.rows)
  );
}

function normalizeEngineOutput(value: unknown): EngineOutput {
  if (!value || typeof value !== "object") {
    throw new Error("处理引擎返回格式无效。");
  }

  const payload = value as Record<string, unknown> & EngineFailure;
  if (payload.ok === false) {
    throw new Error(asErrorMessage(payload.error));
  }
  if (payload.ok !== true) {
    throw new Error("处理引擎返回缺少 ok 标记。");
  }
  const sheets = payload.sheets;
  if (!Array.isArray(sheets) || !sheets.every(isEngineSheetOutput)) {
    throw new Error("处理引擎返回的 Sheet 数据无效。");
  }

  return {
    ok: true,
    sheetCount: Number(payload.sheetCount ?? sheets.length),
    rowCount: Number(payload.rowCount ?? 0),
    sheets,
  };
}

function asErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized) {
      return normalized;
    }
  }
  return "处理引擎执行失败。";
}

function getUnknownErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    const normalized = error.trim();
    if (normalized) {
      return normalized;
    }
  }

  if (error instanceof Error) {
    const normalized = error.message.trim();
    if (normalized) {
      return normalized;
    }
  }

  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    for (const key of ["message", "error", "details", "reason", "data"]) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    try {
      const serialized = JSON.stringify(candidate);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      return "处理引擎执行失败。";
    }
  }

  return "处理引擎执行失败。";
}

export async function runPythonTransform(input: ProcessTaskInput): Promise<EngineOutput> {
  let rawResult = "";
  try {
    if (input.datasetId && input.sourceSheetName) {
      rawResult = await invoke<string>("run_python_transform_for_dataset", {
        payload: JSON.stringify({
          rule: input.rule,
          mappingGroups: input.mappingGroups,
          sourceFileName: input.sourceFileName,
          exportDirectory: input.exportDirectory,
          unmatchedFallback: input.unmatchedFallback,
        }),
        datasetId: input.datasetId,
        sheetName: input.sourceSheetName,
      });
    } else if (input.sourceFilePath && input.sourceSheetName) {
      rawResult = await invoke<string>("run_python_transform_for_path", {
        payload: JSON.stringify({
          rule: input.rule,
          mappingGroups: input.mappingGroups,
          sourceFileName: input.sourceFileName,
          exportDirectory: input.exportDirectory,
          unmatchedFallback: input.unmatchedFallback,
        }),
        filePath: input.sourceFilePath,
        sheetName: input.sourceSheetName,
      });
    } else {
      rawResult = await invoke<string>("run_python_transform", {
        payload: JSON.stringify(input),
      });
    }
  } catch (error) {
    throw new Error(`调用 Python 转换引擎失败：${getUnknownErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    const preview = rawResult.trim().slice(0, 220);
    throw new Error(`处理引擎返回了不可解析的数据：${preview || "(空响应)"}`);
  }

  return normalizeEngineOutput(parsed);
}
