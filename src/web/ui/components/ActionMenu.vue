<script setup lang="ts">
/**
 * The actions that are not the next thing you would do.
 *
 * A detail header carrying seven equally-weighted buttons asks the reader to
 * re-decide which one matters every time they look at it. One of them is
 * almost always the answer — start the review, or stop it — and the rest are
 * occasional: hand it to someone, pick context repos, throw the record away.
 * Those live here, one click further away, in the order you would reach for
 * them.
 */
import { onMounted, onUnmounted, ref } from 'vue';

const open = ref(false);
const root = ref<HTMLElement | null>(null);

function close(): void {
  open.value = false;
}

/** A menu that stays open when you click elsewhere is a menu you have to
 * dismiss twice. */
function onDocumentClick(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) close();
}
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div ref="root" class="actionMenu">
    <button
      class="btn btn-ghost btn-icon"
      title="Diğer eylemler"
      aria-label="Diğer eylemler"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="open = !open"
    >
      ⋯
    </button>
    <div v-if="open" class="actionMenu-list" role="menu" @click="close">
      <slot />
    </div>
  </div>
</template>
