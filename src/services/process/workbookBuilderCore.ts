import * as XLSX from "xlsx-js-style";
import type { EngineOutput, EngineSheetOutput } from "./types";
import { createEmptyEngineRuleStyleConfig } from "../../types/engineRule";

type SheetBuildResult = {
  matrix: string[][];
  headerRowIndex: number;
  groupHeaderRowIndex: number | null;
  dataStartRowIndex: number;
  dataRowCount: number;
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
  const hasGroupHeader =
    sheet.groupHeaderEnabled &&
    sheet.groupHeaderLabel.trim().length > 0 &&
    sheet.groupHeaderStartColumnIndex >= 0 &&
    sheet.groupHeaderStartColumnIndex < sheet.headers.length;
  let normalizedHeaderRowIndex = Math.max(1, Math.floor(sheet.headerRowIndex));
  if (sheet.titleEnabled) {
    normalizedHeaderRowIndex = Math.max(2, normalizedHeaderRowIndex);
  }
  if (hasGroupHeader) {
    normalizedHeaderRowIndex = Math.max(sheet.titleEnabled ? 3 : 2, normalizedHeaderRowIndex);
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

  let groupHeaderRowIndex: number | null = null;
  if (hasGroupHeader) {
    groupHeaderRowIndex = normalizedHeaderRowIndex - 2;
    const groupHeaderRow = new Array<string>(sheet.headers.length).fill("");
    for (let columnIndex = sheet.groupHeaderStartColumnIndex; columnIndex < sheet.headers.length; columnIndex += 1) {
      groupHeaderRow[columnIndex] = sheet.groupHeaderLabel;
    }
    writeRow(matrix, groupHeaderRowIndex, groupHeaderRow);
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
    groupHeaderRowIndex,
    dataStartRowIndex: normalizedDataStartRowIndex - 1,
    dataRowCount: sheet.rows.length,
  };
}

function applySheetMerges(
  worksheet: XLSX.WorkSheet,
  sheet: EngineSheetOutput,
): void {
  const merges: XLSX.Range[] = [];
  if (sheet.titleEnabled && sheet.headers.length > 0) {
    merges.push({
      s: { r: 0, c: 0 },
      e: { r: 0, c: Math.max(0, sheet.headers.length - 1) },
    });
  }
  if (merges.length > 0) {
    worksheet["!merges"] = merges;
  }
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

function estimateColumnPixelWidth(value: string, fontSize: number): number {
  const safeValue = String(value ?? "");
  const lines = safeValue.split(/\r?\n/g);
  const longestLineWidth = lines.reduce((max, line) => {
    const normalizedLength = visualLength(line);
    const asciiOnly = /^[\u0000-\u00ff]*$/.test(line);
    const charPixelWidth = asciiOnly ? 7 : 8.5;
    return Math.max(max, normalizedLength * charPixelWidth);
  }, 0);
  const fontScale = Math.max(1, fontSize / 11);
  const lineBreakPadding = lines.length > 1 ? 12 : 0;
  const contentPadding = safeValue.length === 0 ? 18 : 24;
  return Math.ceil(longestLineWidth * fontScale + lineBreakPadding + contentPadding);
}

function resolveCellFontSize(
  sheet: EngineSheetOutput,
  sheetBuild: SheetBuildResult,
  rowIndex: number,
): number {
  const styleConfig = sheet.styleConfig ?? createEmptyEngineRuleStyleConfig();
  const totalRowIndex =
    sheet.totalRowEnabled && sheetBuild.dataRowCount > 0
      ? sheetBuild.dataStartRowIndex + sheetBuild.dataRowCount - 1
      : null;
  if (sheet.titleEnabled && rowIndex === 0) {
    return styleConfig.title.fontSize;
  }
  if (rowIndex === sheetBuild.headerRowIndex || rowIndex === sheetBuild.groupHeaderRowIndex) {
    return styleConfig.header.fontSize;
  }
  if (totalRowIndex !== null && rowIndex === totalRowIndex) {
    return styleConfig.totalRow.fontSize;
  }
  return styleConfig.data.fontSize;
}

function applyAutoColumnWidth(
  worksheet: XLSX.WorkSheet,
  matrix: string[][],
  sheet: EngineSheetOutput,
  sheetBuild: SheetBuildResult,
): void {
  const columnCount = inferColumnCount(matrix, sheet.headers.length);
  if (columnCount <= 0) {
    return;
  }

  const widths = new Array<number>(columnCount).fill(88);
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    if (sheet.titleEnabled && rowIndex === 0) {
      continue;
    }
    const row = matrix[rowIndex] ?? [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const cellText = String(row[columnIndex] ?? "");
      const fontSize = resolveCellFontSize(sheet, sheetBuild, rowIndex);
      const pixelWidth = estimateColumnPixelWidth(cellText, fontSize);
      widths[columnIndex] = Math.max(widths[columnIndex], pixelWidth);
    }
  }

  worksheet["!cols"] = widths.map((pixelWidth) => {
    const clampedPixelWidth = Math.min(560, Math.max(88, pixelWidth));
    const characterWidth = Number((clampedPixelWidth / 7).toFixed(2));
    return {
      width: characterWidth,
      wch: characterWidth,
      wpx: clampedPixelWidth,
      MDW: 7,
    };
  });
}

function normalizeHexColor(color: string): string | null {
  const normalized = color.trim().replace(/^#/, "");
  if (!normalized) {
    return null;
  }
  if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return normalized.toUpperCase();
  }
  if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
    return normalized
      .split("")
      .map((char) => `${char}${char}`)
      .join("")
      .toUpperCase();
  }
  return null;
}

function buildCellStyle(
  styleToken: NonNullable<EngineSheetOutput["styleConfig"]>[keyof NonNullable<EngineSheetOutput["styleConfig"]>],
): XLSX.CellStyle {
  const textColor = normalizeHexColor(styleToken.textColor);
  const backgroundColor = normalizeHexColor(styleToken.backgroundColor);
  return {
    alignment: {
      horizontal: styleToken.horizontalAlign,
      vertical: "center",
      wrapText: true,
    },
    border: {
      top: { style: "thin", color: { rgb: "000000" } },
      right: { style: "thin", color: { rgb: "000000" } },
      bottom: { style: "thin", color: { rgb: "000000" } },
      left: { style: "thin", color: { rgb: "000000" } },
    },
    font: {
      bold: styleToken.bold,
      sz: styleToken.fontSize,
      ...(textColor ? { color: { rgb: textColor } } : {}),
    },
    ...(backgroundColor
      ? {
          fill: {
            patternType: "solid",
            fgColor: { rgb: backgroundColor },
            bgColor: { rgb: backgroundColor },
          },
        }
      : {}),
  };
}

function applyCellStyles(
  worksheet: XLSX.WorkSheet,
  sheet: EngineSheetOutput,
  sheetBuild: SheetBuildResult,
): void {
  const ref = worksheet["!ref"];
  if (!ref) {
    return;
  }

  const styleConfig = sheet.styleConfig ?? createEmptyEngineRuleStyleConfig();

  const range = XLSX.utils.decode_range(ref);
  const titleStyle = buildCellStyle(styleConfig.title);
  const headerStyle = buildCellStyle(styleConfig.header);
  const dataStyle = buildCellStyle(styleConfig.data);
  const totalRowStyle = buildCellStyle(styleConfig.totalRow);
  const totalRowIndex =
    sheet.totalRowEnabled && sheetBuild.dataRowCount > 0
      ? sheetBuild.dataStartRowIndex + sheetBuild.dataRowCount - 1
      : null;
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: column });
      const cell = worksheet[cellAddress] ?? { t: "s", v: "" };
      if (!worksheet[cellAddress]) {
        worksheet[cellAddress] = cell;
      }

      const isHeader = row === sheetBuild.headerRowIndex;
      const isTitle = sheet.titleEnabled && row === 0;
      const isGroupHeader = sheetBuild.groupHeaderRowIndex !== null && row === sheetBuild.groupHeaderRowIndex;
      const isTotalRow = totalRowIndex !== null && row === totalRowIndex;
      cell.s = isTitle
        ? titleStyle
        : isHeader || isGroupHeader
          ? headerStyle
          : isTotalRow
            ? totalRowStyle
            : dataStyle;
    }
  }
}

export function buildWorkbookBinarySync(engineOutput: EngineOutput): Uint8Array {
  if (engineOutput.sheets.length === 0) {
    throw new Error("处理结果为空：未生成任何输出 Sheet。");
  }

  const workbook = XLSX.utils.book_new();

  for (const sheet of engineOutput.sheets) {
    const sheetBuild = buildSheetMatrix(sheet);
    const worksheet = XLSX.utils.aoa_to_sheet(sheetBuild.matrix);
    applyAutoColumnWidth(worksheet, sheetBuild.matrix, sheet, sheetBuild);
    applyCellStyles(worksheet, sheet, sheetBuild);
    applySheetMerges(worksheet, sheet);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  const arrayBuffer = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;

  return new Uint8Array(arrayBuffer);
}
