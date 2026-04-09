import { ref } from "vue";

export type MainMenu = "engineProcess" | "engineRules" | "mapping" | "settings";

const activeHistoryId = ref("");
const activeMenu = ref<MainMenu>("engineProcess");

export function useUiStore() {
  return {
    activeHistoryId,
    activeMenu,
  };
}
