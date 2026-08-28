<script setup lang="ts">
/**
 * Everything a human tells the *next* review.
 *
 * Three kinds, and they are not interchangeable — the difference is what the
 * next run is allowed to do with them:
 *
 * - **A revision request** is an instruction about the review itself.
 * - **An answer** to a `[?]` question is a fact the reviewer could not
 *   establish from the code, so the next run takes it as given.
 * - **An objection** is a claim about code that is right there to be read.
 *   The next run must *not* accept it: it goes and looks, then either
 *   withdraws the finding or defends it with evidence. Accepting it on
 *   assertion would turn the reviewer into a rubber stamp.
 *
 * All three take effect on the next review and not before, which is why
 * every card here offers "save" and "save and re-review" side by side.
 */
import { computed, ref, watch } from 'vue';
import { host, state } from '../bridge';
import { saveChallenges, saveClarifications, saveRevision } from '../api';
import { renderMarkdown } from '../markdown';

const detail = computed(() => state.detail);

/* ------------------------------- revision -------------------------------- */

const revision = ref('');
/** Never overwrite what is being typed: the detail panel re-polls every
 * second, and a mid-sentence reset would make the box unusable. */
const editingRevision = ref(false);

watch(
  () => [state.issueKey, detail.value?.revisionRequest] as const,
  ([, incoming]) => {
    if (!editingRevision.value) revision.value = incoming ?? '';
  },
  { immediate: true },
);

/* ----------------------------- clarifications ---------------------------- */

/**
 * Questions the review raised, plus any it has stopped raising.
 *
 * A question that was answered and then dropped by a later run still shows
 * its answer — otherwise the answer silently disappears and nobody can tell
 * whether it was ever given.
 */
const questions = computed(() => {
  const asked = [...(detail.value?.openQuestions ?? [])];
  for (const c of detail.value?.clarifications ?? []) {
    if (!asked.includes(c.question)) asked.push(c.question);
  }
  return asked;
});

const answers = ref<Record<string, string>>({});
const editingAnswers = ref(false);

watch(
  () => [state.issueKey, detail.value?.clarifications] as const,
  ([, incoming]) => {
    if (editingAnswers.value) return;
    answers.value = Object.fromEntries((incoming ?? []).map((c) => [c.question, c.answer]));
  },
  { immediate: true },
);

/* ------------------------------- challenges ------------------------------ */

/** Every finding can be disputed, and a dispute outlives the finding it was
 * raised against — the review may have dropped it since. */
const disputable = computed(() => {
  const rows = (detail.value?.findings ?? []).map((f) => ({ heading: f.heading, body: f.body }));
  for (const c of detail.value?.challenges ?? []) {
    if (!rows.some((r) => r.heading === c.finding)) rows.push({ heading: c.finding, body: '' });
  }
  return rows;
});

const objections = ref<Record<string, string>>({});
const editingObjections = ref(false);

watch(
  () => [state.issueKey, detail.value?.challenges] as const,
  ([, incoming]) => {
    if (editingObjections.value) return;
    objections.value = Object.fromEntries((incoming ?? []).map((c) => [c.finding, c.objection]));
  },
  { immediate: true },
);

/* -------------------------------- the tab -------------------------------- */

const unanswered = computed(() => questions.value.filter((q) => !answers.value[q]).length);
const disputes = computed(() => Object.values(objections.value).filter((o) => o.trim()).length);

watch(
  () => [unanswered.value, disputes.value, revision.value] as const,
  ([open, disputed, text]) => {
    // Unanswered questions are what needs attention, so that — not the
    // total — is what the tab advertises, and what makes it urgent.
    host.setTabCount('verify', open + disputed + (text.trim() ? 1 : 0), open > 0);
  },
  { immediate: true },
);

/* --------------------------------- saving -------------------------------- */

const saving = ref(false);

async function persist(): Promise<void> {
  const issueKey = state.issueKey;
  if (!issueKey) return;
  saving.value = true;
  try {
    await saveRevision(issueKey, revision.value.trim());
    await saveClarifications(
      issueKey,
      questions.value.map((question) => ({ question, answer: answers.value[question] ?? '' })),
    );
    await saveChallenges(
      issueKey,
      disputable.value.map((row) => ({ finding: row.heading, objection: objections.value[row.heading] ?? '' })),
    );
  } finally {
    saving.value = false;
    editingRevision.value = false;
    editingAnswers.value = false;
    editingObjections.value = false;
  }
  host.startPolling(issueKey);
}

async function persistAndRerun(): Promise<void> {
  const issueKey = state.issueKey;
  await persist();
  if (issueKey) host.startReview(issueKey);
}

async function clearRevision(): Promise<void> {
  revision.value = '';
  editingRevision.value = false;
  await persist();
}
</script>

<template>
  <div>
    <div class="card">
      <h3>Review'i düzelt</h3>
      <p class="card-hint">
        Review'in tamamı için serbest talimat — "şu bulguyu çıkar", "QA notlarını genişlet",
        "X'teki çağıranı atlamışsın". Kod hakkında bir iddia yazarsan <b>önce kontrol eder</b>,
        kod seni doğrulamazsa bulgusunu gerekçesiyle korur. Sildiğin an geçerliliği biter;
        silmezsen sonraki tüm incelemelerde uygulanır.
      </p>
      <textarea
        v-model="revision"
        rows="4"
        placeholder="ör. 2. bulgu geçersiz, o alan controller'da zaten valide ediliyor — kontrol et. Ayrıca QA notlarına ödeme ekranını da ekle."
        @focus="editingRevision = true"
      ></textarea>
      <div class="card-actions">
        <button class="btn" :disabled="saving" @click="persist">Kaydet</button>
        <button class="btn btn-primary" :disabled="saving" @click="persistAndRerun">
          Kaydet ve yeniden incele
        </button>
        <button class="btn btn-ghost" :disabled="saving" @click="clearRevision">Talimatı sil</button>
      </div>
    </div>

    <div v-if="questions.length" class="card">
      <h3>Doğrulanamayanlar</h3>
      <p class="card-hint">
        Review'in kendi başına doğrulayamadığı noktalar. Cevapladığında bir sonraki incelemede
        kesin bilgi olarak kullanılır — soru tekrar sorulmaz.
      </p>
      <div>
        <div v-for="q in questions" :key="q" class="qa-item" :class="{ done: answers[q] }">
          <div class="qa-label"><span class="qa-mark">?</span><span>{{ q }}</span></div>
          <textarea
            v-model="answers[q]"
            placeholder="Cevabın…"
            @focus="editingAnswers = true"
          ></textarea>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn" :disabled="saving" @click="persist">Cevapları kaydet</button>
        <button class="btn btn-primary" :disabled="saving" @click="persistAndRerun">
          Kaydet ve yeniden incele
        </button>
      </div>
    </div>

    <div v-if="disputable.length" class="card">
      <h3>Bulgulara itiraz</h3>
      <p class="card-hint">
        Bir bulgunun yanlış olduğunu düşünüyorsan nedenini yaz. Bir sonraki inceleme bunu
        <b>doğru kabul etmez</b> — ilgili kodu tekrar okuyup ya bulguyu geri çeker ya da
        kanıtıyla savunur.
      </p>
      <div>
        <div
          v-for="row in disputable"
          :key="row.heading"
          class="qa-item"
          :class="{ done: objections[row.heading] }"
        >
          <div class="qa-label">
            <span class="qa-mark">!</span>
            <span class="qa-finding">{{ row.heading }}</span>
          </div>
          <!-- The finding in full: what is wrong, the quoted lines, the
               impact. Judging an objection from a `file:line` heading alone
               would mean going back to the review for every one of them. -->
          <div v-if="row.body" class="findingBody" v-html="renderMarkdown(row.body)"></div>
          <textarea
            v-model="objections[row.heading]"
            placeholder="Bu bulgu neden yanlış? (boş bırakırsan itiraz yok sayılır)"
            @focus="editingObjections = true"
          ></textarea>
        </div>
      </div>
      <div class="card-actions">
        <button class="btn" :disabled="saving" @click="persist">İtirazları kaydet</button>
        <button class="btn btn-primary" :disabled="saving" @click="persistAndRerun">
          Kaydet ve tekrar doğrulat
        </button>
      </div>
    </div>

    <div v-if="detail?.withdrawn?.length" class="card">
      <h3>Geri çekilen bulgular</h3>
      <p class="card-hint">İtirazın üzerine kodu kontrol edip vazgeçtikleri. Jira'ya gitmez.</p>
      <ul id="withdrawnList">
        <li v-for="(w, i) in detail.withdrawn" :key="i">{{ w }}</li>
      </ul>
    </div>
  </div>
</template>
