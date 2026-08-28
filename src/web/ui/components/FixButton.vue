<script setup lang="ts">
/**
 * The Düzelt button in the detail header.
 *
 * Offered whenever there is something it could fix, and **disabled rather
 * than hidden** when this machine cannot run it: a button that vanishes
 * teaches nothing, and the reason is worth reading.
 */
import { computed } from 'vue';
import { state } from '../bridge';
import { available, busy, findings, fixUi } from '../fixState';

const fixable = computed(() =>
  findings.value.filter((f) => f.severity === 'blocking' || f.severity === 'major'),
);
const visible = computed(() => Boolean(state.detail?.review) && fixable.value.length > 0);
</script>

<template>
  <button
    v-if="visible"
    class="btn"
    :disabled="!available || busy"
    :title="
      available
        ? 'Blocking ve major bulgular için yama üret'
        : 'Bu makinede düzeltme çalıştırılamıyor: LLM sağlayıcısı dosya düzenleyemiyor ya da review yerel checkout olmadan üretilmiş.'
    "
    @click="fixUi.modalOpen = true"
  >
    Düzelt…
  </button>
</template>
