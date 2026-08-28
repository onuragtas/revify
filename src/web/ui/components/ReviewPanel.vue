<script setup lang="ts">
/**
 * The review, read as findings rather than as one wall of markdown.
 *
 * The reviewer already writes in findings — `### blocking — src/a.ts:42`,
 * one per problem — and the server already parses them, because the fix path
 * needs the same list. Rendering them as a single blob threw that structure
 * away and made the reader scan for severities by eye. As cards, the shape
 * of a review is visible before a word of it is read: how many problems, how
 * bad, and in which files.
 *
 * The prose around them is not dropped. What the reviewer wrote before the
 * first finding stays above; the verdict and QA notes stay below, where they
 * belong — they are about the change as a whole, not about the last finding.
 */
import { computed, ref, watch } from 'vue';
import StateNote from './StateNote.vue';
import { state } from '../bridge';
import { renderMarkdown } from '../markdown';

const detail = computed(() => state.detail);
const findings = computed(() => detail.value?.findings ?? []);

/** Worst first is how a reader triages: a blocking finding decides the
 * outcome, and three minors under it do not. */
const ORDER = ['blocking', 'major', 'minor'];
const sorted = computed(() =>
  [...findings.value].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity)),
);

const counts = computed(() => {
  const by: Record<string, number> = {};
  for (const f of findings.value) by[f.severity] = (by[f.severity] ?? 0) + 1;
  return ORDER.filter((s) => by[s]).map((severity) => ({ severity, count: by[severity] }));
});

/** Collapsed once a review gets long: a reader scanning six findings wants
 * the headings, not six screens of quoted diff. Under that, everything is
 * open, because collapsing three findings only adds clicks. */
const MANY = 4;
const collapsed = ref<Record<string, boolean>>({});

watch(
  () => [state.issueKey, findings.value.length] as const,
  () => {
    const many = findings.value.length >= MANY;
    collapsed.value = Object.fromEntries(findings.value.map((f) => [f.id, many]));
  },
  { immediate: true },
);

function toggle(id: string): void {
  collapsed.value = { ...collapsed.value, [id]: !collapsed.value[id] };
}
</script>

<template>
  <div v-if="detail?.review">
    <div class="card">
      <div class="reviewHead">
        <h3>AI Review</h3>
        <span class="spacer"></span>
        <span v-for="c in counts" :key="c.severity" class="sev" :class="`sev-${c.severity}`">
          {{ c.count }} {{ c.severity }}
        </span>
        <span v-if="!findings.length" class="sev sev-minor">bulgu yok</span>
      </div>

      <div v-if="detail.reviewPreamble" class="mdBody" v-html="renderMarkdown(detail.reviewPreamble)"></div>
    </div>

    <article
      v-for="f in sorted"
      :key="f.id"
      class="card findingCard"
      :class="[`findingCard-${f.severity}`, { collapsed: collapsed[f.id] }]"
    >
      <header class="findingHead" @click="toggle(f.id)">
        <span class="sev" :class="`sev-${f.severity}`">{{ f.severity }}</span>
        <span class="sev-loc">{{ f.location }}</span>
        <span class="spacer"></span>
        <span class="findingToggle">{{ collapsed[f.id] ? '▸' : '▾' }}</span>
      </header>
      <div v-show="!collapsed[f.id]" class="mdBody" v-html="renderMarkdown(f.body)"></div>
    </article>

    <div v-if="detail.reviewTail" class="card">
      <div class="mdBody" v-html="renderMarkdown(detail.reviewTail)"></div>
    </div>
  </div>

  <StateNote v-else>Bu görev için henüz review yok. Yukarıdan <b>İncele</b> ile başlat.</StateNote>
</template>
