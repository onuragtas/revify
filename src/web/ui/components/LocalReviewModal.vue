<script setup lang="ts">
/**
 * "This branch looks like BUY-2397. Is it?"
 *
 * A branch called `feature/BUY-2397-km-muayene` almost certainly belongs to
 * that ticket. Almost certainly is enough to *read* Jira and nowhere near
 * enough to comment on it, move its status and reassign it — which is what
 * approving an attached review does. So the guess is shown with the
 * ticket's own summary beside it, because nobody can confirm a bare string,
 * and the answer is a person's.
 *
 * Three ways out, all of them explicit:
 *   - confirm the guess → the classic flow, attached to that issue;
 *   - type a different key → the same, once Jira agrees it exists;
 *   - decline → a local review; the decision is recorded here and nothing
 *     is written anywhere.
 *
 * Asking before the run rather than after is what makes it free. Attaching
 * afterwards would mean re-running the whole review under a new id.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { host } from '../bridge';
import { closeModal, localReviewTarget } from '../uiState';
import { inspectLocalPath, readIssueSummary, startReviewByPath, type IssueSummary, type LocalInspection } from '../api';
import StateNote from './StateNote.vue';

const inspection = ref<LocalInspection | null>(null);
const loadError = ref('');
const busy = ref(false);
const result = ref('');

/** Whether the review will be attached to a Jira issue, and to which. */
const attach = ref(false);
const key = ref('');
const issue = ref<IssueSummary | null>(null);
const checking = ref(false);
/** Set the moment the reader touches the checkbox: after that the tick is
 * theirs and no lookup may move it. */
const chosen = ref(false);

const close = () => closeModal('localReview');

onMounted(async () => {
  try {
    const data = await inspectLocalPath(localReviewTarget.path);
    inspection.value = data;
    key.value = data.suggestedIssueKey ?? '';
  } catch (err) {
    loadError.value = (err as Error).message;
  }
});

/*
 * Resolve whatever key is in the box — the branch's guess and a typed
 * correction alike.
 *
 * One path rather than two: the suggestion could have been resolved
 * server-side during the inspect, and then the same question would have had
 * two answers that could disagree. A typo caught here costs a dialog;
 * caught after the run it costs a review written against the wrong ticket,
 * and a comment on somebody else's issue.
 */
let checkToken = 0;
watch(
  key,
  async (value) => {
    const wanted = value.trim().toUpperCase();
    issue.value = null;
    if (!wanted) return;
    const token = ++checkToken;
    checking.value = true;
    try {
      const found = await readIssueSummary(wanted);
      if (token !== checkToken) return;
      issue.value = found;
      // The suggestion is offered ticked only once Jira has confirmed it
      // exists. A guess that could not be checked is not a default —
      // offline is not the same as "no such issue", and neither is a
      // licence to comment on a ticket.
      if (!chosen.value) attach.value = !found.error;
    } catch (err) {
      if (token === checkToken) issue.value = { key: wanted, error: (err as Error).message };
    } finally {
      if (token === checkToken) checking.value = false;
    }
  },
  { immediate: true },
);

/** Attaching is only allowed to an issue Jira has actually confirmed. */
const confirmed = computed(() => Boolean(issue.value && !issue.value.error));
const canStart = computed(() => Boolean(inspection.value) && !busy.value && (!attach.value || confirmed.value));

const outcome = computed(() =>
  attach.value && confirmed.value
    ? `Onayla/Reddet ${issue.value!.key} üzerine yorum yazar, durumu geçirir ve issue'yu geliştiriciye atar.`
    : "Yerel review — karar yalnızca burada kaydedilir, Jira'ya bir şey yazılmaz.",
);

async function start(): Promise<void> {
  if (!inspection.value) return;
  busy.value = true;
  result.value = 'başlatılıyor…';
  try {
    const started = await startReviewByPath(
      inspection.value.path,
      attach.value && confirmed.value ? issue.value!.key : '',
    );
    close();
    host.openIssue(started.issueKey);
  } catch (err) {
    result.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop open" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <h3>Yerel dizini incele</h3>
        <button class="btn btn-ghost btn-icon pushRight" title="Kapat" @click="close" aria-label="Kapat">✕</button>
      </div>

      <div class="modal-body">
        <StateNote v-if="loadError" kind="error">{{ loadError }}</StateNote>
        <StateNote v-else-if="!inspection" kind="loading">Dizin okunuyor…</StateNote>

        <template v-else>
          <div class="meta-chips">
            <span class="meta-chip"><b>Proje</b>{{ inspection.projectPath }}</span>
            <span class="meta-chip"><b>Dal</b>{{ inspection.branch }}</span>
            <span v-if="inspection.baseBranch" class="meta-chip"><b>Taban</b>{{ inspection.baseBranch }}</span>
            <span class="meta-chip"><b>Dosya</b>{{ inspection.files }}</span>
          </div>

          <h4>Jira issue'su</h4>
          <p class="card-hint">
            <template v-if="inspection.suggestedIssueKey">
              Dal adı <b>{{ inspection.suggestedIssueKey }}</b> issue'suna işaret ediyor. Doğruysa
              bağla; değilse anahtarı düzelt ya da bağlamadan devam et.
            </template>
            <template v-else>
              Dal adı bir issue anahtarı içermiyor. Bir tane yazarsan review o issue'ya bağlanır.
            </template>
          </p>

          <label class="checkRow pointer">
            <input v-model="attach" type="checkbox" @change="chosen = true" />
            <span>Bu review'i bir Jira issue'suna bağla</span>
          </label>

          <div v-if="attach" class="localAttach">
            <input v-model="key" class="input nudgeInput" type="text" placeholder="BUY-2397" />
            <span v-if="checking" class="card-hint tight">Jira'ya soruluyor…</span>
            <span v-else-if="issue?.error" class="card-hint tight warn">{{ issue.error }}</span>
            <span v-else-if="issue?.summary" class="card-hint tight">
              {{ issue.key }} · {{ issue.summary }}<template v-if="issue.status"> · {{ issue.status }}</template>
            </span>
          </div>

          <p class="card-hint spaced" :class="{ live: attach && confirmed }">{{ outcome }}</p>
          <StateNote v-if="result" kind="error">{{ result }}</StateNote>
        </template>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="close">Vazgeç</button>
        <button class="btn btn-primary" :disabled="!canStart" @click="start">İncele</button>
      </div>
    </div>
  </div>
</template>
