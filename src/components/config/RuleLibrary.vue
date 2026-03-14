<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { RuleDefinition } from "../../types/rule";

const props = defineProps<{
  rules: readonly RuleDefinition[];
  activeRuleId: string;
  disabled: boolean;
  showTitle?: boolean;
}>();

const emit = defineEmits<{
  select: [ruleId: string];
  export: [ruleId: string];
  duplicate: [ruleId: string];
  remove: [ruleId: string];
}>();

const { locale, t } = useI18n();

const sortedRules = computed(() =>
  [...props.rules].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
);

function handleDuplicate(ruleId: string): void {
  emit("duplicate", ruleId);
}

function handleExport(ruleId: string): void {
  emit("export", ruleId);
}

function handleRemove(ruleId: string): void {
  emit("remove", ruleId);
}

function formatUpdatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat(locale.value, {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}
</script>

<template>
  <aside class="rule-library">
    <h3 v-if="showTitle !== false" class="rule-library-title">{{ t("rules.library.title") }}</h3>

    <p v-if="sortedRules.length === 0" class="rule-library-empty">
      {{ t("rules.library.empty") }}
    </p>

    <ul v-else class="rule-list">
      <li v-for="rule in sortedRules" :key="rule.id">
        <div class="rule-row" :class="{ active: rule.id === activeRuleId }">
          <button
            type="button"
            class="rule-item"
            :class="{ active: rule.id === activeRuleId }"
            :disabled="disabled"
            @click="emit('select', rule.id)"
          >
            <span class="rule-item-name">{{ rule.name || t("rules.library.unnamed") }}</span>
            <span class="rule-item-time">{{ formatUpdatedAt(rule.updatedAt) }}</span>
          </button>
          <div class="rule-item-actions">
            <button type="button" class="action-link" :disabled="disabled" @click="handleExport(rule.id)">
              {{ t("rules.actions.export") }}
            </button>
            <button type="button" class="action-link" :disabled="disabled" @click="handleDuplicate(rule.id)">
              {{ t("rules.actions.duplicate") }}
            </button>
            <button type="button" class="action-link danger" :disabled="disabled" @click="handleRemove(rule.id)">
              {{ t("rules.actions.delete") }}
            </button>
          </div>
        </div>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.rule-library {
  min-height: 0;
  display: grid;
  gap: 10px;
}

.rule-library-title {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.rule-library-empty {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.rule-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
  overflow: auto;
  min-height: 0;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.rule-list::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.rule-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 10px 14px;
  border: 1px solid var(--stroke-soft);
  border-radius: 12px;
  background: var(--bg-card);
  transition: border-color 160ms ease, background-color 160ms ease;
}

.rule-row:hover {
  background: var(--bg-input);
}

.rule-row.active {
  border-color: var(--accent);
  background: var(--bg-input);
}

.rule-item {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-main);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  text-align: left;
  cursor: pointer;
}

.rule-item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.rule-item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-md);
  font-weight: 500;
}

.rule-item-time {
  flex: 0 0 auto;
  font-size: var(--fs-caption);
  color: var(--text-muted);
}

.rule-item-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex: 0 0 auto;
}

.action-link {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: var(--fs-caption);
  line-height: 1;
  cursor: pointer;
  padding: 0;
}

.action-link:hover:not(:disabled) {
  color: var(--text-main);
}

.action-link.danger:hover:not(:disabled) {
  color: var(--danger);
}

.action-link:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

@media (max-width: 780px) {
  .rule-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    align-items: stretch;
  }

  .rule-item {
    align-items: flex-start;
    flex-direction: column;
  }

  .rule-item-actions {
    justify-content: flex-start;
  }
}
</style>
