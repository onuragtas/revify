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
import LocalReviewModal from './LocalReviewModal.vue';
import BackupModal from './BackupModal.vue';
import ContextModal from './ContextModal.vue';
import FixModal from './FixModal.vue';
import SettingsModal from './SettingsModal.vue';
import TeamModal from './TeamModal.vue';
import { closeAllModals, closeModal, modals } from '../uiState';
import { fixUi } from '../fixState';

// One Escape handler for all of them, so it cannot fall out of sync with the
// set of modals that exist.
const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  closeAllModals();
  // The fix dialog keeps its own flag rather than a `modals` entry, because
  // what it holds is a *selection* of findings and not merely "open". It
  // still has to answer Escape like the rest of them.
  fixUi.modalOpen = false;
};
onMounted(() => document.addEventListener('keydown', onKey));
onUnmounted(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <BackupModal v-if="modals.backup" @close="closeModal('backup')" />
  <ContextModal v-if="modals.context" />
  <AssignModal v-if="modals.assign" />
  <FixModal v-if="fixUi.modalOpen" />
  <LocalReviewModal v-if="modals.localReview" />
  <TeamModal v-if="modals.team" />
  <SettingsModal v-if="modals.settings" />
</template>
