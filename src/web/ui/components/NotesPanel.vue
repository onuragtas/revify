<script setup lang="ts">
/**
 * Standing rules for this codebase, and what the last review did with them.
 *
 * A note is a decision the team already argued and settled — "don't report
 * missing tests here". The review honours it by not reporting; the fix
 * honours it by writing code that obeys it. Which is why the panel also
 * shows what was *suppressed*: a note applied silently is indistinguishable
 * from a reviewer that simply missed something.
 */
import { computed, ref, watch } from 'vue';
import { host, state } from '../bridge';
import { addNote, deleteNote } from '../api';

const detail = computed(() => state.detail);
const notes = computed(() => detail.value?.notes ?? []);
const appliedNotes = computed(() => detail.value?.appliedNotes ?? []);

/** Repo-scoped notes need a repo, and an issue has one only once its review
 * has found a branch. */
const projectPath = computed(() => detail.value?.projectPaths?.[0] ?? null);

const text = ref('');
const scope = ref<'global' | 'repo'>('global');
const error = ref('');

/*
 * Repo-scoped by default when the repo is known.
 *
 * The screen this replaces built its options as `[this repo, all projects]`
 * and a select takes its first option — so a note typed without touching the
 * dropdown applied to one project. Defaulting to "all projects" instead
 * would quietly widen every note somebody wrote in a hurry.
 *
 * `immediate` because the issue usually has its repo before this mounts, so
 * waiting for a *change* would never fire.
 */
watch(
  projectPath,
  (path) => {
    if (!path) scope.value = 'global';
    else if (!text.value) scope.value = 'repo';
  },
  { immediate: true },
);

watch(notes, () => host.setTabCount('notes', notes.value.length), { immediate: true });

async function add(): Promise<void> {
  const body = text.value.trim();
  if (!body) return;
  error.value = '';
  try {
    // `.value`, and no cast: `projectPath` is a computed ref, and passing the
    // ref itself made JSON.stringify choke on Vue's own circular structure —
    // the request never left. The cast that silenced TypeScript is why that
    // was possible at all.
    await addNote({
      scope: scope.value,
      // Only when it means something. The store nulls it for a global note
      // anyway; sending a path beside "all projects" just reads as a
      // contradiction to anyone looking at the request.
      projectPath: scope.value === 'repo' ? projectPath.value : null,
      text: body,
    });
  } catch (err) {
    error.value = `Not eklenemedi: ${(err as Error).message}`;
    return;
  }
  text.value = '';
  host.refreshNotes();
}

async function remove(id: string): Promise<void> {
  try {
    await deleteNote(id);
  } catch (err) {
    error.value = (err as Error).message;
    return;
  }
  host.refreshNotes();
}
</script>

<template>
  <div>
    <div v-if="appliedNotes.length" class="card">
      <h3>Uygulanan notlar</h3>
      <p class="card-hint">
        Review'in hangi notları uygulayıp neyi yazmadığı. Yalnızca bizim için — Jira yorumuna
        dahil edilmez.
      </p>
      <ul id="appliedNotesList">
        <li v-for="(n, i) in appliedNotes" :key="i">{{ n }}</li>
      </ul>
    </div>

    <div class="card">
      <h3>Review notları</h3>
      <p class="card-hint">
        "Bunu bu projede dikkate alma" gibi kalıcı kurallar. Sonraki review'lerde uygulanır ve
        review sonunda hangi notların uygulandığı açıkça yazılır.
      </p>

      <ul id="notesList">
        <li v-if="!notes.length" id="notesEmpty">Henüz not yok.</li>
        <li v-for="n in notes" :key="n.id">
          <span class="noteScope">{{ n.scope === 'global' ? 'tüm projeler' : n.projectPath }}</span>
          <span class="noteText">{{ n.text }}</span>
          <button class="delNoteBtn" @click="remove(n.id)">sil</button>
        </li>
      </ul>

      <div class="note-add">
        <input
          v-model="text"
          class="input"
          type="text"
          placeholder="ör. Bu projede test eksikliğini bulgu olarak yazma"
          @keydown.enter="add"
        />
        <select v-model="scope">
          <option v-if="projectPath" value="repo">Sadece {{ projectPath }}</option>
          <option value="global">Tüm projeler</option>
        </select>
        <button class="btn" @click="add">Ekle</button>
      </div>
      <div v-if="error" class="card-hint">{{ error }}</div>
    </div>
  </div>
</template>
