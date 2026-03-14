import Database from "@tauri-apps/plugin-sql";
import { ref } from "vue";
import {
  cloneRuleDefinition,
  createEmptyRuleDefinition,
  type RuleConditionalAggregateMode,
  type RuleDefinition,
  type RuleJoinDelimiter,
  type RuleOutputColumn,
  type RuleSheetTemplate,
  type RuleSheetTemplateVariableConfig,
  type RuleSheetTitleConflictMode,
  type RuleValueMode,
} from "../types/rule";

const RULE_DB_PATH = "sqlite:rules.db";
const RULE_TABLE_NAME = "split_rules";

type RuleRow = {
  id: string;
  payload: string;
};

const rules = ref<RuleDefinition[]>([]);
const isRuleStoreReady = ref(false);
const ruleStoreError = ref("");

let initPromise: Promise<void> | null = null;
let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(RULE_DB_PATH);
  }
  return dbPromise;
}

async function ensureSchema(): Promise<void> {
  const db = await getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${RULE_TABLE_NAME} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function normalizeRule(value: unknown): RuleDefinition | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<RuleDefinition>;
  const fallback = createEmptyRuleDefinition();

  if (typeof input.id !== "string" || !input.id.trim()) {
    return null;
  }

  const outputColumns = Array.isArray(input.outputColumns)
    ? input.outputColumns
        .filter((column): column is RuleDefinition["outputColumns"][number] => {
          if (!column || typeof column !== "object") {
            return false;
          }
          const item = column as Partial<RuleDefinition["outputColumns"][number]>;
          return typeof item.id === "string";
        })
        .map((column): RuleOutputColumn => ({
          id: column.id,
          targetField: String(column.targetField ?? ""),
          valueMode: normalizeValueMode(column.valueMode),
          sourceField: String(column.sourceField ?? ""),
          constantValue: String(column.constantValue ?? ""),
          mappingSection: String(column.mappingSection ?? "").trim(),
          conditionalJudgeField: String(column.conditionalJudgeField ?? "").trim(),
          conditionalMappingSection: String(column.conditionalMappingSection ?? "").trim(),
          conditionalHitTargetField: String(column.conditionalHitTargetField ?? "").trim(),
          conditionalMissTargetField: String(column.conditionalMissTargetField ?? "").trim(),
          conditionalValueSourceField: String(column.conditionalValueSourceField ?? "").trim(),
          conditionalAggregateMode: normalizeConditionalAggregateMode(column.conditionalAggregateMode),
          aggregateSourceField: String(column.aggregateSourceField ?? "").trim(),
          aggregateNumeratorField: String(column.aggregateNumeratorField ?? "").trim(),
          aggregateDenominatorField: String(column.aggregateDenominatorField ?? "").trim(),
          aggregateJoinSourceField: String(column.aggregateJoinSourceField ?? "").trim(),
          aggregateJoinDelimiter: normalizeJoinDelimiter(column.aggregateJoinDelimiter),
          copyFromTargetField: String(column.copyFromTargetField ?? "").trim(),
          dateSourceField: String(column.dateSourceField ?? "").trim(),
          dateOutputFormat: String(column.dateOutputFormat ?? "").trim() || "YYYY/M/D",
          expressionText: String(column.expressionText ?? ""),
        }))
    : fallback.outputColumns;

  const sheetTemplate = normalizeSheetTemplate(input.sheetTemplate, fallback.sheetTemplate);

  return {
    id: input.id,
    name: String(input.name ?? ""),
    description: String(input.description ?? ""),
    sourceFileName: String(input.sourceFileName ?? ""),
    sourceSheetName: String(input.sourceSheetName ?? ""),
    sourceHeaders: Array.isArray(input.sourceHeaders) ? input.sourceHeaders.map((item) => String(item)) : [],
    groupByFields: Array.isArray(input.groupByFields) ? input.groupByFields.map((item) => String(item)) : [],
    groupExcludeMode: normalizeGroupExcludeMode(input.groupExcludeMode),
    groupExcludeValuesText: String(input.groupExcludeValuesText ?? ""),
    groupExcludeMappingSection: String(input.groupExcludeMappingSection ?? "").trim(),
    summaryGroupByFields: Array.isArray(input.summaryGroupByFields)
      ? input.summaryGroupByFields.map((item) => String(item))
      : [...fallback.summaryGroupByFields],
    outputColumns,
    sheetTemplate,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : fallback.createdAt,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : fallback.updatedAt,
  };
}

function normalizeImportedRulesPayload(payload: unknown): RuleDefinition[] {
  if (Array.isArray(payload)) {
    return payload
      .map(normalizeRule)
      .filter((item): item is RuleDefinition => item !== null);
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  if (Array.isArray(objectPayload.rules)) {
    return objectPayload.rules
      .map(normalizeRule)
      .filter((item): item is RuleDefinition => item !== null);
  }

  const single = normalizeRule(payload);
  if (!single) {
    return [];
  }
  return [single];
}

function ensureImportedRuleIds(items: RuleDefinition[]): RuleDefinition[] {
  const usedIds = new Set<string>();
  return items.map((item) => {
    let nextId = item.id.trim();
    while (!nextId || usedIds.has(nextId)) {
      nextId = crypto.randomUUID();
    }
    usedIds.add(nextId);
    return {
      ...cloneRuleDefinition(item),
      id: nextId,
    };
  });
}

function normalizeValueMode(value: unknown): RuleValueMode {
  if (
    value === "constant" ||
    value === "mapping" ||
    value === "conditional_target" ||
    value === "aggregate_sum" ||
    value === "aggregate_sum_divide" ||
    value === "aggregate_join" ||
    value === "copy_output" ||
    value === "format_date" ||
    value === "expression"
  ) {
    return value;
  }
  return "source";
}

function normalizeConditionalAggregateMode(value: unknown): RuleConditionalAggregateMode {
  if (value === "sum" || value === "join_newline") {
    return value;
  }
  return "first";
}

function normalizeJoinDelimiter(value: unknown): RuleJoinDelimiter {
  if (value === "space") {
    return value;
  }
  return "newline";
}

function normalizeGroupExcludeMode(value: unknown): RuleDefinition["groupExcludeMode"] {
  if (value === "manual_values" || value === "mapping_group_source") {
    return value;
  }
  return "none";
}

function normalizeConflictMode(value: unknown): RuleSheetTitleConflictMode {
  if (
    value === "first" ||
    value === "last" ||
    value === "join_unique" ||
    value === "error" ||
    value === "placeholder"
  ) {
    return value;
  }
  return "first";
}

function normalizeVariableConfig(value: unknown): RuleSheetTemplateVariableConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<RuleSheetTemplateVariableConfig>;
  const variableKey = String(input.variableKey ?? "").trim();
  if (!variableKey) {
    return null;
  }

  return {
    variableKey,
    conflictMode: normalizeConflictMode(input.conflictMode),
    placeholderValue: String(input.placeholderValue ?? ""),
  };
}

function normalizePositiveInt(value: unknown, fallbackValue: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallbackValue;
  }
  return parsed;
}

function normalizeSheetTemplate(value: unknown, fallback: RuleSheetTemplate): RuleSheetTemplate {
  if (!value || typeof value !== "object") {
    return { ...fallback, variableConfigs: fallback.variableConfigs.map((config) => ({ ...config })) };
  }

  const input = value as Partial<RuleSheetTemplate>;
  return {
    titleEnabled: Boolean(input.titleEnabled),
    titleTemplate: String(input.titleTemplate ?? ""),
    variableConfigs: Array.isArray(input.variableConfigs)
      ? input.variableConfigs
          .map(normalizeVariableConfig)
          .filter((config): config is RuleSheetTemplateVariableConfig => config !== null)
      : [],
    headerRowIndex: Math.max(1, normalizePositiveInt(input.headerRowIndex, fallback.headerRowIndex)),
    dataStartRowIndex: Math.max(1, normalizePositiveInt(input.dataStartRowIndex, fallback.dataStartRowIndex)),
    reservedFooterRows: Math.max(0, normalizePositiveInt(input.reservedFooterRows, fallback.reservedFooterRows)),
  };
}

async function reloadRules(): Promise<void> {
  const db = await getDb();
  const rows = await db.select<RuleRow[]>(
    `SELECT id, payload FROM ${RULE_TABLE_NAME} ORDER BY datetime(updated_at) DESC`,
  );

  const parsed = rows
    .map((row) => {
      try {
        return normalizeRule(JSON.parse(row.payload));
      } catch {
        return null;
      }
    })
    .filter((item): item is RuleDefinition => item !== null);

  rules.value = parsed;
}

export function initializeRuleStore(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await ensureSchema();
      await reloadRules();
      ruleStoreError.value = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      ruleStoreError.value = message || "初始化本地规则数据库失败";
    } finally {
      isRuleStoreReady.value = true;
    }
  })();

  return initPromise;
}

export function useRuleStore() {
  void initializeRuleStore();

  async function saveRule(rule: RuleDefinition): Promise<RuleDefinition> {
    await ensureSchema();
    const db = await getDb();
    const now = new Date().toISOString();
    const existing = rules.value.find((item) => item.id === rule.id);
    const normalized: RuleDefinition = {
      ...cloneRuleDefinition(rule),
      createdAt: existing?.createdAt ?? rule.createdAt ?? now,
      updatedAt: now,
    };

    await db.execute(
      `
        INSERT INTO ${RULE_TABLE_NAME} (id, name, payload, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `,
      [
        normalized.id,
        normalized.name.trim() || "未命名规则",
        JSON.stringify(normalized),
        normalized.createdAt,
        normalized.updatedAt,
      ],
    );

    await reloadRules();
    return normalized;
  }

  async function deleteRule(ruleId: string): Promise<void> {
    await ensureSchema();
    const db = await getDb();
    await db.execute(`DELETE FROM ${RULE_TABLE_NAME} WHERE id = $1`, [ruleId]);
    await reloadRules();
  }

  async function replaceRulesByImport(payload: unknown): Promise<number> {
    await ensureSchema();
    const db = await getDb();
    const imported = ensureImportedRuleIds(normalizeImportedRulesPayload(payload));
    if (imported.length === 0) {
      throw new Error("导入失败：文件中未识别到有效规则数据。");
    }

    await db.execute(`DELETE FROM ${RULE_TABLE_NAME}`);
    for (const item of imported) {
      const normalized = normalizeRule(item);
      if (!normalized) {
        continue;
      }
      await db.execute(
        `
          INSERT INTO ${RULE_TABLE_NAME} (id, name, payload, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [
          normalized.id,
          normalized.name.trim() || "未命名规则",
          JSON.stringify(normalized),
          normalized.createdAt,
          normalized.updatedAt,
        ],
      );
    }

    await reloadRules();
    return imported.length;
  }

  function getRuleById(ruleId: string): RuleDefinition | null {
    const hit = rules.value.find((item) => item.id === ruleId);
    return hit ? cloneRuleDefinition(hit) : null;
  }

  return {
    rules,
    isRuleStoreReady,
    ruleStoreError,
    saveRule,
    deleteRule,
    replaceRulesByImport,
    getRuleById,
    reloadRules,
  };
}
