<script setup lang="ts">
/**
 * The queue of work, and the two ways to reach something that is not in it.
 *
 * Typing a key or a directory is a deliberate act, so both go straight into
 * the issue rather than reporting that it now appears in a list somewhere.
 * Nothing here starts on its own: the list is a read-only poll of Jira, and
 * a review begins only when somebody asks for one.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { host, listRefresh, state } from '../bridge';
import { readIssues, startReviewByKey, startReviewByPath, type IssueRow } from '../api';
import { formatDate, statusLabel } from '../format';
import StateNote from './StateNote.vue';

const items = ref<IssueRow[]>([]);
const message = ref('');
/**
 * True until the first answer, and never again.
 *
 * "Eşleşen issue yok — JQL'i kontrol et" is the first thing a person sees
 * when the app opens, and before the poll answers it is simply false. An
 * empty state that lies sends someone to edit a config file that was right
 * all along.
 */
const loading = ref(true);
const filter = ref('');
const hint = ref('');

/* ---------------------------- start something ---------------------------- */

/**
 * One box for both ways in.
 *
 * There used to be two rows stacked above the list — "incele by key" and
 * "incele by path" — which made the reader classify their own input before
 * typing it. A Jira key and a directory do not look alike, so the box works
 * it out and says which it decided, rather than asking.
 */
const startWith = ref('');

const asPath = computed(() => {
  const value = startWith.value.trim();
  return value.startsWith('~') || value.startsWith('.') || value.includes('/');
});

const startHint = computed(() => {
  if (!startWith.value.trim()) return '';
  return asPath.value ? 'yerel dizin olarak incelenecek' : 'Jira anahtarı olarak incelenecek';
});

async function load(): Promise<void> {
  try {
    const data = await readIssues();
    if (data.error) {
      items.value = [];
      message.value = `Hata: ${data.error}`;
      // A first run has nothing to list and nothing to explain it. Opening
      // the one screen that fixes it beats an error the reader cannot act on.
      if (data.setupRequired) host.openSettings();
      return;
    }
    message.value = '';
    items.value = data.items;
  } catch (err) {
    items.value = [];
    message.value = `Sunucuya ulaşılamadı: ${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
}

const shown = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return items.value;
  return items.value.filter(
    (i) =>
      i.issueKey.toLowerCase().includes(needle) ||
      String(i.summary ?? '').toLowerCase().includes(needle),
  );
});

const count = computed(() =>
  shown.value.length === items.value.length
    ? String(items.value.length)
    : `${shown.value.length}/${items.value.length}`,
);

const emptyText = computed(() => {
  if (message.value) return message.value;
  if (items.value.length) return 'Aramaya uyan issue yok.';
  return 'Eşleşen issue yok.';
});

/* ------------------------------- keyboard -------------------------------- */

/*
 * The loop this tool exists for is: pick an issue, read it, decide.
 *
 * Reaching for the mouse between every one of those is what makes a queue
 * feel long. `j`/`k` walk the list, Enter opens, `/` jumps to the filter —
 * and nothing here decides anything: approving and rejecting stay clicks,
 * because a stray keypress must never write to Jira.
 */
const cursor = ref(-1);
const filterBox = ref<HTMLInputElement | null>(null);
const listBox = ref<HTMLElement | null>(null);

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function move(step: number): void {
  if (!shown.value.length) return;
  cursor.value = Math.max(0, Math.min(shown.value.length - 1, cursor.value + step));
  void nextTick(() => {
    listBox.value?.querySelectorAll('.issue-card')[cursor.value]?.scrollIntoView({ block: 'nearest' });
  });
}

function onKey(event: KeyboardEvent): void {
  // Someone writing a rejection reason is not navigating a list.
  if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === 'j' || event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'k' || event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Enter' && cursor.value >= 0) {
    event.preventDefault();
    host.openIssue(shown.value[cursor.value].issueKey);
  } else if (event.key === '/') {
    event.preventDefault();
    filterBox.value?.focus();
  }
}

/*
 * A cheap poll for what changed on this machine.
 *
 * `/api/reviews` asks Jira; this asks only the local review store, so it can
 * run every few seconds without costing an API call. A queued review moving
 * up the line, or one finishing, is what a reader is watching for — and
 * re-listing from Jira for that would be absurd.
 */
const REFRESH_MS = 4000;
let timer: ReturnType<typeof setInterval> | undefined;

async function refreshStates(): Promise<void> {
  if (document.hidden || !items.value.length) return;
  try {
    const { items: states } = await (await fetch('/api/review-states')).json();
    const byIssue = new Map<string, { reviewStatus: string; queuePosition?: number }>(
      states.map((i: IssueRow) => [i.issueKey, i]),
    );
    items.value = items.value.map((item) => {
      const live = byIssue.get(item.issueKey);
      // An issue with no record has never been reviewed — 'idle', not stale.
      return { ...item, reviewStatus: live?.reviewStatus ?? 'idle', queuePosition: live?.queuePosition };
    });

    // The badge is the point of the tab: it says how much is on you.
    // Computed from the poll that already happened rather than a second
    // request for the same facts.
    const waiting = states.filter((i: IssueRow) => i.reviewStatus === 'awaiting_approval').length;
    host.setViewCount('pending', waiting, waiting > 0);
  } catch {
    // The detail panel already surfaces connection trouble; a failed
    // background refresh should not put an error on screen by itself.
  }
}

onMounted(() => {
  void load();
  timer = setInterval(refreshStates, REFRESH_MS);
  document.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  clearInterval(timer);
  document.removeEventListener('keydown', onKey);
});

watch(() => listRefresh.token, load);

// A filtered list is a different list; a cursor pointing into the old one
// would land on whatever happens to sit at that index now.
watch(
  () => shown.value.map((i) => i.issueKey).join(','),
  () => (cursor.value = -1),
);

function badge(item: IssueRow): string {
  return item.reviewStatus === 'queued' && item.queuePosition
    ? `${statusLabel(item.reviewStatus)} · ${item.queuePosition}. sırada`
    : statusLabel(item.reviewStatus);
}

/** Whichever the box turned out to hold. */
async function startFromBox(): Promise<void> {
  if (!startWith.value.trim()) return;
  await (asPath.value ? openByPath() : openByKey());
}

async function openByKey(): Promise<void> {
  const key = startWith.value.trim().toUpperCase();
  if (!key) return;
  hint.value = `${key} açılıyor…`;
  try {
    await startReviewByKey(key);
  } catch (err) {
    hint.value = (err as Error).message;
    return;
  }
  hint.value = '';
  startWith.value = '';
  host.openIssue(key);
  await load();
}

/**
 * Reviews a directory instead of an issue.
 *
 * Both the committed branch diff and whatever is uncommitted go in — the
 * uncommitted half is the half most likely to be wrong, and leaving it out
 * would produce a confident review of code nobody is about to push.
 */
async function openByPath(): Promise<void> {
  const path = startWith.value.trim();
  if (!path) return;
  hint.value = 'Dizin okunuyor…';
  let started;
  try {
    started = await startReviewByPath(path);
  } catch (err) {
    hint.value = (err as Error).message;
    return;
  }
  hint.value = '';
  startWith.value = '';
  host.openIssue(started.issueKey);
  await load();
}
</script>

<template>
  <div class="sidebar-head">
    <input
      ref="filterBox"
      v-model="filter"
      class="input"
      type="text"
      placeholder="Issue veya özet ara…  ( / )"
    />
    <span class="sidebar-count">{{ message ? '' : count }}</span>
  </div>

  <div class="sidebar-head byKey">
    <input
      v-model="startWith"
      class="input"
      type="text"
      placeholder="BUY-2455 ya da ~/projects/api"
      @keydown.enter="startFromBox"
    />
    <button class="btn small" :disabled="!startWith.trim()" @click="startFromBox">İncele</button>
  </div>

  <div v-if="hint || startHint" id="byKeyResult" class="card-hint">{{ hint || startHint }}</div>

  <div ref="listBox" class="issue-list">
    <div
      v-for="(item, index) in shown"
      :key="item.issueKey"
      class="issue-card"
      :class="{ selected: item.issueKey === state.issueKey, cursor: index === cursor }"
      @click="host.openIssue(item.issueKey)"
    >
      <div class="issue-card-top">
        <span class="issue-key">{{ item.issueKey }}</span>
        <span v-if="item.trigger === 'auto'" class="autoTag">oto</span>
        <span class="badge" :class="`badge-${item.reviewStatus}`">{{ badge(item) }}</span>
      </div>
      <div class="issue-summary">{{ item.summary }}</div>
      <div class="issue-meta">
        <span>{{ item.assignee ?? 'atanmamış' }}</span>
        <span class="dot">·</span>
        <span>{{ item.jiraStatus }}</span>
        <span class="dot">·</span>
        <span>{{ formatDate(item.updated) }}</span>
      </div>
    </div>

    <StateNote v-if="loading" kind="loading">issue'lar okunuyor…</StateNote>
    <StateNote v-else-if="message" kind="error">{{ message }}</StateNote>
    <div v-else-if="!shown.length" class="detail-empty shown">
      <div>
        <div>{{ emptyText }}</div>
        <div v-if="!items.length" class="muted">
          JQL'i kontrol et (config/config.yaml) ya da yenile.
        </div>
      </div>
    </div>
  </div>
</template>
