<script setup lang="ts">
/**
 * The whole local state, in and out of one file.
 *
 * Two asymmetric halves. Export is a download and cannot hurt anything.
 * Import **replaces everything here**, which is why it asks first, says what
 * it is about to destroy, and refuses while a review is running — and why
 * `config.yaml` is deliberately not written: swapping the switch that
 * decides whether this machine writes to real Jira issues is not something a
 * file picker should be able to do.
 */
import { ref } from 'vue';
import { host, refreshList, state } from '../bridge';

const emit = defineEmits<{ close: [] }>();

const file = ref<File | null>(null);
const result = ref('');
const busy = ref(false);

function pick(event: Event): void {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function importBackup(): Promise<void> {
  if (!file.value) {
    result.value = 'Önce bir yedek dosyası seç.';
    return;
  }
  const confirmed = confirm(
    'Buradaki tüm review, not ve durum verisi silinip bu dosyadakiyle değiştirilecek. Devam edilsin mi?',
  );
  if (!confirmed) return;

  busy.value = true;
  result.value = 'yükleniyor…';
  let payload: unknown;
  try {
    payload = JSON.parse(await file.value.text());
  } catch {
    result.value = 'Dosya okunamadı: geçerli JSON değil.';
    busy.value = false;
    return;
  }

  try {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) {
      result.value = `Yüklenemedi: ${data.error}`;
      return;
    }
    result.value =
      `${data.reviews} review geri yüklendi.` +
      (data.configIncluded ? ' (Yedekteki config.yaml uygulanmadı — elle kopyalayın.)' : '');
    file.value = null;
    refreshList();
    // The open issue's record may have been replaced wholesale.
    if (state.issueKey) host.startPolling(state.issueKey);
  } catch (err) {
    result.value = `Yüklenemedi: ${(err as Error).message}`;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop open" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>Yedek</h3>
        <button class="btn btn-ghost btn-icon pushRight" title="Kapat" @click="emit('close')" aria-label="Kapat">
          ✕
        </button>
      </div>

      <div class="modal-body">
        <h4>Dışa aktar</h4>
        <p class="card-hint">
          Review'lar, geçmiş, cevaplar, itirazlar, notlar ve kuyruk durumu tek dosyada.
          <b>Kimlik bilgileri (.env) dahil değildir.</b> Dosya iç Jira metinlerini ve diff'leri
          birebir taşır — issue'ların kendisi gibi saklayın.
        </p>
        <a class="btn" href="/api/export" download>⤓ Yedeği indir</a>

        <h4>İçe aktar</h4>
        <p class="card-hint">
          Buradaki tüm veriyi <b>siler ve dosyadakiyle değiştirir</b>. Öncesinde mevcut veri
          <code class="mdInline">.before-import-…</code> uzantısıyla yedeklenir. Çalışan review
          varsa reddedilir. <code class="mdInline">config.yaml</code> yazılmaz — Jira'ya yazma
          anahtarını dosya seçiciyle değiştirmek doğru olmaz.
        </p>
        <input class="input" type="file" accept="application/json,.json" @change="pick" />
        <div class="card-hint spaced">{{ result }}</div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="emit('close')">Kapat</button>
        <button class="btn btn-reject" :disabled="busy" @click="importBackup">
          Seçilen dosyayı yükle
        </button>
      </div>
    </div>
  </div>
</template>
