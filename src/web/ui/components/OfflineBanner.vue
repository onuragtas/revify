<script setup lang="ts">
/**
 * "The team half may be stale."
 *
 * The address is named here, and only here. The sign-in screen deliberately
 * hides it: it ships with the build, so it is not something the person
 * signing in chose or can change. A *failure* is the opposite case — without
 * the address there is no way to tell "the team server is down" from "this
 * is a build that talks to a backend on this machine, and nothing is
 * listening", which are the same banner and completely different problems.
 */
import { computed } from 'vue';
import { session } from '../session';

const local = computed(() => /localhost|127\.0\.0\.1/.test(session.apiUrl));
</script>

<template>
  <div v-if="session.offline" class="offlineBanner">
    Sunucuya ulaşılamıyor ({{ session.apiUrl || 'adres bilinmiyor' }}) — kayıtlı oturumla devam
    ediliyor. Takım özellikleri güncel olmayabilir.
    <template v-if="local">
      Bu bir geliştirme çalıştırması: paketlenmemiş uygulama yerel backend’e bakar.
      <code class="mdInline">cd api &amp;&amp; go run ./cmd/api</code> ile başlat, ya da
      REVIFY_API_URL ver.
    </template>
  </div>
</template>
