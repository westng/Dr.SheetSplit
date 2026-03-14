import { load } from "@tauri-apps/plugin-store";
import { readonly, ref } from "vue";
import { DEFAULT_MAPPING_DATA } from "../constants/mappingDefaults";
import {
  LEGACY_MAPPING_SECTION_IDS,
  type LegacyMappingData,
  type MappingEntry,
  type MappingGroup,
} from "../types/mapping";

const STORE_FILE = "settings.json";
const STORE_KEY = "mappingGroups";
const LEGACY_STORE_KEY = "mappingData";
const LEGACY_LOCAL_STORAGE_KEY = "settings.mappingData";

const mappingGroups = ref<MappingGroup[]>([]);
const isMappingStoreReady = ref(false);

let initialized = false;
let initPromise: Promise<void> | null = null;
let persistQueue: Promise<void> = Promise.resolve();

function cloneEntries(entries: readonly MappingEntry[]): MappingEntry[] {
  return entries.map((item) => ({ source: item.source, target: item.target }));
}

function cloneGroup(group: MappingGroup): MappingGroup {
  return {
    ...group,
    entries: cloneEntries(group.entries),
  };
}

function normalizeEntry(entry: unknown): MappingEntry | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const source = String((entry as Record<string, unknown>).source ?? "").trim();
  const target = String((entry as Record<string, unknown>).target ?? "").trim();
  if (!source || !target) {
    return null;
  }

  return { source, target };
}

function normalizeEntries(value: unknown): MappingEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeEntry).filter((item): item is MappingEntry => item !== null);
}

function normalizeGroup(value: unknown): MappingGroup | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const input = value as Partial<MappingGroup>;
  const id = String(input.id ?? "").trim();
  const name = String(input.name ?? "").trim();
  if (!id || !name) {
    return null;
  }

  const createdAt = String(input.createdAt ?? "").trim() || new Date().toISOString();
  const updatedAt = String(input.updatedAt ?? "").trim() || createdAt;

  return {
    id,
    name,
    description: String(input.description ?? ""),
    entries: normalizeEntries(input.entries),
    createdAt,
    updatedAt,
    lastImportedFileName: String(input.lastImportedFileName ?? ""),
  };
}

function normalizeGroups(value: unknown): MappingGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeGroup).filter((item): item is MappingGroup => item !== null);
}

function normalizeLegacyData(value: unknown): LegacyMappingData {
  const normalized: LegacyMappingData = {
    arrivalWarehouse: [],
    shippingWarehouse: [],
    region: [],
    quantityColumn: [],
  };

  if (!value || typeof value !== "object") {
    return normalized;
  }

  const input = value as Record<string, unknown>;
  for (const sectionId of LEGACY_MAPPING_SECTION_IDS) {
    normalized[sectionId] = normalizeEntries(input[sectionId]);
  }

  return normalized;
}

function legacySectionName(sectionId: (typeof LEGACY_MAPPING_SECTION_IDS)[number]): string {
  switch (sectionId) {
    case "arrivalWarehouse":
      return "到货仓映射";
    case "shippingWarehouse":
      return "发货仓映射";
    case "region":
      return "区域映射";
    case "quantityColumn":
      return "数量列映射";
    default:
      return sectionId;
  }
}

function convertLegacyToGroups(legacyData: LegacyMappingData): MappingGroup[] {
  const now = new Date().toISOString();
  return LEGACY_MAPPING_SECTION_IDS.map((sectionId) => ({
    id: sectionId,
    name: legacySectionName(sectionId),
    description: "",
    entries: cloneEntries(legacyData[sectionId]),
    createdAt: now,
    updatedAt: now,
    lastImportedFileName: "",
  }));
}

function setGroups(nextGroups: MappingGroup[]): void {
  mappingGroups.value = nextGroups.map(cloneGroup);
}

async function persistGroups(): Promise<void> {
  const store = await load(STORE_FILE);
  await store.set(STORE_KEY, mappingGroups.value);
  await store.save();
}

function enqueuePersist(): Promise<void> {
  persistQueue = persistQueue
    .then(() => persistGroups())
    .catch(() => {});
  return persistQueue;
}

async function migrateFromLegacyStore(store: Awaited<ReturnType<typeof load>>): Promise<boolean> {
  const legacyStoreValue = await store.get<unknown>(LEGACY_STORE_KEY);
  if (legacyStoreValue === undefined) {
    return false;
  }

  const legacyData = normalizeLegacyData(legacyStoreValue);
  setGroups(convertLegacyToGroups(legacyData));
  await persistGroups();
  await store.delete(LEGACY_STORE_KEY);
  await store.save();
  return true;
}

async function migrateLegacyLocalStorageIfNeeded(): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  const legacyValue = window.localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
  if (!legacyValue) {
    return false;
  }

  try {
    const parsed = JSON.parse(legacyValue);
    const legacyData = normalizeLegacyData(parsed);
    setGroups(convertLegacyToGroups(legacyData));
    await persistGroups();
    window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function sortByUpdatedAtDesc(groups: MappingGroup[]): MappingGroup[] {
  return [...groups].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function normalizeGroupNameKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function ensureUniqueGroupName(name: string, excludeGroupId = ""): void {
  const normalizedNameKey = normalizeGroupNameKey(name);
  const duplicated = mappingGroups.value.some((item) => {
    if (excludeGroupId && item.id === excludeGroupId) {
      return false;
    }
    return normalizeGroupNameKey(item.name) === normalizedNameKey;
  });
  if (duplicated) {
    throw new Error("分组名称已存在，请使用其他名称。");
  }
}

function normalizeImportedGroup(input: unknown, fallbackIndex: number): MappingGroup | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const now = new Date().toISOString();
  const item = input as Partial<MappingGroup>;
  const normalizedName = String(item.name ?? "").trim();
  if (!normalizedName) {
    return null;
  }

  const normalizedId = String(item.id ?? "").trim() || `imported-${fallbackIndex}-${crypto.randomUUID()}`;
  const createdAt = String(item.createdAt ?? "").trim() || now;
  const updatedAt = String(item.updatedAt ?? "").trim() || createdAt;

  return {
    id: normalizedId,
    name: normalizedName,
    description: String(item.description ?? "").trim(),
    entries: normalizeEntries(item.entries),
    createdAt,
    updatedAt,
    lastImportedFileName: String(item.lastImportedFileName ?? "").trim(),
  };
}

function normalizeImportedGroupsPayload(payload: unknown): MappingGroup[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item, index) => normalizeImportedGroup(item, index))
      .filter((item): item is MappingGroup => item !== null);
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  if (Array.isArray(objectPayload.mappingGroups)) {
    return objectPayload.mappingGroups
      .map((item, index) => normalizeImportedGroup(item, index))
      .filter((item): item is MappingGroup => item !== null);
  }

  const single = normalizeImportedGroup(payload, 0);
  if (single) {
    return [single];
  }

  const legacyData = normalizeLegacyData(payload);
  const hasLegacyValues = LEGACY_MAPPING_SECTION_IDS.some((sectionId) => legacyData[sectionId].length > 0);
  if (hasLegacyValues) {
    return convertLegacyToGroups(legacyData);
  }

  return [];
}

function ensureImportedGroupIdentities(groups: MappingGroup[]): MappingGroup[] {
  const usedIds = new Set<string>();
  return groups.map((group) => {
    let nextId = group.id;
    while (!nextId || usedIds.has(nextId)) {
      nextId = crypto.randomUUID();
    }
    usedIds.add(nextId);
    return {
      ...group,
      id: nextId,
    };
  });
}

export function initializeMappingStore(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  if (initialized) {
    isMappingStoreReady.value = true;
    return Promise.resolve();
  }
  initialized = true;

  initPromise = (async () => {
    try {
      const store = await load(STORE_FILE);
      const savedGroups = await store.get<unknown>(STORE_KEY);
      const normalizedGroups = normalizeGroups(savedGroups);

      if (normalizedGroups.length > 0) {
        setGroups(sortByUpdatedAtDesc(normalizedGroups));
      } else {
        const migratedFromStore = await migrateFromLegacyStore(store);
        if (!migratedFromStore) {
          const migratedFromLocalStorage = await migrateLegacyLocalStorageIfNeeded();
          if (!migratedFromLocalStorage) {
            setGroups(convertLegacyToGroups(DEFAULT_MAPPING_DATA));
            await persistGroups();
          }
        }
      }
    } catch {
      const migratedFromLocalStorage = await migrateLegacyLocalStorageIfNeeded();
      if (!migratedFromLocalStorage) {
        setGroups(convertLegacyToGroups(DEFAULT_MAPPING_DATA));
      }
    }

    isMappingStoreReady.value = true;
  })();

  return initPromise;
}

export function useMappingStore() {
  void initializeMappingStore();

  async function createGroup(name: string, description = ""): Promise<MappingGroup> {
    const normalizedName = name.trim();
    if (!normalizedName) {
      throw new Error("分组名称不能为空。");
    }
    ensureUniqueGroupName(normalizedName);

    const now = new Date().toISOString();
    const group: MappingGroup = {
      id: crypto.randomUUID(),
      name: normalizedName,
      description: description.trim(),
      entries: [],
      createdAt: now,
      updatedAt: now,
      lastImportedFileName: "",
    };

    mappingGroups.value = sortByUpdatedAtDesc([...mappingGroups.value, group]);
    await enqueuePersist();
    return cloneGroup(group);
  }

  async function updateGroupMeta(groupId: string, patch: Pick<MappingGroup, "name" | "description">): Promise<void> {
    const index = mappingGroups.value.findIndex((item) => item.id === groupId);
    if (index < 0) {
      throw new Error("分组不存在。");
    }

    const normalizedName = patch.name.trim();
    if (!normalizedName) {
      throw new Error("分组名称不能为空。");
    }
    ensureUniqueGroupName(normalizedName, groupId);

    const current = mappingGroups.value[index];
    const updated: MappingGroup = {
      ...current,
      name: normalizedName,
      description: patch.description.trim(),
      updatedAt: new Date().toISOString(),
    };
    const next = [...mappingGroups.value];
    next[index] = updated;
    mappingGroups.value = sortByUpdatedAtDesc(next);
    await enqueuePersist();
  }

  async function setGroupEntries(
    groupId: string,
    entries: MappingEntry[],
    lastImportedFileName = "",
  ): Promise<void> {
    const index = mappingGroups.value.findIndex((item) => item.id === groupId);
    if (index < 0) {
      throw new Error("分组不存在。");
    }

    const current = mappingGroups.value[index];
    const updated: MappingGroup = {
      ...current,
      entries: cloneEntries(entries),
      updatedAt: new Date().toISOString(),
      lastImportedFileName: lastImportedFileName.trim() || current.lastImportedFileName,
    };
    const next = [...mappingGroups.value];
    next[index] = updated;
    mappingGroups.value = sortByUpdatedAtDesc(next);
    await enqueuePersist();
  }

  async function clearGroupEntries(groupId: string): Promise<void> {
    const index = mappingGroups.value.findIndex((item) => item.id === groupId);
    if (index < 0) {
      return;
    }

    const current = mappingGroups.value[index];
    const updated: MappingGroup = {
      ...current,
      entries: [],
      updatedAt: new Date().toISOString(),
      lastImportedFileName: "",
    };
    const next = [...mappingGroups.value];
    next[index] = updated;
    mappingGroups.value = sortByUpdatedAtDesc(next);
    await enqueuePersist();
  }

  async function deleteGroup(groupId: string): Promise<void> {
    mappingGroups.value = mappingGroups.value.filter((item) => item.id !== groupId);
    await enqueuePersist();
  }

  function getGroupById(groupId: string): MappingGroup | null {
    const hit = mappingGroups.value.find((item) => item.id === groupId);
    return hit ? cloneGroup(hit) : null;
  }

  async function reloadFromDisk(): Promise<void> {
    const store = await load(STORE_FILE);
    const savedGroups = await store.get<unknown>(STORE_KEY);
    const normalizedGroups = normalizeGroups(savedGroups);
    if (normalizedGroups.length > 0) {
      setGroups(sortByUpdatedAtDesc(normalizedGroups));
      return;
    }

    const legacyStoreValue = await store.get<unknown>(LEGACY_STORE_KEY);
    if (legacyStoreValue !== undefined) {
      setGroups(convertLegacyToGroups(normalizeLegacyData(legacyStoreValue)));
      return;
    }

    setGroups([]);
  }

  async function replaceGroupsByImport(payload: unknown): Promise<number> {
    const importedGroups = normalizeImportedGroupsPayload(payload);
    if (importedGroups.length === 0) {
      throw new Error("导入失败：文件中未识别到有效分组数据。");
    }

    const dedupedGroups = ensureImportedGroupIdentities(importedGroups);
    const normalizedNameKeys = new Set<string>();
    for (const group of dedupedGroups) {
      const normalizedName = normalizeGroupNameKey(group.name);
      if (normalizedNameKeys.has(normalizedName)) {
        throw new Error(`导入失败：存在重复分组名称「${group.name}」。`);
      }
      normalizedNameKeys.add(normalizedName);
    }

    setGroups(sortByUpdatedAtDesc(dedupedGroups));
    await enqueuePersist();
    return dedupedGroups.length;
  }

  return {
    mappingGroups: readonly(mappingGroups),
    isMappingStoreReady: readonly(isMappingStoreReady),
    createGroup,
    updateGroupMeta,
    setGroupEntries,
    clearGroupEntries,
    deleteGroup,
    getGroupById,
    reloadFromDisk,
    replaceGroupsByImport,
  };
}
