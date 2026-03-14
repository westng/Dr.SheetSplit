import * as XLSX from "xlsx";
import type { EngineOutput, EngineSheetOutput } from "./types";

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

function buildSheetMatrix(sheet: EngineSheetOutput): string[][] {
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

  return matrix;
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

export function buildWorkbookBinary(engineOutput: EngineOutput): Uint8Array {
  if (engineOutput.sheets.length === 0) {
    throw new Error("处理结果为空：未生成任何输出 Sheet。");
  }

  const workbook = XLSX.utils.book_new();

  for (const sheet of engineOutput.sheets) {
    const matrix = buildSheetMatrix(sheet);
    const worksheet = XLSX.utils.aoa_to_sheet(matrix);
    applySheetMerges(worksheet, sheet);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  const arrayBuffer = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;

  return new Uint8Array(arrayBuffer);
}
