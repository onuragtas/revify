<script setup lang="ts">
/**
 * Which other services the reviewer may read while judging this change.
 *
 * Picking one only decides what gets *cloned now*: once a repo is on disk it
 * stays available to every later review without being re-picked, which is
 * why the already-cloned ones sort first and come checked. The repos the
 * change itself touches are listed above, unpickable — they are not context,
 * they are the change.
 */
import { computed, onMounted, ref, watch } from 'vue';
import StateNote from './StateNote.vue';
import { host, state } from '../bridge';
import { closeModal, contextSelection, modals } from '../uiState';

interface Project {
  projectPath: string;
  cloned: boolean;
}

const projects = ref<Project[]>([]);
const message = ref('');
const filter = ref('');
const picked = ref<Record<string, boolean>>({});

async function load(): Promise<void> {
  message.value = 'projeler yükleniyor…';
  try {
    const data = await (await fetch('/api/projects')).json();
    if (data.error) {
      message.value = `Hata: ${data.error}`;
      return;
    }
    // Already-cloned first: they cost nothing and are the usual picks.
    projects.value = (data.items as Project[]).sort((a, b) =>
      a.cloned === b.cloned ? a.projectPath.localeCompare(b.projectPath) : a.cloned ? -1 : 1,
    );
    picked.value = Object.fromEntries(projects.value.map((p) => [p.projectPath, p.cloned]));
    message.value = '';
  } catch (err) {
    message.value = `Yüklenemedi: ${(err as Error).message}`;
  }
}

// Loaded when it is first needed, not on every page load: the list is a
// GitLab call and most runs never open this.
watch(
  () => modals.context,
  (open) => {
    if (open && !projects.value.length) void load();
  },
);
onMounted(() => {
  if (modals.context) void load();
});

const shown = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return projects.value;
  return projects.value.filter((p) => p.projectPath.toLowerCase().includes(needle));
});

// Published as it changes: starting a review still happens in the page, and
// by then this modal is closed.
watch(
  picked,
  () => {
    contextSelection.repos = Object.keys(picked.value).filter((p) => picked.value[p]);
  },
  { deep: true, immediate: true },
);

const changedRepos = computed(() =>
  (state.detail?.repoChanges ?? []).map((c) => `${c.branchName} — ${c.projectPath}`),
);

function start(): void {
  if (!state.issueKey) return;
  closeModal('context');
  host.startReview(state.issueKey);
}
</script>

<template>
  <div class="modal-backdrop open" @click.self="closeModal('context')">
    <div class="modal">
      <div class="modal-head">
        <h3>Bağlam projeleri</h3>
        <button
          class="btn btn-ghost btn-icon pushRight"
          title="Kapat"
          @click="closeModal('context')"
         aria-label="Kapat">
          ✕
        </button>
      </div>

      <div class="modal-body">
        <h4>Değişiklik yapılan repolar</h4>
        <div v-if="changedRepos.length">
          <div v-for="r in changedRepos" :key="r" class="repoRow">{{ r }}</div>
        </div>
        <div v-else class="muted">Jira geliştirme panelinde bağlı branch bulunamadı.</div>

        <h4>Klonlanacak projeler</h4>
        <p class="card-hint">
          Seçtiklerin klonlanır. Bir kez klonlanan proje diskte kalır ve sonraki tüm
          review'lerde ana branch'inden okunabilir — tekrar seçmen gerekmez.
        </p>
        <input v-model="filter" class="input" type="text" placeholder="Proje ara…" />

        <div id="projectList">
          <StateNote v-if="message" :kind="message.startsWith('projeler') ? 'loading' : 'error'">
            {{ message }}
          </StateNote>
          <StateNote v-else-if="!shown.length">eşleşen proje yok</StateNote>
          <label v-for="p in shown" :key="p.projectPath">
            <input v-model="picked[p.projectPath]" type="checkbox" />
            <span>{{ p.projectPath }}</span>
            <span v-if="p.cloned" class="clonedTag">klonlu</span>
          </label>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="closeModal('context')">Vazgeç</button>
        <button class="btn btn-primary" @click="start">Review'i başlat</button>
      </div>
    </div>
  </div>
</template>
