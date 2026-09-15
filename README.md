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

Lihat bagian **Lesson learned** di bawah untuk riwayat lengkap empat percobaan (tiga bermasalah, satu di antaranya baru ketahuan setelah dipakai sungguhan) sampai ketemu desain yang tahan: seluruh pola ketukan dirender jadi satu file WAV asli, lalu diputar via `<audio loop>` biasa — bukan di-stream/dijadwalkan secara live. Ini sudah **dikonfirmasi jalan lancar** di iPhone Anda saat layar dikunci maupun app di-background.

Konsekuensinya: mengubah BPM/suara/mode saat berjalan akan me-render ulang loop dan mengganti file yang diputar — ada jeda/klik singkat sesaat (wajar, sama seperti mengganti tempo di metronome fisik), di-debounce ~180ms supaya menekan tombol +/- berkali-kali tidak memicu render berulang-ulang. Indikator visual kiri/kanan disinkronkan ke loop yang **benar-benar sedang audible** (lewat event `onLoopStart` dari engine), bukan ke angka BPM di UI yang bisa berubah duluan sebelum audio-nya menyusul — supaya tidak "warp" tiap kali BPM diubah.

Ini bukan jaminan 100% untuk semua kondisi/semua versi iOS — perilaku background audio di Safari bisa berubah antar rilis. Kalau suatu saat berhenti lagi setelah update iOS, mulai investigasi dari bagian Lesson Learned di bawah sebelum mencoba pendekatan baru dari nol.

Setiap kali ada perubahan pada `public/sw.js` atau file di `public/sounds/`, versi `CACHE_VERSION` di `public/sw.js` perlu dinaikkan — kalau tidak, iPhone yang sudah nge-install lewat Add to Home Screen bisa tetap memakai file lama dari cache walau Anda sudah deploy ulang.

Service worker (`public/sw.js`) meng-cache app shell dan file suara supaya metronome tetap jalan walau tidak ada sinyal saat lari.

## Struktur kode

- `src/lib/metronome-engine.ts` — mesin audio inti: decode suara sekali via `OfflineAudioContext`, susun loop ~10 menit dengan menempel sampel PCM langsung ke array (bukan render lewat audio-graph — lihat Percobaan 4 di bawah), encode ke WAV, putar via `<audio loop>`, Media Session, event `onLoopStart` untuk sinkronisasi UI.
- `src/hooks/useMetronome.ts` — hook React yang membungkus engine dan menyimpan setelan terakhir ke `localStorage`.
- `src/components/MetronomeApp.tsx` — UI (BPM, preset, pilihan suara, mode ketukan, volume, tombol mulai/berhenti, indikator beat kiri/kanan).
- `public/sounds/` — lima klip beat siap pakai (dipotong & di-fade dari file sumber Anda): `click.mp3` (mode "Sama"), `tik.mp3`/`tok.mp3` (pack "Tik-Tok"), `tik2.mp3`/`tak2.mp3` (pack "Tik-Tak", varian lebih tajam).
- `public/sw.js` — service worker untuk offline caching.
- `src/app/manifest.ts` — manifest PWA (ikon, warna tema, mode standalone).

## Lesson learned: empat percobaan sampai stabil dan enak dipakai

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

### Percobaan 3 — Rendering offline jadi file WAV, tapi lewat audio-graph

**Desain:** tidak ada lagi apa pun yang dijadwalkan/di-stream secara *live*. Setiap kali BPM/pola/suara berubah, `OfflineAudioContext` merender seluruh pola (awalnya 32, lalu dinaikkan ke 128 ketukan) jadi satu `AudioBuffer` sekaligus — satu `AudioBufferSourceNode` per ketukan, dijadwalkan lewat `.start(waktu)` seperti scheduler Web Audio pada umumnya — lalu di-encode manual jadi file WAV (PCM 16-bit) via `Blob`. File itu — bukan stream, file sungguhan — diputar lewat elemen `<audio loop>` biasa, sama seperti situs musik/podcast memutar sebuah track.

**Kenapa desain intinya benar:**

- Elemen `<audio>` ini **adalah** suara yang terdengar (bukan pendamping/keep-alive terpisah), jadi iOS punya alasan sah untuk tidak men-suspend-nya — sama seperti alasan Spotify Web Player boleh terus main saat layar dikunci.
- Tidak ada dua clock yang bisa saling drift, karena tidak ada stream real-time sama sekali — hanya satu file statis yang di-loop oleh mesin media native browser.

**Gejala yang baru ketahuan setelah dipakai sungguhan:** jeda di titik sambung loop terasa mengganggu untuk sesi lari beneran (128 ketukan ≈ tiap 45-48 detik di pace 152-170 BPM — puluhan kali kena jeda dalam satu sesi 20-30 menit). Perbaikan pertama yang dicoba (menaikkan `LOOP_BEATS` ke angka lebih besar, misal 1000+) memunculkan gejala baru: **render sempat 21 detik** untuk loop 10-menit di 160 BPM (1600 ketukan).

**Penyebab jeda-terlalu-sering:** `LOOP_BEATS` adalah **jumlah ketukan tetap**, bukan **durasi tetap** — jadi durasi nyata satu loop berubah-ubah drastis tergantung BPM (128 ketukan = 192 detik di 40 BPM, tapi cuma 32 detik di 240 BPM). Di rentang BPM lari yang Anda pakai (152-170), itu artinya loop-nya pendek dan jeda sering muncul.

**Penyebab render-jadi-21-detik:** ini murni soal cara `OfflineAudioContext` bekerja, bukan soal ukuran file. Grafik Web Audio meng-evaluasi **setiap** node yang terhubung pada **setiap** render-quantum (~128 sample) sepanjang durasi render — jadi biayanya kira-kira `jumlah_node × jumlah_quantum`, bukan `jumlah_node × panjang_suara_masing-masing`. Untuk 1600 node (satu per ketukan) × ~206.000 quantum (untuk render 600 detik), itu ratusan juta evaluasi node — walau di tiap quantum hampir semua node itu sebenarnya "diam" (belum atau sudah selesai bunyi). Ini kelemahan yang tidak muncul di 128 ketukan (masih ringan), baru menonjol begitu jumlah ketukan naik ke ribuan.

### Percobaan 4 (dipakai sekarang) — Durasi tetap (bukan ketukan tetap) + stamping PCM manual

Dua perbaikan independen, sama-sama perlu, di `src/lib/metronome-engine.ts`:

**1. Ukuran loop dihitung dari target durasi (`TARGET_LOOP_SECONDS = 600`, 10 menit), bukan jumlah ketukan tetap.** Jumlah ketukan dihitung otomatis dari BPM saat itu (`Math.ceil(600 / secondsPerBeat)`) — hasilnya jeda muncul dengan interval **waktu nyata yang konsisten**, berapa pun BPM-nya, bukan lagi berubah-ubah 32 detik sampai 3 menit seperti sebelumnya.

**2. Loop tidak lagi dirender lewat `OfflineAudioContext`/audio-graph sama sekali** — untuk kasus ini, "menempelkan bunyi pendek di titik-titik waktu tertentu tanpa tumpang tindih" tidak butuh mixing graph audio, cukup salin sampel mentah. `buildLoopSamples()` menyalin PCM tiap suara (sudah di-decode sekali di awal jadi `Float32Array`) langsung ke posisi yang tepat di array besar pakai `TypedArray.set()` — operasi memory-copy murni, bukan simulasi grafik audio. Hasilnya: render loop 10 menit turun dari **21.000ms menjadi ~5-10ms** (diverifikasi lewat instrumentasi `performance.now()` langsung, bukan estimasi), dan waktu total dari klik "Mulai"/ganti setelan sampai audio baru terdengar turun jadi **~230-320ms** (didominasi encode WAV + `el.play()`, bukan lagi oleh render).

**Trade-off yang disadari dan diterima:** lihat bagian **Keterbatasan yang diketahui** di bawah — jeda di titik sambung loop tetap ada, hanya jadi jauh lebih jarang, bukan hilang total.

## Keterbatasan yang diketahui: jeda kecil di titik sambung loop

Setiap loop (sekarang: sekali per ~10 menit, bukan lagi per 128 ketukan), elemen `<audio>` harus melompat balik ke awal file untuk mengulang (`loop = true`). Atribut `loop` di spesifikasi HTML **tidak menjamin** lompatan ini sample-accurate/gapless di semua implementasi browser — WebKit/Safari punya riwayat menyisipkan jeda kecil di titik ini, walau sumbernya WAV/PCM murni (yang seharusnya lebih rapat dibanding MP3 yang punya padding encoder). Ini yang terasa sebagai "hentakan" tempo sesaat.

**Ini murni keterbatasan platform, bukan bug di kode ini** — tidak ada cara memaksa `<audio loop>` gapless dari JavaScript; itu di luar kendali halaman web, ditentukan oleh implementasi mesin media browser.

### Kenapa bukan 1000/2000/5000 *ketukan*? (dan kenapa sekarang berbasis detik, bukan ketukan)

Ini pertanyaan yang tepat untuk ditanyakan sebelum sekadar menaikkan angka. Jawabannya: **tidak ada tembok keras dari iOS/hardware di angka ketukan tertentu** — yang ada adalah dua ongkos nyata, dan keduanya sebenarnya fungsi dari **durasi dalam detik**, bukan jumlah ketukan. Ini kenapa "kenaikan LOOP_BEATS" adalah pertanyaan yang salah kerangka — pertanyaan yang benar adalah "berapa lama satu loop, dalam menit?".

**Ongkos 1 — ukuran file (memori).** WAV mono 16-bit @ 44.1kHz = tepat 44100 × 2 = 88.200 byte/detik ≈ 5,05 MB/menit, **flat berapa pun BPM-nya** (karena format PCM tidak peduli seberapa sering ada bunyi di dalamnya, hanya peduli berapa lama durasinya). Jumlah ketukan itu sendiri tidak berpengaruh ke ukuran file — cuma durasi yang berpengaruh:

| Target durasi loop | Ukuran WAV (mono 16-bit) |
|---|---|
| 1 menit | ~5 MB |
| 10 menit (dipakai sekarang) | ~50 MB |
| 30 menit | ~151 MB |
| 60 menit | ~303 MB |
| 125 menit (≈ 5000 ketukan di 40 BPM) | ~631 MB |

iPhone 15 (RAM 6GB) sanggup menampung ratusan MB satu Blob tanpa masalah dalam kondisi normal. Tapi saat benar-benar dipakai lari, HP kemungkinan juga menjalankan Strava/Apple Health/Maps/Spotify di background berebut RAM yang sama — 600MB untuk satu file metronome jadi taruhan yang tidak perlu diambil untuk manfaat yang kecil (5000 ketukan di 40 BPM = sekali seumur hidup Anda kepakai, karena BPM lari Anda 152-170).

**Ongkos 2 — waktu proses.** Ini yang justru jadi masalah nyata dan sudah dites di sesi ini (lihat Percobaan 3 di atas): kalau proses "menyusun loop" masih lewat `OfflineAudioContext` (satu node per ketukan), waktunya naik jauh lebih cepat daripada linear terhadap jumlah ketukan — 1600 ketukan sampai 21 detik. Setelah diganti ke stamping PCM manual (Percobaan 4), ongkos ini praktis hilang (~5-10ms untuk 10 menit), sehingga sekarang benar-benar aman menaikkan `TARGET_LOOP_SECONDS` jauh lebih tinggi kalau suatu saat dirasa masih kurang panjang — tinggal pertimbangkan ongkos memori (tabel di atas) sebagai satu-satunya batasan yang tersisa.

**Kenapa 10 menit dipilih sebagai default:** untuk lari 5K dengan 2-3 kali ganti fase (warmup → lari → cooldown) seperti yang Anda gambarkan, loop 10 menit kemungkinan besar **tidak akan pernah kena jeda sama sekali** dalam satu fase (fase biasanya lebih pendek dari 10 menit), atau paling banyak sekali. Untuk **interval training** yang ganti tempo tiap 1-5 menit, loop 10 menit jadi "kelebihan" (sebagian besar loop yang dirender tidak akan pernah terdengar sebelum diganti lagi oleh setelan berikutnya) — tapi ini cuma buang-buang sedikit memori/waktu render (~5-10ms, tidak terasa), bukan masalah fungsional, jadi satu nilai default ini tetap aman dipakai untuk kedua skenario. Kalau ke depannya terasa perlu, `TARGET_LOOP_SECONDS` bisa dijadikan setelan yang bisa dipilih pengguna (misal opsi 5/10/20 menit) — tapi untuk sekarang satu nilai tetap sudah cukup mengingat ongkosnya kecil di kedua ujung.

**Kenapa preset "rekaman fixed" (ide Anda) tidak dipakai untuk mengatasi jeda:** ini sempat dipertimbangkan tapi ternyata tidak menyelesaikan masalah yang dimaksud — pre-bake file per preset BPM cuma memindahkan **kapan** rendering terjadi (saat build vs saat runtime), bukan mengubah **bagaimana** `<audio loop>` mengulang filenya. Filenya tetap loop lewat mekanisme WebKit yang sama, jeda di titik sambung tetap ada tidak peduli file itu dirender detik itu juga atau sudah disiapkan sebelumnya. Manfaat nyata dari pre-bake hanya "tap preset langsung main tanpa nunggu render" — dan itu sudah tidak relevan sekarang karena render manual (~5-10ms) sudah jauh di bawah ambang yang terasa oleh manusia, jadi tidak ada nilai tambah yang sepadan dengan kompleksitas ekstra (harus punya dua jalur: preset pre-baked vs BPM off-preset yang tetap butuh render dinamis).

**Kesimpulan:** dalam batasan PWA/browser, jeda periodik ini **memang tidak sepenuhnya bisa dihindari** — hanya bisa dibuat sangat jarang (sekarang: sekali per ~10 menit, dulu sekali per ~48 detik). Untuk penghilangan total, lihat perbandingan Capacitor vs native di bawah — di situ mekanismenya (`AVAudioPlayerNode` loop di level OS) memang didesain gapless, bukan cuma "dibuat jarang".

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
