<script setup lang="ts">
/**
 * Every modal Vue owns, in one mount point.
 *
 * A modal belongs at the end of the body rather than inside whatever opened
 * it, and each one being its own island would mean an empty container in the
 * markup per modal. One host renders whichever are open.
 */
import { onMounted, onUnmounted } from 'vue';
import AssignModal from './AssignModal.vue';
import BackupModal from './BackupModal.vue';
import ContextModal from './ContextModal.vue';
import SettingsModal from './SettingsModal.vue';
import TeamModal from './TeamModal.vue';
import { closeAllModals, closeModal, modals } from '../uiState';

// One Escape handler for all of them, so it cannot fall out of sync with the
// set of modals that exist.
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeAllModals();
};
onMounted(() => document.addEventListener('keydown', onKey));
onUnmounted(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <BackupModal v-if="modals.backup" @close="closeModal('backup')" />
  <ContextModal v-if="modals.context" />
  <AssignModal v-if="modals.assign" />
  <TeamModal v-if="modals.team" />
  <SettingsModal v-if="modals.settings" />
</template>
