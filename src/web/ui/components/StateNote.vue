<script setup lang="ts">
/**
 * "Nothing here", "still loading", "it failed" — said the same way everywhere.
 *
 * These three are most of what a screen shows outside its happy path, and
 * they were written by hand in a dozen places: different markup, different
 * wording, an error sometimes coloured by an inline style and sometimes not.
 * A reader learns one shape and then meets three.
 *
 * The distinction matters beyond looks. An empty list and a failed request
 * look identical if both are grey text, and they call for opposite reactions
 * — one means there is nothing to do, the other means something is wrong.
 */
defineProps<{ kind?: 'empty' | 'loading' | 'error' }>();
</script>

<template>
  <div class="stateNote" :class="`stateNote-${kind ?? 'empty'}`">
    <span v-if="kind === 'loading'" class="stateNote-spinner" aria-hidden="true"></span>
    <div><slot /></div>
  </div>
</template>
