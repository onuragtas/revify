<script setup lang="ts">
/**
 * Everything already decided, next to where the ticket stands *now*.
 *
 * The decision this tool recorded and the issue's actual fate are two
 * different facts: an approved change can sit in Ready for Stage for a week,
 * and a rejected one can come back fixed. Showing only what we decided would
 * be a log of our own opinions — the live Jira status beside it is what makes
 * this a follow-up view.
 */
import { onMounted, ref } from 'vue';
import StateNote from './StateNote.vue';
import { host, registerReloader } from '../bridge';
import { readDecisions, type DecisionRow } from '../api';
import { formatDate, statusLabel } from '../format';

const rows = ref<DecisionRow[]>([]);
const jiraBaseUrl = ref('');
const error = ref('');
const loading = ref(true);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const data = await readDecisions();
    rows.value = data.items;
    jiraBaseUrl.value = data.jiraBaseUrl;
    host.setViewCount('decisions', data.items.length);
  } catch (err) {
    error.value = `Yüklenemedi: ${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  registerReloader('decisions', load);
  void load();
});

function jiraUrl(issueKey: string): string {
  return `${jiraBaseUrl.value}/browse/${encodeURIComponent(issueKey)}`;
}
</script>

<template>
  <div>
    <div class="decisions-head">
      <div>
        <h2>Kararlar</h2>
        <p class="card-hint tight">
          Onayladığın ve reddettiğin işler, <b>Jira'daki güncel durumlarıyla</b> birlikte — karar
          verildiği andaki hâliyle değil. Akıbetini buradan takip edebilirsin.
        </p>
      </div>
      <button id="decisionsRefresh" class="btn pushRight" @click="load">
        ↻ Yenile
      </button>
    </div>

    <StateNote v-if="loading" kind="loading">yükleniyor…</StateNote>
    <StateNote v-else-if="error" kind="error">{{ error }}</StateNote>
    <StateNote v-else-if="!rows.length">Henüz karar verilmiş bir iş yok.</StateNote>

    <table v-else class="decisions">
      <thead>
        <tr>
          <th>Issue</th><th>Özet</th><th>Karar</th><th>Veren</th>
          <th>Karar zamanı</th><th>Jira durumu</th><th>Atanan</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in rows" :key="d.issueKey">
          <td class="nowrap">
            <a class="jiraLink" target="_blank" rel="noopener" :href="jiraUrl(d.issueKey)">
              {{ d.issueKey }}
            </a>
          </td>
          <td data-label="Özet">
            {{ d.summary ?? '—' }}
            <div v-if="d.rejectionReason" class="decisionReason">{{ d.rejectionReason }}</div>
          </td>
          <td class="nowrap" data-label="Karar">
            <span class="badge" :class="`badge-${d.decision}`">{{ statusLabel(d.decision) }}</span>
            <span v-if="d.severity" class="sev" :class="`sev-${d.severity}`">{{ d.severity }}</span>
          </td>
          <!-- Whose call it was. A decision made on another machine has a
               name; your own does not need one. -->
          <td class="nowrap muted" data-label="Veren">
            {{ d.local ? 'sen' : (d.decidedByName ?? 'takım') }}
          </td>
          <td class="nowrap muted" data-label="Karar zamanı">{{ formatDate(d.decidedAt) }}</td>
          <td class="nowrap" data-label="Jira durumu">
            <template v-if="d.jiraStatus">{{ d.jiraStatus }}</template>
            <span v-else class="muted">{{ d.local ? 'okunamadı' : '—' }}</span>
          </td>
          <td class="nowrap muted" data-label="Atanan">{{ d.assignee ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
