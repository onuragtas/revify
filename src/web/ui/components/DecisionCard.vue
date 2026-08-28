<script setup lang="ts">
/**
 * Approve or reject — and, once decided, what was actually done.
 *
 * A decision is final here: it has already been written to Jira. Leaving the
 * buttons on screen afterwards says nothing happened and invites a second,
 * contradictory write, so once it is decided they give way to a plain
 * statement of the outcome.
 */
import { computed, ref } from 'vue';
import StateNote from './StateNote.vue';
import { refreshList, reloadView, state } from '../bridge';
import { outcomeConfig } from '../appConfig';
import { startPolling } from '../detail';
import { statusLabel } from '../format';

const DECIDED: Record<string, 'approve' | 'reject'> = {
  approved: 'approve',
  posted: 'approve',
  rejected: 'reject',
};

const reason = ref('');
const busy = ref(false);
const error = ref('');

const decided = computed(() => DECIDED[state.detail?.status ?? '']);
const showDecision = computed(() => Boolean(state.detail?.review) && !decided.value);

const hint = computed(() =>
  outcomeConfig.applyChanges
    ? `Onayla → Jira'da yorum + durum "${outcomeConfig.approveStatus}" + geliştiriciye atama. ` +
      `Reddet → yorum + durum "${outcomeConfig.rejectStatus}" + geliştiriciye atama.`
    : "DRY RUN: Jira'ya hiçbir şey yazılmaz, yapılacaklar yalnızca loglanır " +
      '(config/config.yaml → jira.applyChanges).',
);

const outcomeSummary = computed(() => {
  if (!outcomeConfig.loaded) return '';
  if (!outcomeConfig.applyChanges) {
    return "DRY RUN — Jira'ya hiçbir şey yazılmadı, yapılacaklar yalnızca loglandı.";
  }
  const status = decided.value === 'approve' ? outcomeConfig.approveStatus : outcomeConfig.rejectStatus;
  return `Jira'ya review yorumu yazıldı, durum "${status}" yapıldı ve issue review öncesindeki geliştiriciye atandı.`;
});

async function decide(kind: 'approve' | 'reject'): Promise<void> {
  const issueKey = state.issueKey;
  if (!issueKey) return;

  if (outcomeConfig.applyChanges) {
    const status = kind === 'approve' ? outcomeConfig.approveStatus : outcomeConfig.rejectStatus;
    const question =
      kind === 'approve'
        ? `${issueKey} Jira'da "${status}" durumuna alınacak ve geliştiriciye atanacak. Onaylıyor musun?`
        : `${issueKey} Jira'da "${status}" durumuna alınacak, review ve gerekçe yorum olarak yazılacak. Devam edilsin mi?`;
    if (!confirm(question)) return;
  }

  busy.value = true;
  error.value = '';
  try {
    const data = await (
      await fetch(`/api/reviews/${encodeURIComponent(issueKey)}/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: kind === 'reject' ? JSON.stringify({ reason: reason.value.trim() }) : undefined,
      })
    ).json();
    // The status advances only on a confirmed outcome; a decision this tool
    // could not carry out has to say so rather than look like it worked.
    if (data.error) {
      error.value = data.error;
      return;
    }
    reason.value = '';
    startPolling(issueKey);
    refreshList();
    reloadView('decisions');
  } catch (err) {
    error.value = `Karar uygulanamadı: ${(err as Error).message}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="showDecision" class="card decision">
    <h3>Karar</h3>
    <p id="outcomeHint" :class="{ live: outcomeConfig.applyChanges }">{{ hint }}</p>
    <textarea
      v-model="reason"
      placeholder="Red gerekçesi (opsiyonel — yazarsan review'in üstünde Jira yorumuna eklenir)"
    ></textarea>
    <div class="card-actions">
      <button class="btn btn-approve" :disabled="busy" @click="decide('approve')">Onayla</button>
      <button class="btn btn-reject" :disabled="busy" @click="decide('reject')">Reddet</button>
    </div>
    <StateNote v-if="error" kind="error">{{ error }}</StateNote>
  </div>

  <div v-else-if="decided" class="card">
    <h3>
      <span class="badge" :class="`badge-${state.detail?.status}`">
        {{ statusLabel(state.detail?.status ?? '') }}
      </span>
      <span>{{ decided === 'approve' ? 'Onaylandı' : 'Reddedildi' }}</span>
    </h3>
    <p class="card-hint">{{ outcomeSummary }}</p>
    <div v-if="state.detail?.rejectionReason" class="qa-item">
      <div class="qa-label">
        <span class="qa-mark">!</span>
        <span>{{ state.detail.rejectionReason }}</span>
      </div>
    </div>
  </div>
</template>
