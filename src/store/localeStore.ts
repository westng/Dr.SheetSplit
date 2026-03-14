import { ref, watch } from "vue";
import { AppLocale, i18n, isSupportedLocale, LOCALE_STORAGE_KEY } from "../i18n";

const locale = ref<AppLocale>(i18n.global.locale.value as AppLocale);
const localeOptions = [
  { value: "zh-CN", labelKey: "settings.language.options.zhCN" },
  { value: "en-US", labelKey: "settings.language.options.enUS" },
] as const;

let initialized = false;

export function initializeLocaleStore(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  const savedLocale = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (savedLocale && isSupportedLocale(savedLocale)) {
    locale.value = savedLocale;
  }

  watch(
    locale,
    (nextLocale) => {
      i18n.global.locale.value = nextLocale;
      localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale);
      document.documentElement.lang = nextLocale;
    },
    { immediate: true },
  );
}

export function useLocaleStore() {
  initializeLocaleStore();

  return {
    locale,
    localeOptions,
  };
}
