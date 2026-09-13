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

Dua jalur audio yang sengaja dipisah di `src/lib/metronome-engine.ts`:

1. **Suara ketukan** — dijadwalkan lewat Web Audio API (lookahead scheduler, sample-accurate) dan disambungkan langsung ke `audioContext.destination`. Ini jalur render native yang jalan di thread audio khusus (bukan main JS thread), jadi begitu sebuah ketukan dijadwalkan, waktu putarnya tidak lagi bergantung pada seberapa lancar JS thread berjalan.
2. **File "keep-alive"** (`public/sounds/keepalive.mp3`, nada sangat pelan ~-55dB, loop) — diputar lewat elemen `<audio>` terpisah yang tidak ada hubungannya dengan suara ketukan. Tugasnya cuma satu: membuat iOS menganggap halaman ini "sedang memutar media" sehingga tidak disuspend penuh saat layar dikunci.

Versi awal sempat menggabungkan keduanya lewat `MediaStreamAudioDestinationNode` (suara ketukan di-stream ke elemen `<audio>` yang sama) — ternyata ini menyebabkan tempo kacau begitu di-background, karena stream langsung dan clock internal `AudioContext` adalah dua clock domain terpisah yang saling drift di bawah tekanan CPU (throttling background), memaksa elemen `<audio>` melompat/meregangkan sample untuk resync. Memisahkan keduanya menghilangkan sumber masalah itu.

Ini bukan jaminan 100% — perilaku background audio di Safari bisa berubah antar versi iOS. **Wajib diuji langsung**: tekan Mulai, kunci layar, masukkan ke kantong, jalan/lari beberapa menit, dan dengarkan apakah ketukan tetap presisi dan tidak berhenti. Kalau ternyata masih bermasalah di iOS versi HP Anda, opsi berikutnya adalah membungkus app ini dengan Capacitor dan sideload gratis lewat Xcode/AltStore (lihat percakapan sebelumnya) — kode Next.js/React di sini bisa banyak dipakai ulang untuk rute itu.

Setiap kali ada perubahan pada `public/sw.js` atau file di `public/sounds/`, versi `CACHE_VERSION` di `public/sw.js` perlu dinaikkan — kalau tidak, iPhone yang sudah nge-install lewat Add to Home Screen bisa tetap memakai file lama dari cache walau Anda sudah deploy ulang.

Service worker (`public/sw.js`) meng-cache app shell dan file suara supaya metronome tetap jalan walau tidak ada sinyal saat lari.

## Struktur kode

- `src/lib/metronome-engine.ts` — mesin audio inti (AudioContext, scheduler, routing ke `<audio>`, Media Session).
- `src/hooks/useMetronome.ts` — hook React yang membungkus engine dan menyimpan setelan terakhir ke `localStorage`.
- `src/components/MetronomeApp.tsx` — UI (BPM, preset, pilihan suara, mode ketukan, volume, tombol mulai/berhenti).
- `public/sounds/` — lima klip beat siap pakai (dipotong & di-fade dari file sumber Anda): `click.mp3` (mode "Sama"), `tik.mp3`/`tok.mp3` (pack "Tik-Tok"), `tik2.mp3`/`tak2.mp3` (pack "Tik-Tak", varian lebih tajam).
- `public/sw.js` — service worker untuk offline caching.
- `src/app/manifest.ts` — manifest PWA (ikon, warna tema, mode standalone).
