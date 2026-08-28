<script setup lang="ts">
/**
 * Work a team-mate handed you.
 *
 * The review still runs on *your* machine against your credentials; the
 * server only remembers who gave what to whom. Closing one is saying "done
 * with it", which is why the button is the only thing here that writes.
 */
import { onMounted, ref } from 'vue';
import StateNote from './StateNote.vue';
import { host, registerReloader } from '../bridge';
import { closeAssignment, readAssignments, type AssignmentRow } from '../api';
import { sinceText } from '../format';

const rows = ref<AssignmentRow[]>([]);
const loading = ref(true);

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = (await readAssignments()).items ?? [];
  } catch {
    // No backend, or no session. An empty list is the honest answer; the tab
    // itself is hidden when there is no server to ask.
    rows.value = [];
  } finally {
    loading.value = false;
  }
  // Something waiting on you is worth a louder badge than a count.
  host.setViewCount('assigned', rows.value.length, rows.value.length > 0);
}

onMounted(() => {
  registerReloader('assigned', load);
  void load();
});

const error = ref('');

async function close(row: AssignmentRow): Promise<void> {
  error.value = '';
  try {
    await closeAssignment(row.teamId, row.issueKey);
  } catch (err) {
    // The row simply stays, which reads as "nothing happened" — true, but
    // only this says why.
    error.value = `${row.issueKey} kapatılamadı: ${(err as Error).message}`;
  }
  await load();
}
</script>

<template>
  <div>
    <div class="decisions-head">
      <div>
        <h2>Bana atananlar</h2>
        <p class="card-hint tight">
          Takım arkadaşlarının sana devrettiği işler. Review <b>senin makinende</b> çalışır —
          burada yalnızca kimin neyi kime verdiği tutulur.
        </p>
      </div>
      <button class="btn pushRight" @click="load">↻ Yenile</button>
    </div>

    <StateNote v-if="error" kind="error">{{ error }}</StateNote>
    <StateNote v-if="loading" kind="loading">yükleniyor…</StateNote>
    <StateNote v-else-if="!rows.length">Sana atanmış iş yok.</StateNote>

    <table v-else class="decisions">
      <thead>
        <tr><th>Issue</th><th>Özet</th><th>Not</th><th>Atayan</th><th>Ne zaman</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="a in rows" :key="a.issueKey">
          <td class="nowrap">
            <span class="issue-key pointer" @click="host.openIssue(a.issueKey)">
              {{ a.issueKey }}
            </span>
          </td>
          <td data-label="Özet">{{ a.summary || '—' }}</td>
          <td data-label="Not">{{ a.note || '—' }}</td>
          <td class="nowrap muted" data-label="Atayan">{{ a.assignedByName || '—' }}</td>
          <td class="nowrap muted" data-label="Ne zaman">{{ sinceText(a.assignedAt) }} önce</td>
          <td class="nowrap"><button class="btn" @click="close(a)">Bitti</button></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
