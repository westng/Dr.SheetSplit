import { computed, nextTick, onMounted, onUnmounted, ref, watch, type Ref } from "vue";

export function useOverflowMarquee(text: Ref<string>, speedPxPerSecond = 42) {
  const containerRef = ref<HTMLElement | null>(null);
  const trackRef = ref<HTMLElement | null>(null);
  const overflowPx = ref(0);
  let resizeObserver: ResizeObserver | undefined;

  function measureOverflow(): void {
    const container = containerRef.value;
    const track = trackRef.value;
    if (!container || !track) {
      overflowPx.value = 0;
      return;
    }

    const containerWidth = container.clientWidth;
    const trackWidth = track.scrollWidth;
    overflowPx.value = Math.max(0, Math.ceil(trackWidth - containerWidth));
  }

  const isOverflowing = computed(() => overflowPx.value > 0);
  const marqueeDurationSec = computed(() => {
    if (!isOverflowing.value) {
      return "0s";
    }
    return `${Math.max(overflowPx.value / speedPxPerSecond, 4).toFixed(2)}s`;
  });

  const marqueeStyle = computed(() => ({
    "--marquee-distance": `${overflowPx.value}px`,
    "--marquee-duration": marqueeDurationSec.value,
  }));

  watch(
    text,
    async () => {
      await nextTick();
      measureOverflow();
    },
    { immediate: true },
  );

  onMounted(async () => {
    await nextTick();
    measureOverflow();

    resizeObserver = new ResizeObserver(() => {
      measureOverflow();
    });

    if (containerRef.value) {
      resizeObserver.observe(containerRef.value);
    }
    if (trackRef.value) {
      resizeObserver.observe(trackRef.value);
    }
  });

  onUnmounted(() => {
    resizeObserver?.disconnect();
  });

  return {
    containerRef,
    trackRef,
    isOverflowing,
    marqueeStyle,
  };
}
