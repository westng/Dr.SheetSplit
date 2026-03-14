import type { RuleDefinition } from "../../types/rule";

export type ProcessSheetInput = {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
};

export type ProcessTaskInput = {
  rule: RuleDefinition;
  mappingGroups: ReadonlyArray<{
    id: string;
    entries: ReadonlyArray<{
      readonly source: string;
      readonly target: string;
    }>;
  }>;
  sheet: ProcessSheetInput;
  sourceFileName: string;
  exportDirectory: string;
  unmatchedFallback: string;
};

export type ProcessTaskStage =
  | "invoke_engine"
  | "build_workbook"
  | "resolve_output_path"
  | "write_output_file";

export type ProcessTaskOptions = {
  onStage?: (stage: ProcessTaskStage) => void;
};

export type EngineSheetOutput = {
  name: string;
  title: string;
  titleEnabled: boolean;
  headerRowIndex: number;
  dataStartRowIndex: number;
  reservedFooterRows: number;
  headers: string[];
  rows: string[][];
};

export type EngineOutput = {
  ok: true;
  sheetCount: number;
  rowCount: number;
  sheets: EngineSheetOutput[];
};

export type ProcessTaskResult = {
  outputPath: string;
  sheetCount: number;
  rowCount: number;
};
