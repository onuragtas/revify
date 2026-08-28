<script setup lang="ts">
/**
 * Reviews that are finished and waiting on a person.
 *
 * The column that matters is how long each has been waiting: a review nobody
 * decides is a developer nobody unblocks, and that cost is invisible from
 * the issue list.
 */
import { onMounted, ref } from 'vue';
import StateNote from './StateNote.vue';
import { host, registerReloader } from '../bridge';
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
      <button class="btn pushRight" @click="load">↻ Yenile</button>
    </div>

    <StateNote v-if="loading" kind="loading">yükleniyor…</StateNote>
    <StateNote v-else-if="error" kind="error">{{ error }}</StateNote>
    <StateNote v-else-if="!rows.length">Onay bekleyen iş yok.</StateNote>

    <table v-else class="decisions">
      <thead>
        <tr><th>Issue</th><th>Özet</th><th>İncelendi</th><th>Bekliyor</th><th>Açık soru</th></tr>
      </thead>
      <tbody>
        <tr v-for="p in rows" :key="p.issueKey" class="clickable" @click="host.openIssue(p.issueKey)">
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
