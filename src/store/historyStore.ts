import Database from "@tauri-apps/plugin-sql";
import { readonly, ref } from "vue";
import type {
  CreateTaskHistoryInput,
  TaskHistoryDetail,
  TaskHistoryLogItem,
  TaskHistoryResultPayload,
  TaskHistorySummary,
} from "../types/history";

const HISTORY_DB_PATH = "sqlite:history.db";
const HISTORY_TABLE_NAME = "task_history";
const HISTORY_RETENTION_DAYS = 7;
const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

type HistoryRow = {
  id: string;
  status: string;
  rule_id: string;
  rule_name: string;
  source_file_name: string;
  source_sheet_name: string;
  output_path: string;
  sheet_count: number;
  row_count: number;
  error_message: string;
  result_json: string;
  logs_json: string;
  started_at_ms: number;
  finished_at_ms: number;
  duration_ms: number;
  created_at_ms: number;
};

const histories = ref<TaskHistorySummary[]>([]);
const isHistoryStoreReady = ref(false);
const historyStoreError = ref("");

let initPromise: Promise<void> | null = null;
let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(HISTORY_DB_PATH);
  }
  return dbPromise;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

function normalizeLogs(value: unknown): TaskHistoryLogItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const candidate = item as Partial<TaskHistoryLogItem>;
      const message = String(candidate.message ?? "").trim();
      if (!message) {
        return null;
      }
      const level = candidate.level === "success" || candidate.level === "error" ? candidate.level : "info";
      return {
        id: String(candidate.id ?? crypto.randomUUID()),
        level,
        time: String(candidate.time ?? ""),
        message,
      } satisfies TaskHistoryLogItem;
    })
    .filter((item): item is TaskHistoryLogItem => item !== null);
}

function normalizeResultPayload(value: unknown): TaskHistoryResultPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as Partial<TaskHistoryResultPayload>;
  if (!input.engineOutput || typeof input.engineOutput !== "object") {
    return null;
  }
  return {
    outputPath: String(input.outputPath ?? ""),
    engineOutput: input.engineOutput,
  };
}

function toSummary(row: HistoryRow): TaskHistorySummary {
  return {
    id: row.id,
    status: row.status === "failed" ? "failed" : "success",
    ruleId: row.rule_id ?? "",
    ruleName: row.rule_name ?? "",
    sourceFileName: row.source_file_name ?? "",
    sourceSheetName: row.source_sheet_name ?? "",
    outputPath: row.output_path ?? "",
    sheetCount: toNumber(row.sheet_count),
    rowCount: toNumber(row.row_count),
    errorMessage: row.error_message ?? "",
    startedAtMs: toNumber(row.started_at_ms),
    finishedAtMs: toNumber(row.finished_at_ms),
    durationMs: toNumber(row.duration_ms),
    createdAtMs: toNumber(row.created_at_ms),
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toDetail(row: HistoryRow): TaskHistoryDetail {
  const summary = toSummary(row);
  return {
    ...summary,
    resultPayload: normalizeResultPayload(parseJson(row.result_json, null)),
    logs: normalizeLogs(parseJson(row.logs_json, [])),
  };
}

async function ensureSchema(): Promise<void> {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE_NAME} (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      source_file_name TEXT NOT NULL,
      source_sheet_name TEXT NOT NULL,
      output_path TEXT NOT NULL,
      sheet_count INTEGER NOT NULL,
      row_count INTEGER NOT NULL,
      error_message TEXT NOT NULL,
      result_json TEXT NOT NULL,
      logs_json TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_${HISTORY_TABLE_NAME}_created_at
    ON ${HISTORY_TABLE_NAME} (created_at_ms DESC)
  `);
}

async function pruneExpiredHistory(): Promise<void> {
  const db = await getDb();
  const threshold = Date.now() - HISTORY_RETENTION_MS;
  await db.execute(
    `DELETE FROM ${HISTORY_TABLE_NAME} WHERE created_at_ms < $1`,
    [threshold],
  );
}

async function reloadHistories(): Promise<void> {
  const db = await getDb();
  const rows = await db.select<HistoryRow[]>(
    `
      SELECT
        id,
        status,
        rule_id,
        rule_name,
        source_file_name,
        source_sheet_name,
        output_path,
        sheet_count,
        row_count,
        error_message,
        result_json,
        logs_json,
        started_at_ms,
        finished_at_ms,
        duration_ms,
        created_at_ms
      FROM ${HISTORY_TABLE_NAME}
      ORDER BY created_at_ms DESC
    `,
  );
  histories.value = rows.map(toSummary);
}

export function initializeHistoryStore(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await ensureSchema();
      await pruneExpiredHistory();
      await reloadHistories();
      historyStoreError.value = "";
    } catch (error) {
      historyStoreError.value = error instanceof Error ? error.message : String(error ?? "");
    } finally {
      isHistoryStoreReady.value = true;
    }
  })();

  return initPromise;
}

export function useHistoryStore() {
  void initializeHistoryStore();

  async function recordTask(input: CreateTaskHistoryInput): Promise<string> {
    await ensureSchema();
    const db = await getDb();
    const taskId = crypto.randomUUID();
    const createdAtMs = Date.now();
    const resultJson = JSON.stringify(input.resultPayload ?? null);
    const logsJson = JSON.stringify(normalizeLogs(input.logs));

    await db.execute(
      `
        INSERT INTO ${HISTORY_TABLE_NAME} (
          id,
          status,
          rule_id,
          rule_name,
          source_file_name,
          source_sheet_name,
          output_path,
          sheet_count,
          row_count,
          error_message,
          result_json,
          logs_json,
          started_at_ms,
          finished_at_ms,
          duration_ms,
          created_at_ms
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `,
      [
        taskId,
        input.status,
        input.ruleId.trim(),
        input.ruleName.trim() || "未命名规则",
        input.sourceFileName.trim(),
        input.sourceSheetName.trim(),
        input.outputPath.trim(),
        Math.max(0, Math.floor(input.sheetCount)),
        Math.max(0, Math.floor(input.rowCount)),
        input.errorMessage.trim(),
        resultJson,
        logsJson,
        Math.max(0, Math.floor(input.startedAtMs)),
        Math.max(0, Math.floor(input.finishedAtMs)),
        Math.max(0, Math.floor(input.durationMs)),
        createdAtMs,
      ],
    );

    await pruneExpiredHistory();
    await reloadHistories();
    return taskId;
  }

  async function clearHistory(): Promise<void> {
    await ensureSchema();
    const db = await getDb();
    await db.execute(`DELETE FROM ${HISTORY_TABLE_NAME}`);
    await reloadHistories();
  }

  async function deleteHistory(taskId: string): Promise<void> {
    await ensureSchema();
    const db = await getDb();
    await db.execute(`DELETE FROM ${HISTORY_TABLE_NAME} WHERE id = $1`, [taskId]);
    await reloadHistories();
  }

  async function getHistoryDetail(taskId: string): Promise<TaskHistoryDetail | null> {
    await ensureSchema();
    const db = await getDb();
    const rows = await db.select<HistoryRow[]>(
      `
        SELECT
          id,
          status,
          rule_id,
          rule_name,
          source_file_name,
          source_sheet_name,
          output_path,
          sheet_count,
          row_count,
          error_message,
          result_json,
          logs_json,
          started_at_ms,
          finished_at_ms,
          duration_ms,
          created_at_ms
        FROM ${HISTORY_TABLE_NAME}
        WHERE id = $1
        LIMIT 1
      `,
      [taskId],
    );
    if (rows.length === 0) {
      return null;
    }
    return toDetail(rows[0]);
  }

  async function reloadFromDisk(): Promise<void> {
    await ensureSchema();
    await pruneExpiredHistory();
    await reloadHistories();
  }

  return {
    histories: readonly(histories),
    isHistoryStoreReady: readonly(isHistoryStoreReady),
    historyStoreError: readonly(historyStoreError),
    recordTask,
    clearHistory,
    deleteHistory,
    getHistoryDetail,
    reloadFromDisk,
  };
}
