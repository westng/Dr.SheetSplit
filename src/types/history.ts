import type { EngineOutput } from "../services/process/types";

export type TaskHistoryStatus = "success" | "failed";

export type TaskHistoryLogLevel = "info" | "success" | "error";

export type TaskHistoryLogItem = {
  id: string;
  level: TaskHistoryLogLevel;
  time: string;
  message: string;
};

export type TaskHistoryResultPayload = {
  outputPath: string;
  engineOutput: EngineOutput;
};

export type TaskHistorySummary = {
  id: string;
  status: TaskHistoryStatus;
  ruleId: string;
  ruleName: string;
  sourceFileName: string;
  sourceSheetName: string;
  outputPath: string;
  sheetCount: number;
  rowCount: number;
  errorMessage: string;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  createdAtMs: number;
};

export type TaskHistoryDetail = TaskHistorySummary & {
  resultPayload: TaskHistoryResultPayload | null;
  logs: TaskHistoryLogItem[];
};

export type CreateTaskHistoryInput = {
  status: TaskHistoryStatus;
  ruleId: string;
  ruleName: string;
  sourceFileName: string;
  sourceSheetName: string;
  outputPath: string;
  sheetCount: number;
  rowCount: number;
  errorMessage: string;
  resultPayload: TaskHistoryResultPayload | null;
  logs: TaskHistoryLogItem[];
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
};
