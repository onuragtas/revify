<script setup lang="ts">
/**
 * Reviews that are finished and waiting on a person.
 *
 * The column that matters is how long each has been waiting: a review nobody
 * decides is a developer nobody unblocks, and that cost is invisible from
 * the issue list.
 */
import { computed, onMounted, ref, watch } from 'vue';
import StateNote from './StateNote.vue';
import { host, registerReloader } from '../bridge';
import { deleteReview } from '../api';
import { formatDate, sinceText } from '../format';

interface PendingRow {
  issueKey: string;
  summary: string | null;
  reviewedAt: string;
  reviewSeq?: number;
  openQuestions?: number;
  trigger?: 'manual' | 'auto';
}

const rows = ref<PendingRow[]>([]);
const error = ref('');
const loading = ref(true);

/* ------------------------------- selection ------------------------------- */

/**
 * Clearing is destructive and usually plural.
 *
 * A row here is a review waiting on a decision, and the reason to clear one
 * is almost always "these are stale, wipe them" — a handful at a time.
 * One button per row would mean a destructive control sitting inside a row
 * whose whole surface opens the review, which is a misclick waiting to
 * happen; and clearing twenty of them one at a time is exactly the tedium
 * this replaces.
 */
const picked = ref<Set<string>>(new Set());
const clearing = ref(false);

const allPicked = computed(() => rows.value.length > 0 && picked.value.size === rows.value.length);

function toggle(issueKey: string): void {
  const next = new Set(picked.value);
  if (!next.delete(issueKey)) next.add(issueKey);
  picked.value = next;
}

function toggleAll(): void {
  picked.value = allPicked.value ? new Set() : new Set(rows.value.map((r) => r.issueKey));
}

// A refreshed list is a different list; a selection pointing at rows that
// are no longer there would clear whatever took their place.
watch(rows, () => (picked.value = new Set()));

/**
 * Wipes the review state of everything selected.
 *
 * One request per issue rather than a bulk endpoint: the server already has
 * this route, each is independent, and a failure halfway through leaves the
 * rest cleared rather than an unclear partial state — reported by name so
 * the reader knows exactly which ones survived.
 */
async function clearPicked(): Promise<void> {
  const keys = [...picked.value];
  if (!keys.length) return;

  const shown = keys.slice(0, 5).join(', ') + (keys.length > 5 ? `, +${keys.length - 5}` : '');
  if (!confirm(`${keys.length} iş için review, geçmiş ve cevaplar silinsin mi?\n\n${shown}\n\n(klonlanan repolar korunur)`)) {
    return;
  }

  clearing.value = true;
  error.value = '';
  const failed: string[] = [];
  for (const issueKey of keys) {
    try {
      await deleteReview(issueKey);
    } catch {
      failed.push(issueKey);
    }
  }
  clearing.value = false;
  // Reload first, then report: `load` clears the error line, so setting it
  // beforehand would erase the very thing this has to say. The list shows
  // what is true now; the message says what did not happen.
  await load();
  if (failed.length) error.value = `Temizlenemedi: ${failed.join(', ')}`;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    rows.value = (await (await fetch('/api/pending')).json()).items ?? [];
  } catch (err) {
    error.value = `Yüklenemedi: ${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  registerReloader('pending', load);
  void load();
});
</script>

<template>
  <div>
    <div class="decisions-head">
      <div>
        <h2>Onay bekleyenler</h2>
        <p class="card-hint tight">
          İncelemesi bitmiş, kararını bekleyen işler — en uzun bekleyen en üstte.
          Satıra tıklayınca review'ı açar.
        </p>
      </div>
      <button
        v-if="picked.size"
        class="btn btn-reject pushRight"
        :disabled="clearing"
        @click="clearPicked"
      >
        {{ picked.size }} işi temizle
      </button>
      <button class="btn" :class="{ pushRight: !picked.size }" @click="load">↻ Yenile</button>
    </div>

    <StateNote v-if="loading" kind="loading">yükleniyor…</StateNote>
    <StateNote v-else-if="error" kind="error">{{ error }}</StateNote>
    <StateNote v-else-if="!rows.length">Onay bekleyen iş yok.</StateNote>

    <table v-else class="decisions">
      <thead>
        <tr>
          <th class="pickCol">
            <input
              type="checkbox"
              :checked="allPicked"
              title="Tümünü seç"
              aria-label="Tümünü seç"
              @change="toggleAll"
            />
          </th>
          <th>Issue</th><th>Özet</th><th>İncelendi</th><th>Bekliyor</th><th>Açık soru</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="p in rows"
          :key="p.issueKey"
          class="clickable"
          :class="{ picked: picked.has(p.issueKey) }"
          @click="host.openIssue(p.issueKey)"
        >
          <!-- The row opens the review; the checkbox must not. -->
          <td class="pickCol" data-label="" @click.stop>
            <input
              type="checkbox"
              :checked="picked.has(p.issueKey)"
              :aria-label="`${p.issueKey} seç`"
              @change="toggle(p.issueKey)"
            />
          </td>
          <td class="nowrap">
            <span class="issue-key">{{ p.issueKey }}</span>
            <span v-if="p.trigger === 'auto'" class="autoTag">oto</span>
          </td>
          <td data-label="Özet">{{ p.summary ?? '—' }}</td>
          <td class="nowrap muted" data-label="İncelendi">
            {{ formatDate(p.reviewedAt) }}<template v-if="p.reviewSeq"> · #{{ p.reviewSeq }}</template>
          </td>
          <td class="nowrap waitFor" data-label="Bekliyor">{{ sinceText(p.reviewedAt) }}</td>
          <td class="nowrap" data-label="Açık soru">
            <span v-if="p.openQuestions" class="autoTag">{{ p.openQuestions }}</span>
            <template v-else>—</template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
