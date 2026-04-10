import type { EngineRuleStyleConfig } from "../../types/engineRule";

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
