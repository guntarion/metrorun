# Metrorun

Metronome PWA untuk memandu pace lari — atur BPM ketukan, pakai preset umum (152/156/160/165/170), naikkan/turunkan on the fly, dan pilih apakah ketukan genap-ganjil bersuara sama atau beda (tik kiri / tok kanan).

## Menjalankan secara lokal

```bash
npm install
npm run dev
```

Buka [http://localhost:3000](http://localhost:3000).

## Deploy ke Vercel

Repo ini adalah project Next.js standar, jadi tinggal `vercel deploy` atau hubungkan repo ke dashboard Vercel seperti biasa. Tidak ada environment variable yang dibutuhkan.

## Memasang di iPhone (tanpa akun Apple Developer)

1. Buka URL hasil deploy di Safari (bukan Chrome/lainnya — PWA install hanya lewat Safari di iOS).
2. Tap tombol Share, pilih **Add to Home Screen**.
3. Buka app dari ikon di Home Screen (bukan dari tab Safari) — mode `standalone` ini yang paling stabil untuk audio background.

## Kenapa bisa tetap bunyi walau layar dikunci

Lihat bagian **Lesson learned** di bawah untuk riwayat lengkap tiga percobaan (dua gagal di iPhone sungguhan) sampai ketemu desain yang tahan: rendering seluruh pola ketukan jadi satu file WAV asli lewat `OfflineAudioContext`, lalu diputar via `<audio loop>` biasa — bukan di-stream/dijadwalkan secara live. Ini sudah **dikonfirmasi jalan lancar** di iPhone Anda saat layar dikunci maupun app di-background.

Konsekuensinya: mengubah BPM/suara/mode saat berjalan akan me-render ulang loop dan mengganti file yang diputar — ada jeda/klik singkat sesaat (wajar, sama seperti mengganti tempo di metronome fisik), di-debounce ~180ms supaya menekan tombol +/- berkali-kali tidak memicu render berulang-ulang. Indikator visual kiri/kanan disinkronkan ke loop yang **benar-benar sedang audible** (lewat event `onLoopStart` dari engine), bukan ke angka BPM di UI yang bisa berubah duluan sebelum audio-nya menyusul — supaya tidak "warp" tiap kali BPM diubah.

Ini bukan jaminan 100% untuk semua kondisi/semua versi iOS — perilaku background audio di Safari bisa berubah antar rilis. Kalau suatu saat berhenti lagi setelah update iOS, mulai investigasi dari bagian Lesson Learned di bawah sebelum mencoba pendekatan baru dari nol.

Setiap kali ada perubahan pada `public/sw.js` atau file di `public/sounds/`, versi `CACHE_VERSION` di `public/sw.js` perlu dinaikkan — kalau tidak, iPhone yang sudah nge-install lewat Add to Home Screen bisa tetap memakai file lama dari cache walau Anda sudah deploy ulang.

Service worker (`public/sw.js`) meng-cache app shell dan file suara supaya metronome tetap jalan walau tidak ada sinyal saat lari.

## Struktur kode

- `src/lib/metronome-engine.ts` — mesin audio inti: decode suara, render loop 128-ketukan lewat `OfflineAudioContext` jadi WAV, putar via `<audio loop>`, Media Session, event `onLoopStart` untuk sinkronisasi UI.
- `src/hooks/useMetronome.ts` — hook React yang membungkus engine dan menyimpan setelan terakhir ke `localStorage`.
- `src/components/MetronomeApp.tsx` — UI (BPM, preset, pilihan suara, mode ketukan, volume, tombol mulai/berhenti, indikator beat kiri/kanan).
- `public/sounds/` — lima klip beat siap pakai (dipotong & di-fade dari file sumber Anda): `click.mp3` (mode "Sama"), `tik.mp3`/`tok.mp3` (pack "Tik-Tok"), `tik2.mp3`/`tak2.mp3` (pack "Tik-Tak", varian lebih tajam).
- `public/sw.js` — service worker untuk offline caching.
- `src/app/manifest.ts` — manifest PWA (ikon, warna tema, mode standalone).

## Lesson learned: tiga percobaan sampai audio background stabil

Dicatat lengkap di sini supaya kalau nanti ada masalah serupa (atau proyek PWA audio lain), tidak perlu menemukan ulang dari nol lewat trial-and-error di HP sungguhan.

### Percobaan 1 — Web Audio scheduler langsung ke speaker

**Desain:** lookahead scheduler (pola standar metronome web) menjadwalkan `AudioBufferSourceNode` lewat `audioContext.destination` langsung. Presisi sample-accurate secara teori karena dijalankan di thread audio khusus, terpisah dari main JS thread.

**Gejala di iPhone:** begitu layar dikunci, bunyi **berhenti total**.

**Penyebab:** iOS/Safari hanya memberi izin sebuah halaman untuk terus diproses di background kalau ada elemen `<audio>`/`<video>` yang **benar-benar sedang diputar** dan dikenali sebagai sesi media aktif. `AudioContext` telanjang tanpa elemen media yang menyertainya dianggap tidak punya alasan untuk tetap hidup begitu tab tidak terlihat, jadi WebKit men-suspend-nya (dan tidak selalu meng-otomatis-resume ketika kembali ke foreground juga).

### Percobaan 2 — Scheduler yang sama, di-stream ke elemen `<audio>`

**Desain:** scheduler tetap sama, tapi output digabungkan lewat `MediaStreamAudioDestinationNode` lalu dialirkan sebagai live stream ke sebuah `<audio>` tersembunyi (`audio.srcObject = mediaStream`). Idenya: sekarang ADA elemen `<audio>` yang diputar, jadi iOS mengizinkan proses tetap jalan.

**Gejala di iPhone:** halaman memang tidak lagi disuspend — bunyi tetap ada — tapi begitu di-background, **tempo jadi kacau/acak**, berbeda dari tempo yang seharusnya.

**Penyebab:** `MediaStream` adalah aliran real-time dengan clock-nya sendiri, terpisah dari clock internal `AudioContext` yang menghasilkannya. Selama app di foreground dengan CPU longgar, dua clock ini cukup dekat sehingga bedanya tak terasa. Begitu di-background dan CPU dijatah lebih ketat (throttling), kedua clock itu saling *drift* — dan elemen `<audio>` penerima stream terpaksa men-skip atau meregangkan sample untuk tetap sinkron dengan buffernya sendiri. Itulah yang terdengar sebagai tempo acak.

**Pelajaran:** menambal masalah "izin background" dengan sekadar menempelkan sebuah `<audio>` yang menerima live stream bisa memindahkan masalah dari "berhenti total" ke "berjalan tapi rusak" — sama-sama tidak bisa dipakai, dan yang kedua justru lebih menyesatkan karena awalnya *terlihat* berhasil (baru rusak setelah dites background sungguhan).

### Percobaan 3 (dipakai sekarang) — Rendering offline jadi file WAV asli

**Desain:** tidak ada lagi apa pun yang dijadwalkan/di-stream secara *live*. Setiap kali BPM/pola/suara berubah, `OfflineAudioContext` merender seluruh pola (128 ketukan) jadi satu `AudioBuffer` sekaligus, lalu di-encode manual jadi file WAV (PCM 16-bit) via `Blob`. File itu — bukan stream, file sungguhan — diputar lewat elemen `<audio loop>` biasa, sama seperti situs musik/podcast memutar sebuah track.

**Kenapa ini menang di kedua sisi:**

- Elemen `<audio>` ini **adalah** suara yang terdengar (bukan pendamping/keep-alive terpisah), jadi iOS punya alasan sah untuk tidak men-suspend-nya — sama seperti alasan Spotify Web Player boleh terus main saat layar dikunci.
- Tidak ada dua clock yang bisa saling drift, karena tidak ada stream real-time sama sekali — hanya satu file statis yang di-loop oleh mesin media native browser. Setelah `play()` dipanggil, tidak ada satu pun JS timer yang perlu terus berjalan supaya tempo tetap presisi.

**Trade-off yang disadari dan diterima:** lihat bagian **Keterbatasan yang diketahui** di bawah.

## Keterbatasan yang diketahui: jeda kecil di titik sambung loop

Setiap `LOOP_BEATS` ketukan (128 ketukan; ~48 detik di 160 BPM, ~34 detik di 224 BPM, ~3 menit di 40 BPM), elemen `<audio>` harus melompat balik ke awal file untuk mengulang (`loop = true`). Atribut `loop` di spesifikasi HTML **tidak menjamin** lompatan ini sample-accurate/gapless di semua implementasi browser — WebKit/Safari punya riwayat menyisipkan jeda kecil di titik ini, walau sumbernya WAV/PCM murni (yang seharusnya lebih rapat dibanding MP3 yang punya padding encoder). Ini yang terasa sebagai "hentakan" tempo sesaat setiap beberapa puluh detik.

**Ini murni keterbatasan platform, bukan bug di kode ini** — tidak ada cara memaksa `<audio loop>` gapless dari JavaScript; itu di luar kendali halaman web, ditentukan oleh implementasi mesin media browser.

**Mitigasi yang sudah diterapkan:** `LOOP_BEATS` dinaikkan dari 32 → 128, jadi jeda ini terjadi 4x lebih jarang (dulu tiap ~12 detik di 160 BPM, sekarang tiap ~48 detik) — file WAV tetap kecil (puluhan MB paling besar di BPM rendah) dan waktu render tetap praktis instan, jadi menaikkan angka ini lebih lanjut (misal 256) masih murah kalau jeda ini masih terasa mengganggu, tinggal ubah konstanta `LOOP_BEATS` di `src/lib/metronome-engine.ts`.

**Kenapa tidak sekalian dihilangkan total** (opsi yang dipertimbangkan tapi sengaja tidak diambil):

- *Render seluruh durasi lari* (misal 60 menit) jadi satu file tanpa loop sama sekali — tidak praktis: WAV mono 16-bit 60 menit ≈ 317 MB, terlalu besar untuk sebuah Blob di memori HP dan lama untuk dirender/didekode.
- *Dua elemen `<audio>` yang saling estafet* (elemen B mulai diputar tepat sebelum elemen A selesai, lalu bergantian) — bisa menghilangkan jeda saat app di foreground, tapi mekanisme "tepat sebelum selesai" itu butuh JS timer yang mengukur waktu dengan presisi tinggi. Persis jenis ketergantungan pada JS timer yang baru saja terbukti tidak bisa diandalkan di background (Percobaan 1 & 2 di atas) — berisiko menukar masalah kecil (jeda tiap 48 detik) dengan masalah besar yang sudah pernah terjadi (tempo kacau saat di-background). Tidak sepadan.

Kesimpulan: dalam batasan PWA/browser, jeda periodik ini **memang tidak sepenuhnya bisa dihindari** — hanya bisa dibuat sangat jarang. Untuk penghilangan total, lihat perbandingan Capacitor vs native di bawah.

## Kalau dibungkus Capacitor, apakah kedua masalah ini terpecahkan?

Pertanyaan yang bagus untuk dijawab sebelum memutuskan investasi waktu ke sana. Jawabannya **tergantung seberapa jauh Capacitor-nya dipakai**:

**Capacitor sebagai pembungkus murni** (kode React/Next.js dipakai apa adanya, tanpa plugin native) — halaman tetap jalan di dalam `WKWebView`, mesin web yang sama persis dengan Safari untuk urusan Web Audio/HTML5 `<audio>`. Jeda loop-seam **kemungkinan besar tetap ada** karena itu masalah di implementasi elemen `<audio>`-nya WebKit, bukan soal kebijakan background iOS. Untuk masalah background-suspend, kemungkinan **membaik** karena Capacitor bisa mendeklarasikan `UIBackgroundModes: audio` di `Info.plist` — izin resmi tingkat OS ("app ini sah butuh main audio di background"), bukan lagi ditebak-tebak lewat "ada `<audio>` yang keputar apa nggak" seperti di PWA Safari biasa. Ini kemungkinan besar akan lebih stabil dan lebih dapat diprediksi antar versi iOS dibanding pendekatan PWA sekarang.

**Capacitor + native audio plugin** (menulis sedikit kode Swift yang dipanggil dari JS via Capacitor plugin API, memakai `AVAudioEngine`/`AVAudioPlayerNode`) — ini yang benar-benar menyelesaikan **kedua** masalah:

- `AVAudioPlayerNode.scheduleBuffer(_:at:options:.loops)` mengulang buffer PCM persis di titik sample yang sama, nol gap — karena beroperasi di level mixing graph audio milik OS, bukan menebak-nebak lewat elemen `<audio>` HTML.
- `AVAudioSession` dengan kategori `.playback` adalah mekanisme resmi & terdokumentasi Apple untuk audio background, dipakai oleh semua app musik/metronome asli di App Store — bukan efek samping yang bisa berubah sewaktu-waktu antar versi iOS seperti trik PWA.

Konsekuensi: sebagian besar kode React/Next.js (UI, state, logika BPM/preset) tetap bisa dipakai ulang, tapi bagian pemutaran audio (`metronome-engine.ts`) perlu ditulis ulang sebagai plugin native kecil — bukan sekadar "bungkus dan jalan".

## Dibandingkan native Swift + Xcode langsung (tanpa Capacitor)

| | PWA (sekarang) | Capacitor (wrapper saja) | Capacitor + plugin native | Native Swift/Xcode penuh |
|---|---|---|---|---|
| Butuh akun Apple Developer berbayar | Tidak | Tidak (sideload gratis, expire 7 hari / AltStore-refresh) | Tidak (sama) | Tidak (sama) |
| Background audio | Bekerja, tapi cara kerjanya "ditebak" dari perilaku WebKit yang bisa berubah | Kemungkinan lebih stabil (izin OS resmi via `UIBackgroundModes`) | Solid (mekanisme OS resmi, `AVAudioSession`) | Solid (sama, native langsung) |
| Jeda loop-seam | Ada, dibuat jarang (~tiap 48 detik) | Kemungkinan masih ada (WebKit) | Hilang (`AVAudioPlayerNode` loop nol-gap) | Hilang (sama) |
| Reuse kode yang sudah ada | 100% | ~100% | ~85-90% (UI/state tetap, engine audio ditulis ulang di Swift) | ~0% (UI juga ditulis ulang di SwiftUI) |
| Kerja tambahan yang dibutuhkan | Tidak ada | Setup proyek iOS via Capacitor CLI, `pod install`, build lewat Xcode | Semua di atas + menulis plugin Swift (AVAudioEngine) + jembatan JS↔Swift | Belajar/menulis SwiftUI + AVFoundation dari nol, siklus hidup app, dsb. |
| Alat yang dibutuhkan | Browser saja | Xcode + Mac (untuk build ke iPhone) | Xcode + Mac + pengetahuan Swift dasar | Xcode + Mac + pengetahuan Swift/SwiftUI |

**Ringkasnya:** Capacitor **tidak otomatis** menyelesaikan kedua masalah hanya dengan membungkus — untuk background audio kemungkinan besar membantu signifikan (izin OS resmi), tapi jeda loop-seam butuh langkah ekstra (plugin native `AVAudioEngine`). Kalau langkah ekstra itu diambil, hasilnya setara dengan native Swift penuh untuk urusan audio, sambil tetap mempertahankan sebagian besar investasi kode React/Next.js yang sudah ada — itu yang membuat Capacitor+plugin lebih hemat biaya dibanding menulis ulang semuanya di SwiftUI dari nol. Native Swift penuh unggul kalau ke depannya butuh fitur native lain yang lebih dalam (widget lock-screen kustom, Apple Watch companion, dll.) yang di luar cakupan sekadar "metronome tetap presisi di background".
