<script setup lang="ts">
/**
 * The one line across the top that interrupts.
 *
 * It appears only while something is actually happening, and only until it
 * is dismissed for that version — the same description Settings shows, so
 * the two cannot disagree about what the updater is doing.
 */
import { bannerVisible, dismissUpdate, installUpdate, updateState } from '../update';
import { ref } from 'vue';

const busy = ref(false);

async function act(): Promise<void> {
  busy.value = true;
  const error = await installUpdate();
  busy.value = false;
  if (error) alert(error);
}
</script>

<template>
  <div v-if="bannerVisible" class="updateBanner">
    <span>{{ updateState.text }}</span>
    <button v-if="updateState.action" class="btn" :disabled="busy" @click="act">
      {{ updateState.action }}
    </button>
    <button class="btn btn-ghost btn-icon" title="Şimdilik gizle" @click="dismissUpdate" aria-label="Şimdilik gizle">✕</button>
  </div>
</template>
