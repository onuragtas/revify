<script setup lang="ts">
/**
 * The whole application.
 *
 * Two states: the gate, and everything else. The gate is deliberately soft —
 * reviews run on this machine against this machine's credentials, so a
 * backend that cannot be reached does not lock anyone out. It shows a banner
 * instead and lets the local half work.
 */
import { onMounted } from 'vue';
import { state } from '../bridge';
import { checkGate, loadIdentity, session } from '../session';
import { loadAutoPrepare, loadOutcomeConfig } from '../appConfig';
import { pollUpdate } from '../update';
import { views } from '../views';

import AssignedView from './AssignedView.vue';
import DecisionsView from './DecisionsView.vue';
import DetailPane from './DetailPane.vue';
import GateScreen from './GateScreen.vue';
import IssueList from './IssueList.vue';
import OfflineBanner from './OfflineBanner.vue';
import Overlays from './Overlays.vue';
import PendingView from './PendingView.vue';
import StateNote from './StateNote.vue';
import TopBar from './TopBar.vue';
import UpdateBanner from './UpdateBanner.vue';

const UPDATE_POLL_MS = 30000;

onMounted(async () => {
  await checkGate();
  if (!session.signedIn) return;

  // Everything that needed to know who you are can start now.
  void loadIdentity();
  void loadOutcomeConfig();
  void loadAutoPrepare();
  void pollUpdate();
  setInterval(() => void pollUpdate(), UPDATE_POLL_MS);
});
</script>

<template>
  <!--
    Something, always.
    
    Flashing the app and then replacing it with a sign-in form is worse than
    waiting — but rendering *nothing* while the gate is in flight is worse
    than both: the gate waits on a backend call, and a page that draws
    nothing is indistinguishable from one that crashed. On a dark theme it is
    literally a black screen — which is exactly what it produced.
  -->
  <div v-if="!session.ready" id="gate">
    <div class="gate-card">
      <div class="gate-brand">
        <span class="brand-mark">Rv</span>
        <div>
          <h1>Revify</h1>
          <p class="brand-sub">jira → gitlab → ai review</p>
        </div>
      </div>
      <StateNote kind="loading">Oturum kontrol ediliyor…</StateNote>
    </div>
  </div>

  <template v-else>
    <GateScreen v-if="!session.signedIn" />

    <!-- `has-selection` is the narrow-screen rule: with an issue open there
         is not room for both panes, so the list gives way to the detail. -->
    <div v-else class="app" :class="{ 'has-selection': state.issueKey }">
      <OfflineBanner />
      <UpdateBanner />
      <TopBar />

      <main v-show="views.active === 'reviews'" class="layout">
        <aside class="sidebar"><IssueList /></aside>
        <DetailPane />
      </main>

      <section v-show="views.active === 'pending'" class="decisionsView"><PendingView /></section>
      <section v-show="views.active === 'assigned'" class="decisionsView"><AssignedView /></section>
      <section v-show="views.active === 'decisions'" class="decisionsView"><DecisionsView /></section>

      <Overlays />
    </div>
  </template>
</template>
