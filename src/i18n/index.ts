import { createI18n } from "vue-i18n";
import enUS from "../locales/en-US";
import zhCN from "../locales/zh-CN";

export const LOCALE_STORAGE_KEY = "settings.locale";
export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

const DEFAULT_LOCALE: AppLocale = "zh-CN";
const FALLBACK_LOCALE: AppLocale = "en-US";

export function isSupportedLocale(locale: string): locale is AppLocale {
  return SUPPORTED_LOCALES.includes(locale as AppLocale);
}

function resolveSystemLocale(): AppLocale {
  if (typeof navigator === "undefined") {
    return DEFAULT_LOCALE;
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function resolveInitialLocale(): AppLocale {
  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }

  const savedLocale = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (savedLocale && isSupportedLocale(savedLocale)) {
    return savedLocale;
  }

  return resolveSystemLocale();
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: resolveInitialLocale(),
  fallbackLocale: FALLBACK_LOCALE,
  messages: {
    "zh-CN": zhCN,
    "en-US": enUS,
  },
});
