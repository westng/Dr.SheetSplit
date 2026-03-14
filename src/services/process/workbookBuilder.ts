import * as XLSX from "xlsx-js-style";
import type { EngineOutput, EngineSheetOutput } from "./types";

type SheetBuildResult = {
  matrix: string[][];
  headerRowIndex: number;
};

function ensureRow(matrix: string[][], rowIndex: number): string[] {
  while (matrix.length <= rowIndex) {
    matrix.push([]);
  }
  return matrix[rowIndex];
}

function writeRow(matrix: string[][], rowIndex: number, values: string[]): void {
  const row = ensureRow(matrix, rowIndex);
  for (let index = 0; index < values.length; index += 1) {
    row[index] = values[index] ?? "";
  }
}

function buildSheetMatrix(sheet: EngineSheetOutput): SheetBuildResult {
  const matrix: string[][] = [];
  let normalizedHeaderRowIndex = Math.max(1, Math.floor(sheet.headerRowIndex));
  if (sheet.titleEnabled) {
    normalizedHeaderRowIndex = Math.max(2, normalizedHeaderRowIndex);
  }

  let normalizedDataStartRowIndex = Math.max(
    normalizedHeaderRowIndex + 1,
    Math.floor(sheet.dataStartRowIndex),
  );
  if (sheet.titleEnabled) {
    normalizedDataStartRowIndex = Math.max(normalizedDataStartRowIndex, normalizedHeaderRowIndex + 1);
  }
  const normalizedFooterRows = Math.max(0, Math.floor(sheet.reservedFooterRows));

  if (sheet.titleEnabled) {
    writeRow(matrix, 0, [sheet.title || ""]);
  }

  writeRow(matrix, normalizedHeaderRowIndex - 1, sheet.headers);
  sheet.rows.forEach((rowValues, index) => {
    writeRow(matrix, normalizedDataStartRowIndex - 1 + index, rowValues);
  });

  const targetLength =
    normalizedDataStartRowIndex - 1 + sheet.rows.length + normalizedFooterRows;
  while (matrix.length < targetLength) {
    matrix.push([]);
  }

  return {
    matrix,
    headerRowIndex: normalizedHeaderRowIndex - 1,
  };
}

function applySheetMerges(worksheet: XLSX.WorkSheet, sheet: EngineSheetOutput): void {
  if (!sheet.titleEnabled || sheet.headers.length === 0) {
    return;
  }

  worksheet["!merges"] = [
    {
      s: { r: 0, c: 0 },
      e: { r: 0, c: Math.max(0, sheet.headers.length - 1) },
    },
  ];
}

function visualLength(value: string): number {
  let length = 0;
  for (const char of value) {
    length += /[\u0000-\u00ff]/.test(char) ? 1 : 2;
  }
  return length;
}

function inferColumnCount(matrix: string[][], headerCount: number): number {
  let maxCount = headerCount;
  for (const row of matrix) {
    if (row.length > maxCount) {
      maxCount = row.length;
    }
  }
  return maxCount;
}

function applyAutoColumnWidth(worksheet: XLSX.WorkSheet, matrix: string[][], headerCount: number): void {
  const columnCount = inferColumnCount(matrix, headerCount);
  if (columnCount <= 0) {
    return;
  }

  const widths = new Array<number>(columnCount).fill(8);
  for (const row of matrix) {
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cellText = String(row[columnIndex] ?? "");
      const longestLine = cellText
        .split(/\r?\n/g)
        .reduce((max, line) => Math.max(max, visualLength(line)), 0);
      widths[columnIndex] = Math.max(widths[columnIndex], longestLine + 2);
    }
  }

  worksheet["!cols"] = widths.map((width) => ({
    wch: Math.min(60, Math.max(8, width)),
  }));
}

function applyCellStyles(worksheet: XLSX.WorkSheet, headerRowIndex: number): void {
  const ref = worksheet["!ref"];
  if (!ref) {
    return;
  }

  const range = XLSX.utils.decode_range(ref);
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = worksheet[cellAddress];
      if (!cell) {
        continue;
      }

      const isHeader = row === headerRowIndex;
      cell.s = {
        alignment: {
          horizontal: "center",
          vertical: "center",
          wrapText: true,
        },
        ...(isHeader
          ? {
              font: {
                bold: true,
              },
            }
          : {}),
      };
    }
  }
}

export function buildWorkbookBinary(engineOutput: EngineOutput): Uint8Array {
  if (engineOutput.sheets.length === 0) {
    throw new Error("处理结果为空：未生成任何输出 Sheet。");
  }

  const workbook = XLSX.utils.book_new();

  for (const sheet of engineOutput.sheets) {
    const sheetBuild = buildSheetMatrix(sheet);
    const worksheet = XLSX.utils.aoa_to_sheet(sheetBuild.matrix);
    applyAutoColumnWidth(worksheet, sheetBuild.matrix, sheet.headers.length);
    applyCellStyles(worksheet, sheetBuild.headerRowIndex);
    applySheetMerges(worksheet, sheet);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  const arrayBuffer = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;

  return new Uint8Array(arrayBuffer);
}
