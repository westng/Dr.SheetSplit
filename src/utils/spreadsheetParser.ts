import { invoke } from "@tauri-apps/api/core";
import * as XLSX from "xlsx";
import { basenameFromPath } from "./nativeFile";

export type SpreadsheetSheetPreview = {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  sampleRows: Record<string, string>[];
  rowCount: number;
};

export type SpreadsheetSheetData = {
  name: string;
  rawRows: string[][];
  rowCount: number;
  dataMode: "header" | "preview" | "full";
};

export type SpreadsheetSheetSummary = {
  name: string;
  rowCount: number;
  columnCount: number;
  previewRowCount: number;
};

export type SpreadsheetPreview = {
  datasetId: string;
  fileName: string;
  importedAtMs: number;
  sheets: SpreadsheetSheetSummary[];
};

export type SpreadsheetSheetPage = {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
};

const DATE_HEADER_PATTERN = /^\d{8}$/;

type SpreadsheetDatasetImportResponse = {
  datasetId: string;
  fileName: string;
  importedAtMs: number;
  sheets: SpreadsheetSheetSummary[];
};

type SpreadsheetDatasetSheetRowsResponse = {
  name: string;
  rawRows: string[][];
  rowCount: number;
  dataMode?: "header" | "preview" | "full";
};

type SpreadsheetDatasetSheetPageResponse = {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
};

type ParsedSpreadsheetSheetInput = {
  name: string;
  rawRows: string[][];
};

export type SpreadsheetSheetHeaderLayout = {
  headerRowIndex: number;
  groupHeaderRowIndex: number;
};

function normalizeHeader(value: unknown, index: number): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return `Column_${index + 1}`;
  }
  return text;
}

function toDisplayValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return String(value);
}

function countDateHeaders(row: string[]): number {
  return row.reduce((count, cell) => (DATE_HEADER_PATTERN.test(String(cell ?? "").trim()) ? count + 1 : count), 0);
}

function normalizeSheetRows(input: SpreadsheetDatasetSheetRowsResponse): SpreadsheetSheetData {
  return {
    name: String(input.name ?? "").trim(),
    rawRows: Array.isArray(input.rawRows)
      ? input.rawRows.map((row) =>
          Array.isArray(row) ? row.map((cell) => toDisplayValue(cell)) : [],
        )
      : [],
    rowCount: Number(input.rowCount ?? 0),
    dataMode: input.dataMode === "preview" || input.dataMode === "full" ? input.dataMode : "header",
  };
}

function normalizePreview(input: SpreadsheetDatasetImportResponse): SpreadsheetPreview {
  return {
    datasetId: String(input.datasetId ?? "").trim(),
    fileName: String(input.fileName ?? "").trim(),
    importedAtMs: Number(input.importedAtMs ?? 0),
    sheets: Array.isArray(input.sheets)
      ? input.sheets.map((sheet) => ({
          name: String(sheet.name ?? "").trim(),
          rowCount: Number(sheet.rowCount ?? 0),
          columnCount: Number(sheet.columnCount ?? 0),
          previewRowCount: Number(sheet.previewRowCount ?? 0),
        }))
      : [],
  };
}

function normalizeSheetPage(input: SpreadsheetDatasetSheetPageResponse): SpreadsheetSheetPage {
  return {
    name: String(input.name ?? "").trim(),
    headers: Array.isArray(input.headers)
      ? input.headers.map((header) => String(header ?? "").trim()).filter(Boolean)
      : [],
    rows: Array.isArray(input.rows)
      ? input.rows.map((row) =>
          row && typeof row === "object"
            ? Object.fromEntries(
                Object.entries(row).map(([key, value]) => [String(key).trim(), toDisplayValue(value)]),
              )
            : {},
        )
      : [],
    rowCount: Number(input.rowCount ?? 0),
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeParsedMatrix(matrix: unknown[][]): string[][] {
  return matrix.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => toDisplayValue(cell))
      : [],
  );
}

function buildParsedWorkbookPayload(fileName: string, workbook: XLSX.WorkBook): {
  fileName: string;
  sheets: ParsedSpreadsheetSheetInput[];
} {
  return {
    fileName,
    sheets: workbook.SheetNames.map((sheetName) => ({
      name: String(sheetName ?? "").trim(),
      rawRows: normalizeParsedMatrix(
        XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
          header: 1,
          raw: false,
          defval: "",
          blankrows: true,
        }),
      ),
    })),
  };
}

async function readBinaryFileBase64(path: string): Promise<string> {
  return invoke<string>("read_binary_file_base64", {
    path,
  });
}

export function inferSheetHeaderLayout(sheet: SpreadsheetSheetData): SpreadsheetSheetHeaderLayout {
  const firstRow = Array.isArray(sheet.rawRows[0]) ? sheet.rawRows[0] : [];
  const secondRow = Array.isArray(sheet.rawRows[1]) ? sheet.rawRows[1] : [];
  const secondRowDateCount = countDateHeaders(secondRow);

  if (secondRowDateCount >= 2) {
    const repeatedGroupCount = firstRow.reduce((count, cell, index, source) => {
      const text = String(cell ?? "").trim();
      if (!text) {
        return count;
      }
      return source.indexOf(text) !== index ? count + 1 : count;
    }, 0);
    if (repeatedGroupCount > 0) {
      return {
        headerRowIndex: 2,
        groupHeaderRowIndex: 1,
      };
    }
  }

  return {
    headerRowIndex: 1,
    groupHeaderRowIndex: 0,
  };
}

export function buildSheetPreview(
  sheet: SpreadsheetSheetData,
  options: {
    headerRowIndex?: number;
    groupHeaderRowIndex?: number;
    groupName?: string;
  } = {},
): SpreadsheetSheetPreview {
  const parsedHeaderRowIndex = Number(options.headerRowIndex ?? 1);
  const normalizedHeaderRowIndex =
    Number.isInteger(parsedHeaderRowIndex) && parsedHeaderRowIndex > 0
      ? parsedHeaderRowIndex
      : 1;
  const parsedGroupHeaderRowIndex = Number(options.groupHeaderRowIndex ?? 0);
  const normalizedGroupHeaderRowIndex =
    Number.isInteger(parsedGroupHeaderRowIndex) && parsedGroupHeaderRowIndex > 0
      ? parsedGroupHeaderRowIndex
      : 0;
  const headerRow = Array.isArray(sheet.rawRows[normalizedHeaderRowIndex - 1])
    ? sheet.rawRows[normalizedHeaderRowIndex - 1]
    : [];
  const groupHeaderRow =
    normalizedGroupHeaderRowIndex > 0 && Array.isArray(sheet.rawRows[normalizedGroupHeaderRowIndex - 1])
      ? sheet.rawRows[normalizedGroupHeaderRowIndex - 1]
      : [];
  const selectedGroupName = String(options.groupName ?? "").trim();
  const columnCount = Math.max(headerRow.length, groupHeaderRow.length);
  const usedHeaders = new Set<string>();
  const columns: Array<{ sourceIndex: number; header: string }> = [];

  for (let index = 0; index < columnCount; index += 1) {
    const childHeader = String(headerRow[index] ?? "").trim();
    const groupHeader = String(groupHeaderRow[index] ?? "").trim();
    const isDateHeader = DATE_HEADER_PATTERN.test(childHeader);
    if (selectedGroupName && isDateHeader && groupHeader !== selectedGroupName) {
      continue;
    }

    let nextHeader = normalizeHeader(childHeader, index);
    if (!selectedGroupName && isDateHeader && groupHeader) {
      nextHeader = `${groupHeader}__${childHeader}`;
    }

    const baseHeader = nextHeader;
    let suffix = 2;
    while (usedHeaders.has(nextHeader)) {
      nextHeader = `${baseHeader}_${suffix}`;
      suffix += 1;
    }
    usedHeaders.add(nextHeader);
    columns.push({
      sourceIndex: index,
      header: nextHeader,
    });
  }

  const headers = columns.map((column) => column.header);
  if (sheet.dataMode === "header") {
    return {
      name: sheet.name,
      headers,
      rows: [],
      sampleRows: [],
      rowCount: 0,
    };
  }

  const dataRows = sheet.rawRows.slice(normalizedHeaderRowIndex);
  const normalizedRows = dataRows.map((row) => {
    const values = Array.isArray(row) ? row : [];
    const normalized: Record<string, string> = {};
    columns.forEach((column) => {
      normalized[column.header] = toDisplayValue(values[column.sourceIndex]);
    });
    return normalized;
  });
  return {
    name: sheet.name,
    headers,
    rows: normalizedRows,
    sampleRows: normalizedRows.slice(0, 30),
    rowCount: typeof sheet.rowCount === "number" && sheet.rowCount > 0
      ? Math.max(0, sheet.rowCount - normalizedHeaderRowIndex)
      : normalizedRows.length,
  };
}

export function extractSheetGroupOptions(
  sheet: SpreadsheetSheetData,
  options: {
    headerRowIndex?: number;
    groupHeaderRowIndex?: number;
  } = {},
): string[] {
  const parsedHeaderRowIndex = Number(options.headerRowIndex ?? 1);
  const normalizedHeaderRowIndex =
    Number.isInteger(parsedHeaderRowIndex) && parsedHeaderRowIndex > 0
      ? parsedHeaderRowIndex
      : 1;
  const parsedGroupHeaderRowIndex = Number(options.groupHeaderRowIndex ?? 0);
  const normalizedGroupHeaderRowIndex =
    Number.isInteger(parsedGroupHeaderRowIndex) && parsedGroupHeaderRowIndex > 0
      ? parsedGroupHeaderRowIndex
      : 0;
  if (normalizedGroupHeaderRowIndex <= 0) {
    return [];
  }

  const headerRow = Array.isArray(sheet.rawRows[normalizedHeaderRowIndex - 1])
    ? sheet.rawRows[normalizedHeaderRowIndex - 1]
    : [];
  const groupHeaderRow = Array.isArray(sheet.rawRows[normalizedGroupHeaderRowIndex - 1])
    ? sheet.rawRows[normalizedGroupHeaderRowIndex - 1]
    : [];
  const result = new Set<string>();
  const columnCount = Math.max(headerRow.length, groupHeaderRow.length);
  for (let index = 0; index < columnCount; index += 1) {
    const childHeader = String(headerRow[index] ?? "").trim();
    const groupHeader = String(groupHeaderRow[index] ?? "").trim();
    if (!groupHeader || !DATE_HEADER_PATTERN.test(childHeader)) {
      continue;
    }
    result.add(groupHeader);
  }

  return Array.from(result);
}

export async function parseSpreadsheetFile(file: File): Promise<SpreadsheetPreview> {
  const buffer = await file.arrayBuffer();
  const payload = await invoke<SpreadsheetDatasetImportResponse>("import_spreadsheet_dataset", {
    fileName: file.name,
    contentBase64: arrayBufferToBase64(buffer),
  });
  return normalizePreview(payload);
}

export async function parseSpreadsheetPath(filePath: string): Promise<SpreadsheetPreview> {
  const contentBase64 = await readBinaryFileBase64(filePath);
  const workbook = XLSX.read(contentBase64, {
    type: "base64",
  });
  const payload = await invoke<SpreadsheetDatasetImportResponse>("import_parsed_spreadsheet_dataset", buildParsedWorkbookPayload(
    basenameFromPath(filePath) || filePath,
    workbook,
  ));
  return normalizePreview(payload);
}

export async function inspectSpreadsheetPath(filePath: string): Promise<SpreadsheetPreview> {
  return parseSpreadsheetPath(filePath);
}

export async function readSpreadsheetSheetPreview(
  datasetId: string,
  sheetName: string,
): Promise<SpreadsheetSheetData> {
  const payload = await invoke<SpreadsheetDatasetSheetRowsResponse>("read_dataset_sheet_preview", {
    datasetId,
    sheetName,
  });
  return normalizeSheetRows(payload);
}

export async function readSpreadsheetSheetHeader(
  datasetId: string,
  sheetName: string,
): Promise<SpreadsheetSheetData> {
  const payload = await invoke<SpreadsheetDatasetSheetRowsResponse>("read_dataset_sheet_header", {
    datasetId,
    sheetName,
  });
  return normalizeSheetRows(payload);
}

export async function readSpreadsheetSheetHeaderFromPath(
  filePath: string,
  sheetName: string,
): Promise<SpreadsheetSheetData> {
  const payload = await invoke<SpreadsheetDatasetSheetRowsResponse>("read_spreadsheet_sheet_header_from_path", {
    filePath,
    sheetName,
  });
  return normalizeSheetRows(payload);
}

export async function readSpreadsheetSheetRows(
  datasetId: string,
  sheetName: string,
): Promise<SpreadsheetSheetData> {
  const payload = await invoke<SpreadsheetDatasetSheetRowsResponse>("read_dataset_sheet_rows", {
    datasetId,
    sheetName,
  });
  return normalizeSheetRows(payload);
}

export async function readSpreadsheetSheetPage(
  datasetId: string,
  sheetName: string,
  headerRowIndex: number,
  groupHeaderRowIndex: number,
  offset: number,
  limit: number,
): Promise<SpreadsheetSheetPage> {
  const payload = await invoke<SpreadsheetDatasetSheetPageResponse>("read_dataset_sheet_page", {
    datasetId,
    sheetName,
    headerRowIndex,
    groupHeaderRowIndex,
    offset,
    limit,
  });
  return normalizeSheetPage(payload);
}

export async function startSpreadsheetInspectJob(
  sourceId: string,
  filePath: string,
  preferredSheetName: string,
): Promise<string> {
  return invoke<string>("start_source_inspect_job", {
    sourceId,
    filePath,
    preferredSheetName,
  });
}
