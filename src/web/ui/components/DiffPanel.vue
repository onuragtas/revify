<script setup lang="ts">
/**
 * The change the review was written against.
 *
 * Two ways to read it, and the choice is remembered: side by side for a
 * normal window, one column when the window is narrow — a split view on a
 * 700px screen is two unreadable columns rather than one readable one, so
 * the narrow case overrides the preference instead of asking again.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import StateNote from './StateNote.vue';
import { host, state } from '../bridge';
import { isHunk, parseUnifiedDiff, toUnifiedRows, type DiffRow, type UnifiedRow } from '../diff';

const MODE_KEY = 'ar-diff-mode';

const preferred = ref<'split' | 'unified'>(
  (() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'unified' ? 'unified' : 'split';
    } catch {
      // A private window, or storage the browser refuses. A remembered
      // preference is a convenience; losing it must not blank the panel.
      return 'split';
    }
  })(),
);

const narrow = matchMedia('(max-width: 820px)');
const isNarrow = ref(narrow.matches);
const onNarrowChange = (e: MediaQueryListEvent) => (isNarrow.value = e.matches);
narrow.addEventListener('change', onNarrowChange);
onUnmounted(() => narrow.removeEventListener('change', onNarrowChange));

const mode = computed(() => (isNarrow.value ? 'unified' : preferred.value));

function setMode(next: 'split' | 'unified'): void {
  preferred.value = next;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    /* not remembering it is the whole cost */
  }
}

const changes = computed(() => (state.detail?.repoChanges ?? []).filter((c) => c.files?.length));
const fileCount = computed(() => changes.value.reduce((n, c) => n + c.files.length, 0));

watch(fileCount, () => host.setTabCount('diff', fileCount.value), { immediate: true });

/** Open by default only for a small change — a 40-file diff should not dump
 * everything on screen at once. */
const openByDefault = computed(() => fileCount.value <= 3);

const title = computed(() =>
  changes.value.length > 1
    ? `${changes.value.length} repo, ${fileCount.value} dosya`
    : `${fileCount.value} dosya`,
);

const rowsFor = (diff: string): DiffRow[] => parseUnifiedDiff(diff);
const unifiedFor = (diff: string): Array<DiffRow | UnifiedRow> => toUnifiedRows(parseUnifiedDiff(diff));
const asUnified = (row: DiffRow | UnifiedRow) => row as UnifiedRow;
</script>

<template>
  <div v-if="changes.length">
    <div class="diff-toolbar">
      <h3 class="repoHeading">
        {{ title }}
        <span v-if="changes.length === 1" class="repoBranch">
          {{ changes[0].baseBranch }} → {{ changes[0].branchName }}
        </span>
      </h3>
      <span class="spacer"></span>
      <span class="seg">
        <button
          :class="{ on: mode === 'split' }"
          title="Eski ve yeni yan yana"
          @click="setMode('split')"
        >
          Yan yana
        </button>
        <button
          :class="{ on: mode === 'unified' }"
          title="Tek sütun — uzun satırlar sarmadan sığar"
          @click="setMode('unified')"
        >
          Tek sütun
        </button>
      </span>
    </div>

    <div>
      <template v-for="c in changes" :key="c.projectPath + c.branchName">
        <h4 v-if="changes.length > 1" class="repoHeading">
          {{ c.projectPath }}
          <span class="repoBranch">{{ c.baseBranch }} → {{ c.branchName }}</span>
        </h4>

        <details v-for="f in c.files" :key="c.projectPath + f.path" class="diff-file" :open="openByDefault">
          <summary>{{ f.path }}</summary>

          <div class="diffScroll">
            <table v-if="mode === 'split'" class="diffTable">
              <colgroup>
                <col class="cNo" /><col /><col class="cNo" /><col />
              </colgroup>
              <tr v-for="(r, i) in rowsFor(f.diff)" :key="i" :class="r.type === 'mod' ? 'del add' : r.type">
                <td v-if="r.type === 'hunk'" colspan="4">{{ r.text }}</td>
                <template v-else>
                  <td class="lineNo" :class="{ empty: r.oldText === null }">
                    {{ r.oldText === null ? '' : r.oldNo }}
                  </td>
                  <td class="side oldSide" :class="{ empty: r.oldText === null }">{{ r.oldText }}</td>
                  <td class="lineNo newNo" :class="{ empty: r.newText === null }">
                    {{ r.newText === null ? '' : r.newNo }}
                  </td>
                  <td class="side newSide" :class="{ empty: r.newText === null }">{{ r.newText }}</td>
                </template>
              </tr>
            </table>

            <table v-else class="diffTable unified">
              <colgroup>
                <col class="cNo" /><col class="cNo" /><col class="cMark" /><col />
              </colgroup>
              <tr
                v-for="(r, i) in unifiedFor(f.diff)"
                :key="i"
                :class="isHunk(r) ? 'hunk' : asUnified(r).cls"
              >
                <td v-if="isHunk(r)" colspan="4">{{ r.text }}</td>
                <template v-else>
                  <td class="lineNo">{{ asUnified(r).oldNo ?? '' }}</td>
                  <td class="lineNo newNo">{{ asUnified(r).newNo ?? '' }}</td>
                  <td class="mark">{{ asUnified(r).mark }}</td>
                  <td class="side uni">{{ asUnified(r).text }}</td>
                </template>
              </tr>
            </table>
          </div>
        </details>
      </template>
    </div>
  </div>

  <StateNote v-else>Gösterilecek değişiklik yok.</StateNote>
</template>
