import { onMounted, onUnmounted, ref, watch } from "vue";
import { fetchSloganApi } from "../api/slogan";
import { i18n } from "../i18n";

export function useSlogan(pollInterval = 10_000) {
  const sloganText = ref(i18n.global.t("slogan.loading"));
  const hasSloganLoaded = ref(false);
  const sloganState = ref<"loading" | "ready" | "unavailable">("loading");
  let sloganTimer: number | undefined;

  function applyFallbackSlogan(): void {
    if (sloganState.value === "loading") {
      sloganText.value = i18n.global.t("slogan.loading");
      return;
    }
    sloganText.value = i18n.global.t("slogan.unavailable");
  }

  async function fetchSloganText(): Promise<void> {
    try {
      sloganText.value = await fetchSloganApi();
      hasSloganLoaded.value = true;
      sloganState.value = "ready";
    } catch {
      if (!hasSloganLoaded.value) {
        sloganState.value = "unavailable";
        applyFallbackSlogan();
      }
    }
  }

  function startSloganRefresh(): void {
    void fetchSloganText();
    sloganTimer = window.setInterval(() => {
      void fetchSloganText();
    }, pollInterval);
  }

  function stopSloganRefresh(): void {
    if (sloganTimer !== undefined) {
      window.clearInterval(sloganTimer);
      sloganTimer = undefined;
    }
  }

  onMounted(() => {
    startSloganRefresh();
  });

  watch(
    () => i18n.global.locale.value,
    () => {
      if (!hasSloganLoaded.value) {
        applyFallbackSlogan();
      }
    },
  );

  onUnmounted(() => {
    stopSloganRefresh();
  });

  return {
    sloganText,
    refreshSloganText: fetchSloganText,
  };
}
