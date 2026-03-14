import { ref } from "vue";

export type MainMenu = "process" | "rules" | "mapping" | "settings";

const activeHistoryId = ref("");
const activeMenu = ref<MainMenu>("process");

export function useUiStore() {
  return {
    activeHistoryId,
    activeMenu,
  };
}
