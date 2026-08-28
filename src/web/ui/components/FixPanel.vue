<script setup lang="ts">
/**
 * The Yama tab: what the fixer produced, and where to put it.
 *
 * Nothing here changes anyone's code by itself. The run produces a patch in
 * a throwaway copy of the repo; applying it is a separate click against a
 * directory you name, and even then it lands uncommitted so you read it
 * before it becomes yours.
 */
import { computed, ref, watch } from 'vue';
import StateNote from './StateNote.vue';
import { host, state, type FixPatchView } from '../bridge';
import { applyPatch, clearFix, patchUrl, readPatch, stopFix } from '../api';
import { busy, fix } from '../fixState';

const STATUS_TR: Record<string, string> = {
  queued: 'kuyrukta',
  running: 'çalışıyor',
  ready: 'hazır',
  failed: 'hata',
  cancelled: 'durduruldu',
};
/** Reuses the review badges, so a fix reads with the same vocabulary. */
const STATUS_BADGE: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  ready: 'approved',
  failed: 'failed',
  cancelled: 'cancelled',
};

const patches = computed(() => fix.value?.patches ?? []);
const changedFiles = computed(() => patches.value.reduce((n, p) => n + (p.stats?.files ?? 0), 0));

/** The tab badge belongs to the page's tab bar, not to this panel. */
watch(
  [() => fix.value, changedFiles],
  () => host.setTabCount('patch', fix.value ? changedFiles.value : 0),
  { immediate: true },
);

/* ------------------------------ patch bodies ------------------------------ */

const bodies = ref<Record<string, string>>({});
const targets = ref<Record<string, string>>({});
const results = ref<Record<string, string>>({});
const applying = ref<Record<string, boolean>>({});

// A body and a typed-in path belong to one issue. The hand-written version
// keyed the same caches globally and showed one issue's patch under
// another's card until that was found.
watch(
  () => state.issueKey,
  () => {
    bodies.value = {};
    results.value = {};
    targets.value = {};
  },
);

/** Where each project was last applied on this machine, so the form opens
 * filled in — never guessed from the repo cache, since applying there looks
 * like it worked and is erased by the next review. */
function target(entry: FixPatchView): string {
  return targets.value[entry.projectPath] ?? state.detail?.fixTargets?.[entry.projectPath] ?? entry.appliedTo ?? '';
}

function placeholder(projectPath: string): string {
  return `~/projects/${projectPath.split('/').pop()} — yamanın uygulanacağı dizin`;
}

function when(iso?: string): string {
  return String(iso ?? '').replace('T', ' ').slice(0, 16);
}

async function body(projectPath: string): Promise<string> {
  const cached = bodies.value[projectPath];
  if (cached !== undefined) return cached;
  const text = await readPatch(state.issueKey!, projectPath);
  bodies.value = { ...bodies.value, [projectPath]: text };
  return text;
}

async function toggleBody(projectPath: string): Promise<void> {
  if (bodies.value[projectPath] !== undefined) {
    const { [projectPath]: _dropped, ...rest } = bodies.value;
    bodies.value = rest;
    return;
  }
  try {
    await body(projectPath);
  } catch (err) {
    results.value = { ...results.value, [projectPath]: (err as Error).message };
  }
}

async function copy(projectPath: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(await body(projectPath));
    results.value = { ...results.value, [projectPath]: 'Yama kopyalandı.' };
  } catch (err) {
    results.value = { ...results.value, [projectPath]: (err as Error).message };
  }
}

async function apply(entry: FixPatchView): Promise<void> {
  const path = target(entry).trim();
  const key = entry.projectPath;
  if (!path) {
    results.value = { ...results.value, [key]: 'Önce yamanın uygulanacağı dizini yaz.' };
    return;
  }

  applying.value = { ...applying.value, [key]: true };
  results.value = { ...results.value, [key]: 'uygulanıyor…' };

  /*
   * The request is the only part that may report a failure.
   *
   * Once the server says the patch went in, it is in someone's working copy.
   * Anything that goes wrong afterwards is a screen problem, and reporting
   * it as "Uygulanamadı" invites a second apply — which lands the same
   * change twice or collides with itself.
   */
  let applied;
  try {
    applied = await applyPatch(state.issueKey!, key, path);
  } catch (err) {
    results.value = { ...results.value, [key]: (err as Error).message };
    return;
  } finally {
    applying.value = { ...applying.value, [key]: false };
  }

  results.value = {
    ...results.value,
    [key]: `${applied.files.length} dosya ${applied.root} içinde değişti — commitlenmedi.`,
  };
  host.startPolling(state.issueKey!);
}

async function stop(): Promise<void> {
  await stopFix(state.issueKey!).catch(() => {});
  host.startPolling(state.issueKey!);
}

async function clear(): Promise<void> {
  await clearFix(state.issueKey!).catch(() => {});
  bodies.value = {};
  host.startPolling(state.issueKey!);
}
</script>

<template>
  <div v-if="fix">
    <div class="card patchCard">
      <div class="diff-toolbar">
        <h3 class="repoHeading">
          Yama
          <span class="badge" :class="`badge-${STATUS_BADGE[fix.status] ?? 'queued'}`">
            {{ STATUS_TR[fix.status] ?? fix.status }}
          </span>
          <span v-if="fix.status === 'queued' && fix.queuePosition" class="muted">
            {{ fix.queuePosition }}. sırada
          </span>
        </h3>
        <span class="spacer"></span>
        <button v-if="busy" class="btn btn-reject" @click="stop">Durdur</button>
        <button v-else class="btn btn-ghost" title="Bu yamayı sil" @click="clear">Temizle</button>
      </div>

      <p class="card-hint">İstenen bulgular:</p>
      <div v-for="(f, i) in fix.findings" :key="i" class="patchFiles">
        <span class="sev" :class="`sev-${f.severity}`">{{ f.severity }}</span>
        {{ f.heading }}
        <span v-if="f.instruction" class="objection"><b>Talimatın:</b> {{ f.instruction }}</span>
      </div>

      <StateNote v-if="fix.error" kind="error">{{ fix.error }}</StateNote>

      <p v-if="busy" class="card-hint">Çalışıyor — ilerleme <b>Süreç</b> sekmesinde.</p>
      <ul v-else-if="fix.report?.length" class="fixReport">
        <!-- Spelled out rather than `:class="line.outcome"`: binding a data
             value straight to a class name couples the two invisibly, and
             the stylesheet check cannot see it. -->
        <li v-for="(line, i) in fix.report" :key="i" :class="line.outcome === 'fixed' ? 'fixed' : 'skipped'">
          <span class="mark">{{ line.outcome === 'fixed' ? 'DÜZELTİLDİ' : 'ATLANDI' }}</span>
          <span>{{ line.text }}</span>
        </li>
      </ul>
    </div>

    <div v-for="entry in patches" :key="entry.projectPath" class="card patchCard">
      <template v-if="entry.error">
        <h3 class="repoHeading">{{ entry.projectPath }}</h3>
        <StateNote kind="error">{{ entry.error }}</StateNote>
      </template>

      <template v-else-if="!entry.size">
        <h3 class="repoHeading">{{ entry.projectPath }}</h3>
        <p class="card-hint">Bu repoda hiçbir dosya değişmedi.</p>
      </template>

      <template v-else>
        <div class="diff-toolbar">
          <h3 class="repoHeading">
            {{ entry.projectPath }}
            <span class="repoBranch">{{ entry.branchName }}</span>
          </h3>
          <span class="spacer"></span>
          <span class="patchStat">
            {{ entry.stats.files }} dosya
            <span class="add">+{{ entry.stats.insertions }}</span>
            <span class="del">-{{ entry.stats.deletions }}</span>
          </span>
        </div>

        <div class="patchFiles">
          <div v-for="file in entry.files" :key="file">{{ file }}</div>
        </div>

        <p v-if="entry.appliedAt" class="card-hint">
          {{ entry.appliedTo }} dizinine uygulandı · {{ when(entry.appliedAt) }}
          <template v-if="entry.appliedIgnoringWhitespace">
            · girinti farklıydı, boşluklar yok sayılarak — sonucu okumadan commitleme
          </template>
          <template v-else-if="entry.appliedWithMerge">
            · birleştirilerek — sonucu okumadan commitleme
          </template>
          · commitlenmedi
        </p>

        <div class="applyRow">
          <input
            class="input"
            type="text"
            :placeholder="placeholder(entry.projectPath)"
            :value="target(entry)"
            @input="targets[entry.projectPath] = ($event.target as HTMLInputElement).value"
          />
          <button class="btn btn-primary" :disabled="applying[entry.projectPath]" @click="apply(entry)">
            Uygula
          </button>
          <button class="btn" @click="toggleBody(entry.projectPath)">
            {{ bodies[entry.projectPath] === undefined ? 'Yamayı gör' : 'Yamayı gizle' }}
          </button>
          <button class="btn" @click="copy(entry.projectPath)">Kopyala</button>
          <a class="btn" :href="patchUrl(state.issueKey!, entry.projectPath, true)">İndir</a>
        </div>

        <div class="card-hint">{{ results[entry.projectPath] ?? '' }}</div>
        <pre v-if="bodies[entry.projectPath] !== undefined" class="patchText">{{
          bodies[entry.projectPath]
        }}</pre>
      </template>
    </div>
  </div>

  <StateNote v-else>
    Henüz yama yok. Review'deki <b>blocking</b> ve <b>major</b> bulgular için başlıktaki
    <b>⋯</b> menüsünden <b>Düzelt…</b> ile yama üretebilirsin — hiçbir dosyan değişmez, yamayı
    sonra kendi seçtiğin dizine uygularsın.
  </StateNote>
</template>
