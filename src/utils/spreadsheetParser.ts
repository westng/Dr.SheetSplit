import * as XLSX from "xlsx";

export type SpreadsheetSheetPreview = {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
  sampleRows: Record<string, string>[];
  rowCount: number;
};

export type SpreadsheetPreview = {
  fileName: string;
  sheets: SpreadsheetSheetPreview[];
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

function parseSheet(workbook: XLSX.WorkBook, sheetName: string): SpreadsheetSheetPreview {
  const worksheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });

  if (rawRows.length === 0) {
    return {
      name: sheetName,
      headers: [],
      rows: [],
      sampleRows: [],
      rowCount: 0,
    };
  }

  const headerRow = Array.isArray(rawRows[0]) ? rawRows[0] : [];
  const headers = headerRow.map((cell, index) => normalizeHeader(cell, index));
  const dataRows = rawRows.slice(1);
  const normalizedRows = dataRows.map((row) => {
    const values = Array.isArray(row) ? row : [];
    const normalized: Record<string, string> = {};
    headers.forEach((header, index) => {
      normalized[header] = toDisplayValue(values[index]);
    });
    return normalized;
  });
  const sampleRows = normalizedRows.slice(0, 30);

  return {
    name: sheetName,
    headers,
    rows: normalizedRows,
    sampleRows,
    rowCount: normalizedRows.length,
  };
}

export async function parseSpreadsheetFile(file: File): Promise<SpreadsheetPreview> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellDates: false,
  });

  const sheets = workbook.SheetNames.map((sheetName) => parseSheet(workbook, sheetName));
  return {
    fileName: file.name,
    sheets,
  };
}
