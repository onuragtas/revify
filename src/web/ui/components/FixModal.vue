<script setup lang="ts">
/**
 * Which findings to fix, and how.
 *
 * Two rules this screen exists to enforce, both of them decisions a human
 * makes and the tool must not make for them:
 *
 * - A finding they have **disputed** is offered unchecked, with the
 *   objection shown. They said it was wrong; writing code to satisfy it
 *   anyway would be the tool arguing with them. Naming it explicitly still
 *   fixes it — the default is a default, not a veto.
 * - A finding that offered options carries an **instruction** box. The
 *   reviewer is told to give options rather than invent an answer when the
 *   right fix turns on something it cannot see; this is the only channel
 *   that reaches the patch. An objection prefills it, because people write
 *   "1. seçenek yapılmalı" there and losing it is how a human's call
 *   silently fails to reach the code.
 */
import { computed, ref, watch } from 'vue';
import { state, host } from '../bridge';
import { startFix } from '../api';
import { checkedByDefault, disputes, findings, fixUi, revisionPending } from '../fixState';

const picked = ref<Record<string, boolean>>({});
const instructions = ref<Record<string, string>>({});
const result = ref('');
const starting = ref(false);

// Opening is what seeds the form: the defaults depend on what the review
// says right now, not on what it said when the panel was last rendered.
watch(
  () => fixUi.modalOpen,
  (open) => {
    if (!open) return;
    result.value = '';
    picked.value = Object.fromEntries(
      findings.value.map((f) => [f.id, checkedByDefault(f.heading, f.severity)]),
    );
    instructions.value = Object.fromEntries(
      findings.value.map((f) => [f.id, disputes.value.get(f.heading) ?? '']),
    );
  },
);

const chosen = computed(() => findings.value.filter((f) => picked.value[f.id]));

const pendingNote = computed(() => {
  const parts: string[] = [];
  const disputed = findings.value.filter((f) => disputes.value.has(f.heading)).length;
  if (disputed) parts.push(`${disputed} bulguya itiraz ettin`);
  if (revisionPending.value) parts.push('bekleyen bir "Review’i düzelt" talebin var');
  return parts.join(', ');
});

function close(): void {
  fixUi.modalOpen = false;
}

async function confirm(): Promise<void> {
  if (!chosen.value.length || !state.issueKey) return;
  const issueKey = state.issueKey;
  starting.value = true;
  result.value = 'başlatılıyor…';

  try {
    // Only for findings actually being fixed — an instruction on an
    // unchecked one is a note to nobody.
    const withInstructions = Object.fromEntries(
      chosen.value
        .map((f) => [f.id, (instructions.value[f.id] ?? '').trim()] as const)
        .filter(([, text]) => text),
    );
    await startFix(issueKey, chosen.value.map((f) => f.id), withInstructions);
  } catch (err) {
    result.value = (err as Error).message;
    return;
  } finally {
    starting.value = false;
  }

  // Started. Nothing past this point may report it as a failure — the run is
  // queued, and saying otherwise would invite a second one.
  close();
  host.showTab('patch');
  host.startPolling(issueKey);
}
</script>

<template>
  <div class="modal-backdrop" :class="{ open: fixUi.modalOpen }" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <h3>Düzelt</h3>
        <button class="btn btn-ghost btn-icon pushRight" title="Kapat" @click="close" aria-label="Kapat">✕</button>
      </div>

      <div class="modal-body">
        <p class="card-hint">
          Seçtiğin bulgular için kod değişikliği üretilir ve <b>yama</b> olarak Yama sekmesinde
          bekler. Repo'nun ayrı bir kopyasında çalışılır: ne senin çalışma kopyan değişir, ne de
          bir şey commitlenir. Yamayı sonra istediğin dizine uygularsın.
        </p>

        <p v-if="pendingNote" class="card-hint">
          {{ pendingNote }} — bunlar ancak <b>Yeniden incele</b> ile işlenir. İtiraz ettiğin
          bulgular aşağıda işaretsiz geliyor; yine de düzeltilmesini istiyorsan kendin işaretle.
        </p>

        <h4>Bulgular</h4>
        <div>
          <div
            v-for="f in findings"
            :key="f.id"
            class="findingRow"
            :class="{ disputed: disputes.has(f.heading) }"
          >
            <label class="findingPick">
              <input v-model="picked[f.id]" type="checkbox" />
              <span>
                <span class="sev" :class="`sev-${f.severity}`">{{ f.severity }}</span>
                {{ f.heading }}
                <span v-if="disputes.get(f.heading)" class="objection">
                  <b>İtirazın:</b> {{ disputes.get(f.heading) }} — bunu düzeltme talimatı olarak
                  kullanmak istiyorsan aşağıda duruyor.
                </span>
              </span>
            </label>
            <textarea
              v-model="instructions[f.id]"
              rows="1"
              placeholder="Nasıl düzeltilsin? Bulgu seçenek sunuyorsa hangisi — opsiyonel"
            ></textarea>
          </div>
          <div v-if="!findings.length" class="section-empty">
            Bu review'da düzeltilecek bulgu yok.
          </div>
        </div>

        <div class="card-hint">{{ result }}</div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="close">Vazgeç</button>
        <button class="btn btn-primary" :disabled="!chosen.length || starting" @click="confirm">
          {{ chosen.length ? `Yama üret (${chosen.length})` : 'Yama üret' }}
        </button>
      </div>
    </div>
  </div>
</template>
