import type { RuleDefinition } from "../../types/rule";
import type { EngineRuleStyleConfig } from "../../types/engineRule";

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
  sheet?: ProcessSheetInput;
  datasetId?: string;
  sourceFilePath?: string;
  sourceSheetName?: string;
  sourceFileName: string;
  exportDirectory: string;
  unmatchedFallback: string;
};

export type ProcessTaskStage =
  | "prepare_data"
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
  totalRowEnabled?: boolean;
  groupHeaderEnabled: boolean;
  groupHeaderLabel: string;
  groupHeaderStartColumnIndex: number;
  headerRowIndex: number;
  dataStartRowIndex: number;
  reservedFooterRows: number;
  headers: string[];
  rows: string[][];
  styleConfig?: EngineRuleStyleConfig;
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
  engineOutput: EngineOutput;
};
