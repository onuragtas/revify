# Arayüz göçü — Faz 1

## Kural

**Hiçbir feature kaybolmayacak.** `docs/ui-inventory.md` bunun ölçülebilir
karşılığı: koddan üretilen, 4 görünüm / 7 sekme / 6 modal / 54 düğme /
31 alan / 27 API ucundan oluşan bir kontrol listesi. Göç ilerledikçe
`node scripts/uiInventory.mjs` ile yeniden üretilir; bir satırın karşılığı
yoksa o feature düşmüş demektir.

## Yöntem: strangler, yeniden yazım değil

`index.html` bugün servis ettiği her ekranı servis etmeye devam ediyor. Vue
`ui/main.ts` içinde listelenen kapları devralıyor, başka hiçbir şeyi. Her
devralmada eski DOM kodu **aynı değişiklikte siliniyor**; asla iki uygulama
yan yana çalışmıyor. Bu yüzden her adımda uygulama bütün uygulama olarak
kalıyor ve her an sevk edilebilir durumda.

Tek poll döngüsü var ve o hâlâ eski kodda: her `/detail` cevabı
`window.revify.setDetail(...)` ile köprüye veriliyor, bileşenler oradan
reaktif okuyor. İkinci bir istek döngüsü yok.

Ters yön de var ama dar: sayfa hâlâ yönlendirmeyi, sekme çubuğunu ve poll'u
sahiplendiği için, yama başlatan bir bileşen poll'u kendi yeniden
başlatamaz. Sayfa yapabildiklerini `window.revifyHost` üzerinde yayınlıyor
(`startPolling`, `setTabCount`, `showTab`), bileşenler onları çağırıyor —
tek bir elemana iki sahip olmasındansa. **Bu liste kaplar taşındıkça
küçülüyor; boşaldığında sayfa bitmiş demektir.**

Modül script `defer` olduğu için Vue, sayfanın klasik script'inden *sonra*
çalışıyor; bu yüzden verbler elden ele verilmiyor, `window` üzerinden
okunuyor.

## Devralınanlar — tamamı

Detay paneli: `ReviewPanel`, `DiffPanel`, `FixPanel`, `VerifyPanel`,
`NotesPanel`, `HistoryPanel`, `PromptCards`, `DecisionCard`, `DetailPane`.
Görünümler: `IssueList`, `PendingView`, `AssignedView`, `DecisionsView`.
Modallar: `FixModal`, `BackupModal`, `ContextModal`, `AssignModal`,
`TeamModal`, `SettingsModal` — hepsi tek bir `Overlays` kabında.
Kabuk: `App`, `TopBar`, `GateScreen`, `UpdateBanner`, `OfflineBanner`,
`FixButton`.

`index.html` artık **1001 satır ve hepsi stil**: bir mount noktası ve
bundle'ı yükleyen tek bir `<script>` etiketi. Stiller orada bıraktım —
açık/koyu temayı taşıyan tek bir token seti ve her bileşen onu okuyor;
bileşen başına bloklara bölmek, "hiçbir şey kazara değişmeyecek" kuralı olan
bir göç sırasında tüm görsel dili yeniden karara bağlamak olurdu.

## Köprü kapandı

`window.revify` / `window.revifyHost` yok. Sayfa dururken bir bileşen poll'u
yeniden başlatamaz veya sekme rozetini oynatamazdı; şimdi `host` nesnesi
doğrudan gerçek uygulamaları taşıyor (`detail.ts`, `views.ts`, `uiState.ts`).
Adı kaldı çünkü onu çağıran on bileşenin aynı gün değişmesi gerekmiyordu.

## Paylaşılan API tipi

`src/core/apiTypes.ts` — **import'suz, runtime kodu olmayan** bir dosya:
`/detail`'in gönderdiği şekiller orada bir kez tanımlı. Express handler'ı
`const payload: ReviewDetail = {...}` diye yazıyor, `bridge.ts` aynı tipi
`import type` ile alıyor (tip-only olduğu için bundle onu `node:fs`'e kadar
takip etmiyor).

Öncesinde arayüz aynı şekilleri **elle ikinci kez** tanımlıyordu. Sunucuda
bir alan adı değişirse iki taraf da derleniyor ve panel sessizce boşalıyordu.
Sınadım: `fixAvailable`'ı `fixAvaliable` yapınca

```
error TS2561: 'fixAvaliable' does not exist in type 'ReviewDetail'.
Did you mean to write 'fixAvailable'?
```

Tipi bağladığım anda test fixture'larımın `requestedAt` ve `raisedAt`
alanlarını atladığı da ortaya çıktı — yani sunucunun gerçekte göndermediği
bir şekli test ediyorlarmış.

## Envanterin sınırı

`uiInventory.mjs` hem `index.html`'i hem `.vue` şablonlarını okuyor ve
toplamları `sayfa+vue` diye ayrı raporluyor. Göç sırasında sayılar şöyle
oynuyor:

| | Göç öncesi | Şimdi |
|---|---|---|
| modal | 6 | 5+1 = **6** |
| düğme | 54 | 50+11 = **61** |
| alan | 31 | 31+3 = **34** |

Modal sayısı birebir tutuyor. Düğme ve alan sayısının *artması* yeni feature
değil: eski kodda yama kartlarının düğmeleri ve fix modalının alanları
JavaScript'te string olarak üretiliyordu, yani statik markup'ı okuyan bu
script onları hiç göremiyordu. Şablona taşınınca görünür oldular. Yani
envanterin kapsamı arttı — bu, aracın kendi sınırı hakkında bilinmesi
gereken bir şey.

## Mutabakat

| | Göç öncesi | Şimdi |
|---|---|---|
| modal | 6 | **6** |
| API ucu | 27 | **27** |
| düğme | 54 | 69 |
| alan | 31 | 32 |

Modal ve uç sayısı birebir tutuyor. Düğme ve alan sayısının artması yeni
feature değil: eski kodda yama kartlarının düğmeleri, bulgu seçicinin
kutuları ve itiraz/cevap alanları JavaScript'te string olarak üretiliyordu,
yani statik markup'ı okuyan envanter onları hiç göremiyordu. Şablona geçince
görünür oldular — aracın kapsamı arttı, arayüzün yüzeyi değil.

`host` fiilleri yediye çıktı — `startPolling`, `setTabCount`, `showTab`,
`startReview`, `refreshNotes`, `openIssue`, `setViewCount` — artı sayfanın
Vue'ya "şu görünümü tazele" diyebilmesi için `revify.reloadView(name)`.
Liste büyüdü çünkü taşınan kaplar sayfanın *dışına* ilk kez çıktı; kabuk
taşındığında hepsi birden gidecek.

## Göçten sonra: ilk gerçek hata

Uygulama ilk kez çalıştırıldığında **siyah ekran** verdi. Sebebi iki kusurun
üst üste binmesiydi:

1. `App.vue`, `session.ready` olana kadar **hiçbir şey** render etmiyordu.
   Gerekçem "uygulamayı gösterip sonra giriş formuyla değiştirmek daha kötü"
   idi ve bu doğru — ama hiç çizmemek ikisinden de kötü: çöken bir sayfadan
   ayırt edilemiyor, koyu temada da tam anlamıyla siyah bir pencere.
2. `/api/gate`, takım backend'ine yapılan çağrıyı **zaman aşımı olmadan**
   bekliyordu (`BackendClient.request` hiçbir isteğe sınır koymuyordu).
   Kaynaktan çalışan her kurulum ulaşılamayan bir backend'e bakıyor; bağlantı
   hızlıca reddedilmezse çağrı asılı kalıyor.

Düzeltme ikisine birden: her backend isteği 8 sn ile sınırlı (takım
özellikleri zaten yerelde koşan işin üstüne serpiştirilmiş bir konfor —
uygulamayı asamaz), ve açılış ekranı **her zaman bir şey** çiziyor.

Bunu yakalayan şey mevcut 364 test değildi; `App.test.ts`'teki testlerden
biri **yanlış kararı sabitlemişti** ("gate cevaplayana kadar hiçbir şey
gösterme"). `AppBoot.test.ts` artık asla cevaplamayan bir istekle senaryoyu
birebir kuruyor ve eski davranışta düşüyor — doğruladım.

## Tasarım toparlaması

- **`StateNote`**: boş / yükleniyor / hata, her yerde aynı biçimde. On iki
  yerde elle yazılıyordu — farklı markup, farklı sözcükler, hata kimi yerde
  satır-içi kırmızı stil. Ayrım görsellikten fazlası: boş bir liste ile
  başarısız bir istek ikisi de gri metinse aynı görünür, oysa biri "yapacak
  bir şey yok", diğeri "bir şey bozuk" demek.
- **Klavye**: listede `j`/`k`, `Enter` ile aç, `/` ile filtreye atla.
  Yazarken tuşlar ele geçirilmiyor. Onaylama ve reddetme **bilerek** tıklama
  olarak kaldı — kaza eseri bir tuş Jira'ya yazmamalı.
- **`:focus-visible`** halkaları: klavye kullanan, farenin gördüğünü görüyor.
- Hareketi azaltma tercihi olan makinede spinner dönmüyor.

## Göçten sonra: ikinci gerçek hata

Siyah ekran düzeldiği sanılan haliyle sürdü. Konsoldaki satır teşhisi verdi:
`ReferenceError: process is not defined at shared.esm-bundler.js:13`.

`vite build`'in **library modu**, Vue'nun `process.env.NODE_ENV` dallarını
olduğu gibi bırakıyor — aşağıda bir bundler olduğu varsayımıyla. Burada yok:
dosya doğrudan `<script type="module">` ile yükleniyor, tarayıcıda `process`
tanımsız, ilk dokunuşta modül ölüyor. Bundle'da **221 referans** vardı.
`define` ile kapatıldı; yan fayda olarak Vue'nun geliştirme dalları da elendi
(238 KB → 196 KB).

Bunu bir tur önce yazdığım "bundle mount oluyor" testi **göremedi**, çünkü
vitest node'da koşuyor ve node'da `process` var. Yani doğrulama diye sunduğum
şey, doğrulanması gereken tek koşulu atlıyordu. Şimdi üç katman var:
`boot.test.ts` import öncesi `globalThis.process`'i siliyor,
`bundle.test.ts` çıktıyı bayt olarak okuyor, CI ise `dist` içinde
`process.env` geçerse derlemeyi düşürüyor. Üçünü de bozuk bundle'a karşı
sınadım.

`npm test` artık `ui:build` ile başlıyor: bundle'ın bir özelliğini test eden
bir testin fixture'ı build çıktısıdır, ve temiz bir checkout'ta (ve CI'da,
`npm test` build'den önce koştuğu için) dosya henüz yoktu.

## Ölü CSS taraması — asıl bulduğu şey

Stil bloğundaki her kuralın hâlâ bir karşılığı olup olmadığını taradım.
Beklentim biraz artık kural bulmaktı; bulduğu şey **sessiz görsel
regresyonlardı**:

- `#backBtn { display: none }` — geri düğmesi geniş pencerede gizli olmalı;
  panelim onu hep gösteriyordu.
- `.app.has-selection` — dar ekranda bir issue açıkken kenar çubuğu yerini
  detaya bırakır; bu sınıf hiç uygulanmıyordu.
- `.findingBody` — itiraz ekranı bulguyu **tam olarak** gösteriyordu ve eski
  kodun yorumu gerekçesini yazıyordu: *"bir itirazı yalnızca `dosya:satır`
  başlığından yargılamak, her biri için review'e geri dönmek demektir."*
  Benimki yalnızca başlığı gösteriyordu.
- `#detailSummary`, `#connState`, `#modeChip`, `#withdrawnList`,
  `#appliedNotesList`, `#notesEmpty` — her biri bir stil kaybı.

Hiçbiri kontrol sayan envanterin görebileceği şey değildi; **öksüz bir kural
görünür.** Bu yüzden tarama `styles.test.ts` olarak kalıcı hale getirildi ve
kendisi de sınandı: `id="backBtn"` kaldırılınca düşüyor.

Yol üstünde bir gizli eşleşme de ortadan kalktı: `:class="line.outcome"` bir
veri değerini doğrudan CSS sınıf adına bağlıyordu; artık açıkça yazılı.

## Content-Security-Policy

Electron'un uyardığı boşluk kapatıldı — ve **ancak şimdi kapatılabilirdi**:
bu sayfa göçten önce 2000 satırlık bir inline `<script>`'ti, yani
`script-src` `'unsafe-inline'` gerektirirdi, ki o da gerisini büyük ölçüde
anlamsız kılar. Artık inline script yok:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`style-src` hâlâ `'unsafe-inline'` istiyor (tasarım token'ları tek bir
`<style>` bloğunda, bileşenler de `style="…"` kullanıyor). Script'e göre çok
daha zayıf bir yüzey — ne çalıştırabilir ne dışarı veri taşıyabilir — ve
düzgün kapatmak her satır-içi stili hash'lemek demek; ayrı bir iş.

## Politikanın tamamlanması

`style-src` de `'unsafe-inline'`'dan kurtuldu. Bunun için iki şey gerekti:
tasarım token'ları `index.html` içindeki `<style>` bloğundan `app.css`'e
taşındı, ve bileşenlerdeki 24 `style="…"` niteliği sınıflara dönüştü — bir
satır-içi stil niteliği, satır-içi bir script kadar açıkça `'unsafe-inline'`
gerektiriyor, ve kolaylık olsun diye açık bırakılan tek bir direktif, bir
politikanın anlamsızlaşma biçimidir.

`index.html` artık **25 satır**: bir mount noktası ve onu yükleyen iki etiket.

```
default-src 'none'; script-src 'self'; style-src 'self';
img-src 'self' data:; font-src 'self'; connect-src 'self';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Bu dönüşümde regex'im iki yerde **bağlı** `:class` niteliğinin içine yazıp
geçersiz sözdizimi üretti; tip kontrolü yakaladı, ayrı bir düzeltmeyle
onarıldı. `styles.test.ts` de artık sayfada inline script *veya* stil
kalmadığını doğruluyor — politika ancak sayfa altında yaşayabiliyorsa
anlamlı.

## UI/UX toparlaması

### Yalan söyleyen boş durumlar

En ciddi bulgu buydu ve göçün getirdiği bir şey değil, göçün *görünür
kıldığı* bir şeydi. Her panelin bir boş durumu var ve her biri bir olgu
iddiası: *"henüz review yok"*, *"gösterilecek değişiklik yok"*, *"açıklama
yok"*. Bunlar ilk poll uçuştayken de çiziliyordu — yani review'i **olan** bir
işe tıklayıp "yok" cevabı alıyordun.

En kötüsü liste tarafındaydı: uygulama açıldığında görülen ilk şey
*"Eşleşen issue yok — JQL'i kontrol et (config/config.yaml)"* oluyordu. Bu,
insanı hiç bozuk olmayan bir yapılandırma dosyasını düzeltmeye yolluyor.

Artık ikisi de "henüz bilmiyorum" ile "yok"u ayırıyor. Detay paneli ilk
payload gelene kadar panelleri hiç çizmiyor; Jira açıklaması kendi isteği
cevaplayana kadar ayrı bir yükleniyor durumu gösteriyor; liste de öyle.
İddiaların tuttuğunu, yalan boş durumu geri getirip testlerin düştüğünü
görerek doğruladım.

### Erişilebilirlik

- **11 ikon düğmesinin adı yoktu.** `title="Kapat"` bir ipucu balonu; ekran
  okuyucu `✕` görünce "düğme" diyor. Hepsine `aria-label` verildi ve
  `a11y.test.ts` bunu kalıcı kıldı — bir sonraki ikon düğmesini bu konuşmada
  olmayan biri ekleyecek.
- **Sekmelerin rolü yoktu**: `role="tablist"` / `role="tab"` /
  `aria-selected`, panellerde `role="tabpanel"`. Öncesinde ekran okuyucu
  yedi ilgisiz düğme duyuyor, hangisinin açık olduğunu bilmiyordu.
- Üst bardaki görünüm sekmeleri gezinme; onlara `aria-current="page"`.
- Adım günlüğü `role="log" aria-live="polite"` — koşu ilerledikçe yeni
  satırlar okunuyor. Bağlantı hatası `role="status"`.
- Hata kutusu `role="alert"`.

### Küçük bir hiyerarşi düzeltmesi

Detay başlığındaki altı düğme eşit ağırlıktaydı; solundaki her şey işi
başlatan veya sürdüren, **Temizle** ise onu atan bir eylem. Ayırıcı bir
çizgiyle ayrıldı.
