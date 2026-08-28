<script setup lang="ts">
/**
 * Previous reviews of this issue.
 *
 * Kept so a re-run can be read against what the reviewer said last time —
 * after answering a question, adding a note, or disputing a finding, the
 * useful question is what changed, and that needs both texts.
 */
import { computed, watch } from 'vue';
import StateNote from './StateNote.vue';
import { host, state } from '../bridge';
import { renderMarkdown } from '../markdown';

const history = computed(() => state.detail?.history ?? []);

watch(history, () => host.setTabCount('history', history.value.length), { immediate: true });

const BADGE_TR: Record<string, string> = {
  idle: 'bekliyor',
  cancelled: 'durduruldu',
  queued: 'kuyrukta',
  running: 'çalışıyor',
  awaiting_approval: 'onay bekliyor',
  approved: 'onaylandı',
  rejected: 'reddedildi',
  posted: "Jira'ya yazıldı",
  failed: 'hata',
};

function when(iso: string): string {
  return String(iso ?? '').replace('T', ' ').slice(0, 19);
}
</script>

<template>
  <div v-if="history.length" id="historyList">
    <!-- Newest first, and the most recent one open: that is the one being
         compared against. -->
    <details v-for="(h, i) in history" :key="h.archivedAt" :open="i === 0">
      <summary>
        <time>{{ when(h.archivedAt) }}</time>
        <span class="badge" :class="`badge-${h.outcome}`">{{ BADGE_TR[h.outcome] ?? h.outcome }}</span>
      </summary>
      <div class="histMd" v-html="renderMarkdown(h.markdown)"></div>
    </details>
  </div>

  <StateNote v-else>Bu görev için önceki inceleme yok.</StateNote>
</template>
