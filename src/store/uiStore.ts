import { ref } from "vue";

export type MainMenu = "process" | "engineProcess" | "rules" | "engineRules" | "mapping" | "settings";

const activeHistoryId = ref("");
const activeMenu = ref<MainMenu>("process");

export function useUiStore() {
  return {
    activeHistoryId,
    activeMenu,
  };
}
