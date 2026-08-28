<script setup lang="ts">
/**
 * The decision, where you can always reach it.
 *
 * This is what the whole tool is for, and it used to sit at the bottom of
 * the review — so on a long one you scrolled past every finding to act, and
 * on first opening an issue you could not tell a decision was waiting at
 * all. It is now pinned to the foot of the panel: the review scrolls, this
 * does not.
 *
 * Rejecting opens the reason field rather than shipping one blind. The
 * reason is optional, but it is the only thing the developer receiving the
 * change actually reads, so asking for it is worth one extra click.
 */
import { computed, nextTick, ref } from 'vue';
import { refreshList, reloadView, state } from '../bridge';
import { outcomeConfig } from '../appConfig';
import { startPolling } from '../detail';
import { statusLabel } from '../format';
import StateNote from './StateNote.vue';

const DECIDED: Record<string, 'approve' | 'reject'> = {
  approved: 'approve',
  posted: 'approve',
  rejected: 'reject',
};

const reason = ref('');
const rejecting = ref(false);
const busy = ref(false);
const error = ref('');
const reasonBox = ref<HTMLTextAreaElement | null>(null);

const decided = computed(() => DECIDED[state.detail?.status ?? '']);
const pending = computed(() => Boolean(state.detail?.review) && !decided.value);

/** A review of a directory has no issue behind it, so no transition, no
 * comment and no reassignment can follow from the decision. */
const local = computed(() => Boolean(state.detail?.local));

const outcomeSummary = computed(() => {
  if (!outcomeConfig.loaded) return '';
  if (local.value) return 'Yerel review — karar burada kaydedildi, Jira\'ya bir şey yazılmadı.';
  if (!outcomeConfig.applyChanges) {
    return "DRY RUN — Jira'ya hiçbir şey yazılmadı, yapılacaklar yalnızca loglandı.";
  }
  const status = decided.value === 'approve' ? outcomeConfig.approveStatus : outcomeConfig.rejectStatus;
  return `Jira'ya yazıldı, durum "${status}", issue geliştiriciye atandı.`;
});

/**
 * What the buttons will actually do — said plainly, because they look the
 * same however this machine is configured and whatever the review is about.
 *
 * Promising a Jira transition on a review that has no Jira issue is the
 * worst of the three: it is not a setting anybody can change, it simply
 * cannot happen.
 */
const hint = computed(() => {
  if (local.value) return "Yerel review — karar yalnızca burada kaydedilir, Jira'ya yazılmaz";
  return outcomeConfig.applyChanges
    ? `Onay → "${outcomeConfig.approveStatus}" · Red → "${outcomeConfig.rejectStatus}" · her ikisi de geliştiriciye atar`
    : "DRY RUN — Jira'ya yazılmaz";
});

function startReject(): void {
  rejecting.value = true;
  void nextTick(() => reasonBox.value?.focus());
}

async function decide(kind: 'approve' | 'reject'): Promise<void> {
  const issueKey = state.issueKey;
  if (!issueKey) return;

  if (outcomeConfig.applyChanges && !local.value) {
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
    rejecting.value = false;
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
  <footer v-if="pending" class="decisionBar">
    <div v-if="rejecting" class="decisionBar-reason">
      <textarea
        ref="reasonBox"
        v-model="reason"
        rows="2"
        placeholder="Red gerekçesi (opsiyonel — review'in üstünde Jira yorumuna eklenir)"
      ></textarea>
      <div class="decisionBar-row">
        <span class="card-hint grow">{{ hint }}</span>
        <button class="btn" :disabled="busy" @click="rejecting = false">Vazgeç</button>
        <button class="btn btn-reject" :disabled="busy" @click="decide('reject')">Reddet</button>
      </div>
    </div>

    <div v-else class="decisionBar-row">
      <span class="card-hint grow" :class="{ live: outcomeConfig.applyChanges && !local }">{{ hint }}</span>
      <button class="btn btn-reject" :disabled="busy" @click="startReject">Reddet</button>
      <button class="btn btn-approve" :disabled="busy" @click="decide('approve')">Onayla</button>
    </div>

    <StateNote v-if="error" kind="error">{{ error }}</StateNote>
  </footer>

  <footer v-else-if="decided" class="decisionBar decisionBar-done">
    <span class="badge" :class="`badge-${state.detail?.status}`">
      {{ statusLabel(state.detail?.status ?? '') }}
    </span>
    <span class="card-hint grow">{{ outcomeSummary }}</span>
    <span v-if="state.detail?.rejectionReason" class="card-hint">
      Gerekçe: {{ state.detail.rejectionReason }}
    </span>
  </footer>
</template>
