import * as XLSX from "xlsx";
import type { MappingEntry } from "../types/mapping";

const JSON_EXTENSIONS = new Set(["json"]);
const SHEET_EXTENSIONS = new Set(["xlsx", "xls", "csv"]);

const SOURCE_HEADER_KEYWORDS = ["source", "来源", "源", "key"];
const TARGET_HEADER_KEYWORDS = ["target", "目标", "值", "映射", "value", "result"];

export type MappingParserErrorCode =
  | "unsupported_file_type"
  | "invalid_json"
  | "missing_columns"
  | "empty_mapping_rows";

export class MappingParserError extends Error {
  constructor(
    public readonly code: MappingParserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MappingParserError";
  }
}

function getFileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === filename.length - 1) {
    return "";
  }
  return filename.slice(dotIndex + 1).toLowerCase();
}

function normalizeHeaderName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function containsKeyword(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function dedupeEntries(entries: MappingEntry[]): MappingEntry[] {
  const map = new Map<string, string>();
  for (const entry of entries) {
    map.set(entry.source, entry.target);
  }
  return Array.from(map, ([source, target]) => ({ source, target }));
}

function normalizePair(source: unknown, target: unknown): MappingEntry | null {
  const normalizedSource = String(source ?? "").trim();
  const normalizedTarget = String(target ?? "").trim();
  if (!normalizedSource || !normalizedTarget) {
    return null;
  }
  return {
    source: normalizedSource,
    target: normalizedTarget,
  };
}

function entriesFromMatrix(matrix: unknown[][]): MappingEntry[] {
  const rows = matrix
    .map((row) => row.map((cell) => String(cell ?? "").trim()))
    .filter((row) => row.some((cell) => cell.length > 0));

  if (rows.length === 0) {
    throw new MappingParserError("empty_mapping_rows", "No mapping rows found.");
  }

  const headers = rows[0].map(normalizeHeaderName);
  const sourceHeaderIndex = headers.findIndex((header) =>
    containsKeyword(header, SOURCE_HEADER_KEYWORDS),
  );
  const targetHeaderIndex = headers.findIndex((header) =>
    containsKeyword(header, TARGET_HEADER_KEYWORDS),
  );

  if (sourceHeaderIndex < 0 || targetHeaderIndex < 0 || sourceHeaderIndex === targetHeaderIndex) {
    throw new MappingParserError("missing_columns", "Missing source/target columns.");
  }

  const sourceIndex = sourceHeaderIndex;
  const targetIndex = targetHeaderIndex;
  const dataRows = rows.slice(1);

  const entries = dataRows
    .map((row) => normalizePair(row[sourceIndex], row[targetIndex]))
    .filter((row): row is MappingEntry => row !== null);

  if (entries.length === 0) {
    throw new MappingParserError("empty_mapping_rows", "No valid mapping rows found.");
  }

  return dedupeEntries(entries);
}

function entriesFromJson(payload: unknown): MappingEntry[] {
  if (Array.isArray(payload)) {
    const entries = payload
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }
        const objectItem = item as Record<string, unknown>;
        const source =
          objectItem.source ??
          objectItem.from ??
          objectItem.key ??
          objectItem["来源"];
        const target =
          objectItem.target ??
          objectItem.to ??
          objectItem.value ??
          objectItem["目标"];
        return normalizePair(source, target);
      })
      .filter((item): item is MappingEntry => item !== null);

    if (entries.length === 0) {
      throw new MappingParserError("empty_mapping_rows", "No valid mapping rows found.");
    }
    return dedupeEntries(entries);
  }

  if (payload && typeof payload === "object") {
    const entries = Object.entries(payload as Record<string, unknown>)
      .map(([source, target]) => normalizePair(source, target))
      .filter((item): item is MappingEntry => item !== null);

    if (entries.length === 0) {
      throw new MappingParserError("empty_mapping_rows", "No valid mapping rows found.");
    }
    return dedupeEntries(entries);
  }

  throw new MappingParserError("invalid_json", "Invalid JSON mapping payload.");
}

export async function parseMappingFile(file: File): Promise<MappingEntry[]> {
  const extension = getFileExtension(file.name);
  if (!JSON_EXTENSIONS.has(extension) && !SHEET_EXTENSIONS.has(extension)) {
    throw new MappingParserError("unsupported_file_type", "Unsupported mapping file type.");
  }

  if (JSON_EXTENSIONS.has(extension)) {
    try {
      const text = await file.text();
      return entriesFromJson(JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof MappingParserError) {
        throw error;
      }
      throw new MappingParserError("invalid_json", "Invalid JSON mapping payload.");
    }
  }

  const binary = await file.arrayBuffer();
  const workbook = XLSX.read(binary, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new MappingParserError("empty_mapping_rows", "No worksheet found.");
  }

  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
  });
  return entriesFromMatrix(matrix);
}
