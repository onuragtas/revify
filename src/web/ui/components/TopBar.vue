<script setup lang="ts">
/**
 * What this machine is, and what it is about to do to Jira.
 *
 * The mode chip is the one thing here that is not decoration: `CANLI · Jira
 * yazılır` versus `DRY RUN` is the difference between a review that changes
 * a real ticket and one that only logs what it would have done. It stays
 * visible on every screen for that reason.
 */
import { computed, onMounted, ref } from 'vue';
import { openModal } from '../uiState';
import { session } from '../session';
import { views, type ViewName } from '../views';
import { refreshList, reloadView } from '../bridge';
import { autoPrepare, outcomeConfig } from '../appConfig';
import { formatDate } from '../format';

const theme = ref(readTheme());

const TABS: Array<[ViewName, string]> = [
  ['reviews', 'İncelemeler'],
  ['pending', 'Onay bekleyenler'],
  ['assigned', 'Bana atananlar'],
  ['decisions', 'Kararlar'],
];

/** Only when there is a backend to ask; otherwise it is a permanently empty
 * screen. */
const tabs = computed(() => TABS.filter(([name]) => name !== 'assigned' || session.user));

function readTheme(): string {
  try {
    return localStorage.getItem('ar-theme') ?? 'dark';
  } catch {
    return 'dark';
  }
}

function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme.value;
  try {
    localStorage.setItem('ar-theme', theme.value);
  } catch {
    /* not remembering it is the whole cost */
  }
}

const autoTitle = computed(() =>
  [
    'Yeni gelen işler siz istemeden incelenir (onay yine sizde).',
    autoPrepare.since ? `İzleme başlangıcı: ${formatDate(autoPrepare.since)}` : '',
    autoPrepare.lastReviewAt ? `Son review: ${formatDate(autoPrepare.lastReviewAt)}` : '',
  ]
    .filter(Boolean)
    .join('\n'),
);

onMounted(() => (document.documentElement.dataset.theme = theme.value));

function select(name: ViewName): void {
  views.active = name;
  // Opening a screen is a request for what is on it now, not for whatever
  // it held when it was last closed.
  reloadView(name);
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark">Rv</span>
      <div>
        <h1>Revify</h1>
        <p class="brand-sub">jira → gitlab → ai review</p>
      </div>
    </div>

    <!-- Navigation rather than tabs: these swap the whole screen, so
         `aria-current` is the honest relationship. -->
    <nav class="viewTabs" aria-label="Ekranlar">
      <button
        v-for="[name, label] in tabs"
        :key="name"
        class="viewTab"
        :class="{ on: views.active === name }"
        :aria-current="views.active === name ? 'page' : undefined"
        @click="select(name)"
      >
        {{ label }}
        <span
          v-if="views.counts[name]?.count"
          class="tab-count"
          :class="{ alert: views.counts[name].alert }"
        >
          {{ views.counts[name].count }}
        </span>
      </button>
    </nav>

    <div class="topbar-right">
      <span v-if="autoPrepare.enabled" class="chip chip-auto" :title="autoTitle">OTO HAZIRLIK</span>
      <span
        v-if="outcomeConfig.loaded"
        id="modeChip"
        class="chip"
        :class="outcomeConfig.applyChanges ? 'chip-live' : 'chip-dry'"
      >
        {{ outcomeConfig.applyChanges ? 'CANLI · Jira yazılır' : 'DRY RUN' }}
      </span>
      <button v-if="session.configured" class="btn btn-ghost" :title="session.user ? 'Takım' : 'Sunucuya giriş yap'" @click="openModal('team')">
        {{ session.user ? session.user.name : 'Giriş yap' }}
      </button>
      <button class="btn btn-ghost btn-icon" title="Ayarlar" @click="openModal('settings')" aria-label="Ayarlar">⚙</button>
      <button class="btn btn-ghost btn-icon" title="Yedek al / geri yükle" @click="openModal('backup')" aria-label="Yedek al / geri yükle">⤓</button>
      <button class="btn btn-ghost btn-icon" title="Açık / koyu tema" @click="toggleTheme" aria-label="Açık / koyu tema">◐</button>
      <button class="btn" @click="refreshList">↻ Yenile</button>
    </div>
  </header>
</template>
