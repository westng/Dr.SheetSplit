export type MappingEntry = {
  source: string;
  target: string;
};

export type LegacyMappingSectionId =
  | "arrivalWarehouse"
  | "shippingWarehouse"
  | "region"
  | "quantityColumn";

export type LegacyMappingData = Record<LegacyMappingSectionId, MappingEntry[]>;

export const LEGACY_MAPPING_SECTION_IDS: LegacyMappingSectionId[] = [
  "arrivalWarehouse",
  "shippingWarehouse",
  "region",
  "quantityColumn",
];

export type MappingGroup = {
  id: string;
  name: string;
  description: string;
  entries: MappingEntry[];
  createdAt: string;
  updatedAt: string;
  lastImportedFileName: string;
};

export function isLegacyMappingSectionId(value: string): value is LegacyMappingSectionId {
  return LEGACY_MAPPING_SECTION_IDS.includes(value as LegacyMappingSectionId);
}

export function createEmptyMappingGroup(name = "", description = ""): MappingGroup {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    description,
    entries: [],
    createdAt: now,
    updatedAt: now,
    lastImportedFileName: "",
  };
}
