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

Ini butuh dua kali percobaan yang gagal di iPhone sungguhan sebelum ketemu desain yang tahan, jadi dicatat di sini supaya tidak terulang:

1. **Percobaan 1** — scheduler Web Audio API biasa (lookahead scheduler) yang disambung langsung ke `audioContext.destination`. Presisi sample-accurate, tapi begitu layar dikunci, iOS men-suspend `AudioContext` sepenuhnya karena tidak ada elemen `<audio>` yang benar-benar "diputar" — bunyi berhenti total.
2. **Percobaan 2** — scheduler yang sama, tapi outputnya di-stream lewat `MediaStreamAudioDestinationNode` ke elemen `<audio>` tersembunyi, supaya ada "media yang sedang diputar" bagi iOS. Halaman jadi tetap hidup di background, tapi live stream itu punya clock sendiri yang terpisah dari clock internal `AudioContext` — begitu CPU tertekan (background throttling), keduanya saling drift dan elemen `<audio>` terpaksa skip/stretch sample untuk resync. Hasilnya: tempo jadi kacau/acak persis begitu di-background.

**Desain final** (ada di `src/lib/metronome-engine.ts`): tidak ada lagi audio yang di-stream secara live. Seluruh pola ketukan (32 ketukan sekaligus) dirender di muka jadi satu file WAV asli lewat `OfflineAudioContext`, lalu file itu diputar lewat `<audio loop>` biasa — mekanisme yang sama persis dipakai situs musik/podcast untuk playback gapless di background. Karena cuma ada satu clock (mesin media native browser yang me-loop file statis), tidak ada JS timer yang perlu terus berjalan sama sekali setelah play dimulai, sehingga:

- Kebal terhadap background-throttling (tidak ada scheduler JS yang bisa telat/drift).
- Elemen `<audio>` ini justru **adalah** suara yang terdengar, jadi iOS punya alasan jelas untuk tidak men-suspend-nya.

Konsekuensinya: mengubah BPM/suara/mode saat berjalan akan me-render ulang loop dan mengganti file yang diputar — ada jeda/klik singkat sesaat (wajar, sama seperti mengganti tempo di metronome fisik), di-debounce ~180ms supaya menekan tombol +/- berkali-kali tidak memicu render berulang-ulang.

Ini bukan jaminan 100% — perilaku background audio di Safari bisa berubah antar versi iOS. **Wajib diuji langsung**: tekan Mulai, kunci layar, masukkan ke kantong, jalan/lari beberapa menit, dan dengarkan apakah ketukan tetap presisi dan tidak berhenti. Kalau ternyata masih bermasalah di iOS versi HP Anda, opsi berikutnya adalah membungkus app ini dengan Capacitor dan sideload gratis lewat Xcode/AltStore (lihat percakapan sebelumnya) — kode Next.js/React di sini bisa banyak dipakai ulang untuk rute itu.

Setiap kali ada perubahan pada `public/sw.js` atau file di `public/sounds/`, versi `CACHE_VERSION` di `public/sw.js` perlu dinaikkan — kalau tidak, iPhone yang sudah nge-install lewat Add to Home Screen bisa tetap memakai file lama dari cache walau Anda sudah deploy ulang.

Service worker (`public/sw.js`) meng-cache app shell dan file suara supaya metronome tetap jalan walau tidak ada sinyal saat lari.

## Struktur kode

- `src/lib/metronome-engine.ts` — mesin audio inti: decode suara, render loop 32-ketukan lewat `OfflineAudioContext` jadi WAV, putar via `<audio loop>`, Media Session.
- `src/hooks/useMetronome.ts` — hook React yang membungkus engine dan menyimpan setelan terakhir ke `localStorage`.
- `src/components/MetronomeApp.tsx` — UI (BPM, preset, pilihan suara, mode ketukan, volume, tombol mulai/berhenti).
- `public/sounds/` — lima klip beat siap pakai (dipotong & di-fade dari file sumber Anda): `click.mp3` (mode "Sama"), `tik.mp3`/`tok.mp3` (pack "Tik-Tok"), `tik2.mp3`/`tak2.mp3` (pack "Tik-Tak", varian lebih tajam).
- `public/sw.js` — service worker untuk offline caching.
- `src/app/manifest.ts` — manifest PWA (ikon, warna tema, mode standalone).
