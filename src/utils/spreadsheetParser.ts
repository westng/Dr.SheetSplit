import * as XLSX from "xlsx";

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
};

export type SpreadsheetPreview = {
  fileName: string;
  sheets: SpreadsheetSheetData[];
};

const DATE_HEADER_PATTERN = /^\d{8}$/;

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

function parseSheet(workbook: XLSX.WorkBook, sheetName: string): SpreadsheetSheetData {
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
      rawRows: [],
    };
  }

  return {
    name: sheetName,
    rawRows: rawRows.map((row) =>
      Array.isArray(row) ? row.map((cell) => toDisplayValue(cell)) : [],
    ),
  };
}

function countDateHeaders(row: string[]): number {
  return row.reduce((count, cell) => (DATE_HEADER_PATTERN.test(String(cell ?? "").trim()) ? count + 1 : count), 0);
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
    rowCount: normalizedRows.length,
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
