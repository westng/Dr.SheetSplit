import { createApp } from "vue";
import App from "./App.vue";
import { initializeAppearanceSettings } from "./composables/useAppearanceSettings";
import { i18n } from "./i18n";
import { router } from "./router";
import { initializeLocaleStore } from "./store";

initializeLocaleStore();
initializeAppearanceSettings();

createApp(App).use(router).use(i18n).mount("#app");
