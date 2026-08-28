# Arayüz feature envanteri

<!-- ÜRETİLMİŞ DOSYA — elle düzenleme. node scripts/uiInventory.mjs -->

Buradaki bir satırın karşılığı arayüzde yoksa, o feature **kaybolmuş** demektir.
Göçün nasıl yürüdüğü `ui-migration.md` içinde.

- Sayfadaki inline script: **yok** · inline stil: **yok**
- Bileşen: **28** · düğme: **72** · alan: **31** · modal: **6**
- API ucu: **27**

## Bileşenler
### `ActionMenu` — `src/web/ui/components/ActionMenu.vue`
- [ ] düğme: ⋯

### `App` — `src/web/ui/components/App.vue`
- _(kontrol yok)_

### `AssignedView` — `src/web/ui/components/AssignedView.vue`
- [ ] düğme: ↻ Yenile
- [ ] düğme: Bitti

### `AssignModal` _(modal)_ — `src/web/ui/components/AssignModal.vue`
- [ ] düğme: ✕
- [ ] düğme: Vazgeç
- [ ] düğme: Ata
- [ ] alan: Neye dikkat etmeli? (opsiyonel)
- [ ] alan: metin kutusu

### `BackupModal` _(modal)_ — `src/web/ui/components/BackupModal.vue`
- [ ] düğme: ✕
- [ ] düğme: Kapat
- [ ] düğme: Seçilen dosyayı yükle
- [ ] bağlantı: ⤓ Yedeği indir
- [ ] alan: dosya seçici

### `ContextModal` _(modal)_ — `src/web/ui/components/ContextModal.vue`
- [ ] düğme: ✕
- [ ] düğme: Vazgeç
- [ ] düğme: Review'i başlat
- [ ] alan: onay kutusu
- [ ] alan: Proje ara…

### `DecisionBar` — `src/web/ui/components/DecisionBar.vue`
- [ ] düğme: Vazgeç
- [ ] düğme: Reddet
- [ ] düğme: Reddet
- [ ] düğme: Onayla
- [ ] alan: Red gerekçesi (opsiyonel — review'in üstünde Jira yorumuna e
- [ ] alan: metin kutusu

### `DecisionsView` — `src/web/ui/components/DecisionsView.vue`
- [ ] düğme: ↻ Yenile

### `DetailPane` — `src/web/ui/components/DetailPane.vue`
- [ ] düğme: ←
- [ ] düğme: Durdur
- [ ] düğme: {startLabel}
- [ ] düğme: {startLabel}
- [ ] düğme: Ata…
- [ ] düğme: Bağlam…
- [ ] düğme: Temizle
- [ ] düğme: {tab.label} {tabs.counts[tab.countKey].count}

### `DiffPanel` — `src/web/ui/components/DiffPanel.vue`
- [ ] düğme: Yan yana
- [ ] düğme: Tek sütun

### `FixButton` — `src/web/ui/components/FixButton.vue`
- [ ] düğme: Düzelt…

### `FixModal` _(modal)_ — `src/web/ui/components/FixModal.vue`
- [ ] düğme: ✕
- [ ] düğme: Vazgeç
- [ ] düğme: {{ chosen.length ? `Yama üret (${chosen.length})` : 'Yama üret' }}
- [ ] alan: onay kutusu
- [ ] alan: Nasıl düzeltilsin? Bulgu seçenek sunuyorsa hangisi — opsiyon
- [ ] alan: metin kutusu

### `FixPanel` — `src/web/ui/components/FixPanel.vue`
- [ ] düğme: Durdur
- [ ] düğme: Temizle
- [ ] düğme: Uygula
- [ ] düğme: {bodies[entry.projectPath]}
- [ ] düğme: Kopyala
- [ ] bağlantı: İndir
- [ ] alan: placeholder(entry.projectPath)

### `GateScreen` — `src/web/ui/components/GateScreen.vue`
- [ ] düğme: Giriş yap
- [ ] düğme: Kaydol
- [ ] düğme: {mode}

### `HistoryPanel` — `src/web/ui/components/HistoryPanel.vue`
- _(kontrol yok)_

### `IssueList` — `src/web/ui/components/IssueList.vue`
- [ ] düğme: İncele
- [ ] alan: Issue veya özet ara…  ( / )
- [ ] alan: BUY-2455 ya da ~/projects/api

### `NotesPanel` — `src/web/ui/components/NotesPanel.vue`
- [ ] düğme: sil
- [ ] düğme: Ekle
- [ ] alan: ör. Bu projede test eksikliğini bulgu olarak yazma
- [ ] alan: seçim kutusu

### `OfflineBanner` — `src/web/ui/components/OfflineBanner.vue`
- _(kontrol yok)_

### `Overlays` — `src/web/ui/components/Overlays.vue`
- _(kontrol yok)_

### `PendingView` — `src/web/ui/components/PendingView.vue`
- [ ] düğme: ↻ Yenile

### `PromptCards` — `src/web/ui/components/PromptCards.vue`
- [ ] düğme: {copied}

### `ReviewPanel` — `src/web/ui/components/ReviewPanel.vue`
- _(kontrol yok)_

### `SettingsModal` _(modal)_ — `src/web/ui/components/SettingsModal.vue`
- [ ] düğme: ✕
- [ ] düğme: Oluştur
- [ ] düğme: {updateState.action}
- [ ] düğme: Şimdi kontrol et
- [ ] düğme: Kapat
- [ ] düğme: Kaydet
- [ ] alan: onay kutusu
- [ ] alan: 
                SECRETS.includes(key as never)
            
- [ ] alan: ~/.revify/repos
- [ ] alan: 10
- [ ] alan: 45
- [ ] alan: placeholder
- [ ] alan: takım adı

### `StateNote` — `src/web/ui/components/StateNote.vue`
- _(kontrol yok)_

### `TeamModal` _(modal)_ — `src/web/ui/components/TeamModal.vue`
- [ ] düğme: ✕
- [ ] düğme: Gönder
- [ ] düğme: Hatırlat
- [ ] düğme: Oluştur
- [ ] düğme: Çıkış yap
- [ ] alan: isim veya e-posta ara (en az 2 harf)
- [ ] alan: kısa not (isteğe bağlı)
- [ ] alan: takım adı

### `TopBar` — `src/web/ui/components/TopBar.vue`
- [ ] düğme: {label} {views.counts[name].count}
- [ ] düğme: {session.user}
- [ ] düğme: ↻ Yenile
- [ ] düğme: ⚙ Ayarlar
- [ ] düğme: ⤓ Yedek al / geri yükle
- [ ] düğme: ◐ {theme}

### `UpdateBanner` — `src/web/ui/components/UpdateBanner.vue`
- [ ] düğme: {updateState.action}
- [ ] düğme: ✕

### `VerifyPanel` — `src/web/ui/components/VerifyPanel.vue`
- [ ] düğme: Kaydet
- [ ] düğme: Kaydet ve yeniden incele
- [ ] düğme: Talimatı sil
- [ ] düğme: Cevapları kaydet
- [ ] düğme: Kaydet ve yeniden incele
- [ ] düğme: İtirazları kaydet
- [ ] düğme: Kaydet ve tekrar doğrulat
- [ ] alan: ör. 2. bulgu geçersiz, o alan controller'da zaten valide edi
- [ ] alan: Cevabın…
- [ ] alan: Bu bulgu neden yanlış? (boş bırakırsan itiraz yok sayılır)
- [ ] alan: metin kutusu
- [ ] alan: metin kutusu
- [ ] alan: metin kutusu

## Kullanılan API uçları (27)
- [ ] `/api/auto-prepare`
- [ ] `/api/backend/`
- [ ] `/api/backend/assignments`
- [ ] `/api/backend/logout`
- [ ] `/api/backend/me`
- [ ] `/api/backend/teams`
- [ ] `/api/backend/teams/`
- [ ] `/api/backend/users`
- [ ] `/api/decisions`
- [ ] `/api/export`
- [ ] `/api/gate`
- [ ] `/api/import`
- [ ] `/api/notes`
- [ ] `/api/notes/`
- [ ] `/api/outcome-config`
- [ ] `/api/pending`
- [ ] `/api/projects`
- [ ] `/api/reminders/nudge`
- [ ] `/api/reminders/nudges/`
- [ ] `/api/review-states`
- [ ] `/api/reviews`
- [ ] `/api/reviews/`
- [ ] `/api/reviews/local`
- [ ] `/api/settings`
- [ ] `/api/update`
- [ ] `/api/update/check`
- [ ] `/api/update/install`
