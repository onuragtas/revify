<script setup lang="ts">
/**
 * One issue: what Jira says, what the reviewer said, and what happens next.
 *
 * Nothing here starts on its own. The list is a read-only poll; a review
 * begins when somebody presses a button, and approving or rejecting is
 * always a click. That is the whole safety model, so the buttons say plainly
 * what they will do.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { refreshList, state } from '../bridge';
import { connection, meta, metaError, openIssue, showTab, startPolling, stopPolling, tabs } from '../detail';
import { contextSelection, openModal } from '../uiState';
import { outcomeConfig } from '../appConfig';
import { session } from '../session';
import { formatDate, statusLabel } from '../format';
import StateNote from './StateNote.vue';
import { available as fixAvailable } from '../fixState';

import DecisionCard from './DecisionCard.vue';
import DiffPanel from './DiffPanel.vue';
import FixButton from './FixButton.vue';
import FixPanel from './FixPanel.vue';
import HistoryPanel from './HistoryPanel.vue';
import NotesPanel from './NotesPanel.vue';
import PromptCards from './PromptCards.vue';
import ReviewPanel from './ReviewPanel.vue';
import VerifyPanel from './VerifyPanel.vue';

const TABS = [
  ['review', 'Review'],
  ['steps', 'Adımlar'],
  ['diff', 'Değişiklik'],
  ['patch', 'Yama'],
  ['verify', 'Doğrulama'],
  ['notes', 'Notlar'],
  ['history', 'Geçmiş'],
] as const;

const detail = computed(() => state.detail);
const stepsBox = ref<HTMLElement | null>(null);

const badge = computed(() => {
  const status = detail.value?.status ?? 'idle';
  const position = detail.value?.queuePosition;
  return status === 'queued' && position
    ? `${statusLabel(status)} · ${position}. sırada`
    : statusLabel(status);
});

const inFlight = computed(
  () => detail.value?.status === 'running' || detail.value?.status === 'queued',
);

/** Re-running is always allowed — including on a record stuck in "running"
 * because the server was restarted mid-review. */
const startLabel = computed(() => {
  const status = detail.value?.status;
  if (!status || status === 'idle') return 'İncele';
  if (status === 'running' || status === 'cancelled') return 'Yeniden başlat';
  if (status === 'queued') return 'Sıraya alındı';
  return 'Yeniden incele';
});

const stamp = computed(() => {
  const d = detail.value;
  if (!d?.reviewedAt) return '';
  return (
    (d.trigger === 'auto' ? 'otomatik hazırlandı · ' : 'incelendi · ') +
    formatDate(d.reviewedAt) +
    (d.reviewSeq ? ` · #${d.reviewSeq}` : '')
  );
});

const jiraUrl = computed(() =>
  outcomeConfig.jiraBaseUrl && state.issueKey
    ? `${outcomeConfig.jiraBaseUrl}/browse/${encodeURIComponent(state.issueKey)}`
    : null,
);

const chips = computed(() => {
  const m = meta.value;
  if (!m) return [];
  return (
    [
      ['Tip', m.issueType],
      ['Durum', m.status],
      ['Atanan', m.assignee],
      ['Bildiren', m.reporter],
      ['Sprint', m.sprint],
      ['Öncelik', m.priority],
      ['Güncellendi', m.updated ? formatDate(m.updated) : ''],
    ] as Array<[string, string | undefined]>
  ).filter(([, value]) => value);
});

const steps = computed(
  () =>
    (detail.value?.steps ?? [])
      .map((s) => `[${s.ts.split('T')[1]?.slice(0, 8) ?? ''}] ${s.message}`)
      .join('\n') || '(henüz adım yok)',
);

// The log is read from the bottom: a run that is working adds to the end.
watch(steps, () => {
  requestAnimationFrame(() => {
    if (stepsBox.value) stepsBox.value.scrollTop = stepsBox.value.scrollHeight;
  });
});

/**
 * Open the tab that matters right now: the log while it works, the review
 * once there is one — but only until the reader picks for themselves.
 */
watch(
  () => [detail.value?.status, Boolean(detail.value?.review)] as const,
  ([status, hasReview]) => {
    if (tabs.pinned) return;
    if (status === 'running' || status === 'queued') showTab('steps', { pin: false });
    else if (hasReview) showTab('review', { pin: false });
  },
);

onMounted(() => {
  // A refresh comes back to the issue it was showing.
  const fromUrl = decodeURIComponent(location.hash.slice(1));
  if (fromUrl) openIssue(fromUrl);
});

async function start(): Promise<void> {
  const issueKey = state.issueKey;
  if (!issueKey) return;
  openIssue(issueKey, { force: true });
  showTab('steps', { pin: false });

  await fetch(`/api/reviews/${encodeURIComponent(issueKey)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contextRepos: [...contextSelection.repos] }),
  }).catch(() => {});

  // Only now is the record 'queued'. The poll openIssue started read the
  // status as it was before this request — for an issue already reviewed
  // that reads as "settled", and it would stop polling a run just beginning.
  startPolling(issueKey);
  refreshList();
}

async function stop(): Promise<void> {
  if (!state.issueKey) return;
  await fetch(`/api/reviews/${encodeURIComponent(state.issueKey)}/stop`, { method: 'POST' }).catch(() => {});
  startPolling(state.issueKey);
}

async function clear(): Promise<void> {
  const issueKey = state.issueKey;
  if (!issueKey) return;
  if (!confirm(`${issueKey} için review, geçmiş ve cevaplar silinsin mi? (klonlanan repolar korunur)`)) return;
  await fetch(`/api/reviews/${encodeURIComponent(issueKey)}`, { method: 'DELETE' }).catch(() => {});
  startPolling(issueKey);
  refreshList();
}

function back(): void {
  stopPolling();
  state.issueKey = null;
  state.detail = null;
  history.replaceState(null, '', location.pathname);
}
</script>

<template>
  <section class="detail">
    <div v-if="!state.issueKey" class="detail-empty">
      <div class="detail-empty-mark">⌘</div>
      <div>Soldan bir issue seç.</div>
      <div class="muted">Hiçbir şey kendiliğinden başlamaz — incelemeyi sen tetiklersin.</div>
    </div>

    <div v-else class="detail-body open">
      <div class="detail-head">
        <div class="detail-title-row">
          <!-- Hidden on a wide window by the stylesheet; the list is
               already beside you there. -->
          <button id="backBtn" class="btn btn-ghost btn-icon" title="Listeye dön" @click="back" aria-label="Listeye dön">←</button>
          <h2>
            <a v-if="jiraUrl" class="issueLink" :href="jiraUrl" target="_blank" rel="noopener" title="Jira'da aç">
              {{ state.issueKey }}
            </a>
            <span v-else class="issueLink">{{ state.issueKey }}</span>
          </h2>
          <span class="badge" :class="`badge-${detail?.status ?? 'idle'}`">{{ badge }}</span>
          <span id="detailSummary">{{ meta?.summary ?? detail?.summary ?? '' }}</span>
          <span class="muted stampText">{{ stamp }}</span>
          <span id="connState" class="error" role="status" aria-live="polite">
            {{ connection.error }}
          </span>

          <div class="detail-head-actions">
            <button class="btn btn-primary" :disabled="detail?.status === 'queued'" @click="start">
              {{ startLabel }}
            </button>
            <button v-if="session.configured" class="btn" title="Bu işi bir takım arkadaşına devret" @click="openModal('assign')">
              Ata…
            </button>
            <FixButton />
            <button v-if="inFlight" class="btn btn-reject" @click="stop">Durdur</button>
            <button class="btn" @click="openModal('context')">Bağlam…</button>
            <!-- Apart from the others: everything to its left starts or
                 continues work, and this one throws it away. -->
            <button
              class="btn btn-ghost detachedAction"
              title="Bu görevin review durumunu sıfırla"
              @click="clear"
            >
              Temizle
            </button>
          </div>
        </div>

        <div class="meta-chips">
          <span v-for="[label, value] in chips" :key="label" class="meta-chip">
            <b>{{ label }}</b>{{ value }}
          </span>
        </div>

        <!-- Tabs, said so: without the roles a screen reader hears seven
             unrelated buttons and no sense of which one is showing. -->
        <nav class="tabs" role="tablist">
          <button
            v-for="[name, label] in TABS"
            :key="name"
            class="tab"
            :class="{ active: tabs.active === name }"
            role="tab"
            :aria-selected="tabs.active === name"
            @click="showTab(name)"
          >
            {{ label }}
            <span
              v-if="tabs.counts[name]?.count"
              class="tab-count"
              :class="{ alert: tabs.counts[name].alert }"
            >
              {{ tabs.counts[name].count }}
            </span>
          </button>
        </nav>
      </div>

      <div class="detail-scroll">
        <!--
          Nothing is claimed before the first payload arrives.

          Every panel below has an empty state, and each one is a statement
          of fact: "no review", "nothing to show", "no description". Rendered
          while the first poll is still in flight they are all wrong — you
          click an issue that has a review and are told it has none. An empty
          state that lies is worse than a blank one.
        -->
        <StateNote v-if="!detail" kind="loading">{{ state.issueKey }} okunuyor…</StateNote>

        <template v-else>
        <div v-if="detail.error" id="errorBox" role="alert">{{ detail.error }}</div>

        <div class="panel" :class="{ active: tabs.active === 'review' }" role="tabpanel">
          <details class="card issue-desc-card">
            <summary>Jira açıklaması</summary>
            <!-- The same rule: Jira is a second request, and "(açıklama yok)"
                 before it answers is an answer nobody gave. -->
            <StateNote v-if="!meta && !metaError" kind="loading">Jira'dan okunuyor…</StateNote>
            <StateNote v-else-if="metaError" kind="error">{{ metaError }}</StateNote>
            <div v-else id="issueDesc">{{ meta?.description || '(açıklama yok)' }}</div>
          </details>
          <ReviewPanel />
          <DecisionCard />
        </div>

        <div class="panel" :class="{ active: tabs.active === 'steps' }" role="tabpanel">
          <div class="card">
            <h3>Çalışma adımları</h3>
            <p class="card-hint">
              Review sürecinin canlı kaydı — hangi repo klonlandı, hangi diff alındı, model ne
              zaman çağrıldı.
            </p>
            <!-- The log grows while a run works; `polite` announces the new
                 lines without interrupting whatever is being read. -->
            <div id="steps" ref="stepsBox" role="log" aria-live="polite">{{ steps }}</div>
          </div>
          <div id="promptCards"><PromptCards /></div>
        </div>

        <div class="panel" :class="{ active: tabs.active === 'diff' }" role="tabpanel"><DiffPanel /></div>
        <div class="panel" :class="{ active: tabs.active === 'patch' }" role="tabpanel"><FixPanel /></div>
        <div class="panel" :class="{ active: tabs.active === 'verify' }" role="tabpanel"><VerifyPanel /></div>
        <div class="panel" :class="{ active: tabs.active === 'notes' }" role="tabpanel"><NotesPanel /></div>
        <div class="panel" :class="{ active: tabs.active === 'history' }" role="tabpanel"><HistoryPanel /></div>
        </template>
      </div>
    </div>
  </section>
</template>
