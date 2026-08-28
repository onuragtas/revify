<script setup lang="ts">
/**
 * One issue: what Jira says, what the reviewer said, and what happens next.
 *
 * The layout answers a complaint that everything sat at the same weight —
 * seven buttons in the header, seven tabs under it, seven Jira chips under
 * that, and the approve/reject card at the *bottom of the review*, so on a
 * long one you scrolled past every finding to reach the only thing the tool
 * exists for. So:
 *
 *   - the decision is pinned to the foot of the panel and never scrolls;
 *   - the header carries the one action you would take next, and the rest
 *     live one click away in `⋯`;
 *   - four tabs instead of seven, grouped by what you are doing: reading the
 *     review, reading the change, handling the patch, or looking at how the
 *     review came about;
 *   - the Jira chips moved inside the description card they describe.
 *
 * Nothing was removed — every panel, button and field is still here, in the
 * place it belongs. Nothing starts on its own either: the list is a
 * read-only poll, a review begins when somebody presses a button, and
 * approving or rejecting is always a click.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { refreshList, state } from '../bridge';
import { connection, meta, metaError, openIssue, showTab, startPolling, stopPolling, tabs } from '../detail';
import { contextSelection, openModal } from '../uiState';
import { outcomeConfig } from '../appConfig';
import { session } from '../session';
import { formatDate, statusLabel } from '../format';
import StateNote from './StateNote.vue';

import ActionMenu from './ActionMenu.vue';
import DecisionBar from './DecisionBar.vue';
import DiffPanel from './DiffPanel.vue';
import FixButton from './FixButton.vue';
import FixPanel from './FixPanel.vue';
import HistoryPanel from './HistoryPanel.vue';
import NotesPanel from './NotesPanel.vue';
import PromptCards from './PromptCards.vue';
import ReviewPanel from './ReviewPanel.vue';
import VerifyPanel from './VerifyPanel.vue';

/**
 * Four tabs, and which of the panels' own counters each one speaks for.
 *
 * The counters are still reported per panel — VerifyPanel counts open
 * questions, HistoryPanel counts previous reviews — so grouping them here
 * costs nothing and no panel had to learn about tabs. `Review` shows the
 * count that means *you have something to answer*; the notes count is
 * informational and stays inside the notes card rather than turning the
 * tab's badge into a number of two different things added together.
 */
const TABS = [
  { name: 'review', label: 'Review', countKey: 'verify' },
  { name: 'diff', label: 'Değişiklik', countKey: 'diff' },
  { name: 'patch', label: 'Yama', countKey: 'patch' },
  { name: 'process', label: 'Süreç', countKey: 'history' },
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
    if (status === 'running' || status === 'queued') showTab('process', { pin: false });
    else if (hasReview) showTab('review', { pin: false });
  },
);

onMounted(() => {
  // A refresh comes back to the issue it was showing.
  const fromUrl = decodeURIComponent(location.hash.slice(1));
  if (fromUrl) openIssue(fromUrl);
});

const startError = ref('');

async function start(): Promise<void> {
  const issueKey = state.issueKey;
  if (!issueKey) return;
  startError.value = '';
  openIssue(issueKey, { force: true });
  showTab('process', { pin: false });

  /*
   * A refusal has to be said out loud.
   *
   * This used to be `.catch(() => {})` with the response thrown away, so
   * every way the server can decline — an issue Jira does not have, a
   * directory with nothing to review, an id it could not make sense of —
   * produced a button that did nothing and explained nothing. That is
   * exactly how "yeniden incele" failed silently on local reviews.
   */
  try {
    const response = await fetch(`/api/reviews/${encodeURIComponent(issueKey)}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextRepos: [...contextSelection.repos] }),
    });
    const body = await response.json().catch(() => ({}));
    if (body.error || !response.ok) {
      startError.value = body.error ?? `İnceleme başlatılamadı (HTTP ${response.status}).`;
      return;
    }
  } catch (err) {
    startError.value = `İnceleme başlatılamadı: ${(err as Error).message}`;
    return;
  }

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
          <span id="connState" class="error" role="status" aria-live="polite">
            {{ connection.error }}
          </span>

          <!--
            One action, and a menu.

            Whatever the review is doing, there is a single obvious next
            move: start it, or stop it. Everything else is occasional, and
            putting six buttons beside the one that matters made the reader
            re-read the row every time.
          -->
          <div class="detail-head-actions">
            <button v-if="inFlight" class="btn btn-reject" @click="stop">Durdur</button>
            <button v-else class="btn btn-primary" @click="start">{{ startLabel }}</button>

            <ActionMenu>
              <button v-if="inFlight" class="btn btn-ghost" :disabled="detail?.status === 'queued'" @click="start">
                {{ startLabel }}
              </button>
              <FixButton />
              <button
                v-if="session.configured"
                class="btn btn-ghost"
                title="Bu işi bir takım arkadaşına devret"
                @click="openModal('assign')"
              >
                Ata…
              </button>
              <button class="btn btn-ghost" @click="openModal('context')">Bağlam…</button>
              <!-- Apart from the others: everything above starts or continues
                   work, and this one throws it away. -->
              <button
                class="btn btn-ghost detachedAction"
                title="Bu görevin review durumunu sıfırla"
                @click="clear"
              >
                Temizle
              </button>
            </ActionMenu>
          </div>
        </div>

        <!-- Tabs, said so: without the roles a screen reader hears four
             unrelated buttons and no sense of which one is showing. The
             timestamp rides along at the end of the row because it describes
             the review these tabs are showing, not the issue. -->
        <nav class="tabs" role="tablist">
          <button
            v-for="tab in TABS"
            :key="tab.name"
            class="tab"
            :class="{ active: tabs.active === tab.name }"
            role="tab"
            :aria-selected="tabs.active === tab.name"
            @click="showTab(tab.name)"
          >
            {{ tab.label }}
            <span
              v-if="tabs.counts[tab.countKey]?.count"
              class="tab-count"
              :class="{ alert: tabs.counts[tab.countKey].alert }"
            >
              {{ tabs.counts[tab.countKey].count }}
            </span>
          </button>
          <span class="muted stampText">{{ stamp }}</span>
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
        <StateNote v-if="startError" kind="error">{{ startError }}</StateNote>
        <StateNote v-if="!detail" kind="loading">{{ state.issueKey }} okunuyor…</StateNote>

        <template v-else>
        <div v-if="detail.error" id="errorBox" role="alert">{{ detail.error }}</div>

        <!--
          Review: the findings, plus the two things you say back to them.

          Doğrulama and Notlar used to be tabs of their own, which meant
          disputing a finding happened on a screen where the finding was not
          visible. They are sections of this panel now, below the review they
          are about.
        -->
        <div class="panel" :class="{ active: tabs.active === 'review' }" role="tabpanel">
          <details class="card issue-desc-card">
            <summary>Jira açıklaması</summary>
            <!-- The same rule: Jira is a second request, and "(açıklama yok)"
                 before it answers is an answer nobody gave. -->
            <StateNote v-if="!meta && !metaError" kind="loading">Jira'dan okunuyor…</StateNote>
            <StateNote v-else-if="metaError" kind="error">{{ metaError }}</StateNote>
            <template v-else>
              <div class="meta-chips">
                <span v-for="[label, value] in chips" :key="label" class="meta-chip">
                  <b>{{ label }}</b>{{ value }}
                </span>
              </div>
              <div id="issueDesc">{{ meta?.description || '(açıklama yok)' }}</div>
            </template>
          </details>
          <ReviewPanel />
          <VerifyPanel />
          <NotesPanel />
        </div>

        <div class="panel" :class="{ active: tabs.active === 'diff' }" role="tabpanel"><DiffPanel /></div>
        <div class="panel" :class="{ active: tabs.active === 'patch' }" role="tabpanel"><FixPanel /></div>

        <!--
          Süreç: how this review came to exist — the live log, the exact
          prompts that were sent, and the reviews that came before it. All
          three answer "why does it say that", and none of them is something
          you read while deciding.
        -->
        <div class="panel" :class="{ active: tabs.active === 'process' }" role="tabpanel">
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
          <HistoryPanel />
        </div>
        </template>
      </div>

      <!-- Outside the scroller on purpose: the review scrolls, the decision
           does not. -->
      <DecisionBar v-if="detail" />
    </div>
  </section>
</template>
