<script setup lang="ts">
/**
 * What the model was actually told, on demand.
 *
 * The first container handed to Vue, and chosen for a reason: its old
 * implementation carried three pieces of hand-kept state — a fetched-body
 * cache, an open/closed set, and a render-signature guard — precisely so a
 * re-render would not lose what the reader had opened. All three are gone
 * here; that bookkeeping *is* what a reactive renderer does.
 *
 * Behaviour is deliberately identical to what it replaces: closed by
 * default, fetched once on first open, copy button that does not toggle the
 * card, same labels, same classes, same markup.
 */
import { computed, ref, watch } from 'vue';
import { state } from '../bridge';
import { readPrompt } from '../api';

const prompts = computed(() => state.detail?.prompts ?? []);

/** Fetched bodies, keyed by kind. Cleared whenever the open issue changes,
 * because a body is only meaningful for the issue it came from — the old
 * code keyed the same cache globally and showed one issue's prompt under
 * another's card until that was found and fixed. */
const bodies = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
const loading = ref<Record<string, boolean>>({});
/**
 * Everything fetched belongs to one issue, and only that issue.
 *
 * Watched rather than checked lazily on the next fetch: a card left open
 * while the reader moves to another issue would go on showing the previous
 * one's prompt until they thought to close and reopen it. The `<details>`
 * elements are keyed by issue too, so they are recreated — and therefore
 * closed — rather than left open over an empty cache.
 */
watch(
  () => state.issueKey,
  () => {
    bodies.value = {};
    errors.value = {};
    inFlight.clear();
  },
);

function label(kind: string): string {
  if (kind === 'review') return 'Review prompt';
  if (kind.startsWith('fix:')) return `Yama prompt — ${kind.slice(4)}`;
  return kind;
}

function sizeKb(size: number): number {
  return Math.max(1, Math.round(size / 1000));
}

function when(iso: string): string {
  return String(iso ?? '').replace('T', ' ').slice(0, 16) || '—';
}

/** System prompt and user turn are two different things and read as one wall
 * of text without a marker between them. */
function joined(p: { system: string; prompt: string }): string {
  const head = p.system ? `───────── SYSTEM ─────────\n${p.system}\n\n───────── PROMPT ─────────\n` : '';
  return head + p.prompt;
}

/**
 * Requests in flight, so two openings share one.
 *
 * Opening a card and copying from it are separate acts that both want the
 * body, and a fast double-click on the card fires twice — without this each
 * would start its own request, and neither would see the other's cache.
 */
const inFlight = new Map<string, Promise<string>>();

async function load(kind: string): Promise<string> {
  const cached = bodies.value[kind];
  if (cached !== undefined) return cached;
  const running = inFlight.get(kind);
  if (running) return running;
  if (!state.issueKey) throw new Error('Açık bir iş yok.');

  const issueKey = state.issueKey;
  loading.value = { ...loading.value, [kind]: true };
  const request = readPrompt(issueKey, kind)
    .then((stored) => {
      const body = joined(stored);
      // Only if the reader has not moved on: an answer for an issue nobody
      // is looking at any more must not be shown under the one they are.
      if (state.issueKey === issueKey) bodies.value = { ...bodies.value, [kind]: body };
      return body;
    })
    .finally(() => {
      inFlight.delete(kind);
      loading.value = { ...loading.value, [kind]: false };
    });

  inFlight.set(kind, request);
  return request;
}

async function onToggle(event: Event, kind: string): Promise<void> {
  if (!(event.target as HTMLDetailsElement).open) return;
  try {
    await load(kind);
  } catch (err) {
    errors.value = { ...errors.value, [kind]: `Okunamadı: ${(err as Error).message}` };
  }
}

const copied = ref<string | null>(null);

async function copy(kind: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(await load(kind));
    copied.value = kind;
  } catch {
    copied.value = null;
    errors.value = { ...errors.value, [kind]: 'Kopyalanamadı.' };
    return;
  }
  setTimeout(() => (copied.value = copied.value === kind ? null : copied.value), 1500);
}
</script>

<template>
  <details
    v-for="p in prompts"
    :key="`${state.issueKey}|${p.kind}`"
    @toggle="onToggle($event, p.kind)"
  >
    <summary>
      <span>{{ label(p.kind) }}</span>
      <span class="muted">{{ sizeKb(p.size) }} KB</span>
      <span class="spacer"></span>
      <time>{{ when(p.savedAt) }}</time>
      <button class="btn btn-ghost" @click.prevent.stop="copy(p.kind)">
        {{ copied === p.kind ? 'kopyalandı' : 'Kopyala' }}
      </button>
    </summary>
    <pre class="promptText">{{
      errors[p.kind] ?? (loading[p.kind] ? 'yükleniyor…' : (bodies[p.kind] ?? 'aç ve yükle…'))
    }}</pre>
  </details>
</template>
