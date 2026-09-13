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

iOS menganggap sebuah tab/PWA sedang "memutar media" — dan karena itu layak dapat waktu CPU di background — kalau audio-nya mengalir lewat elemen `<audio>` yang mulai diputar dari sebuah user gesture (tap tombol Mulai). Engine di `src/lib/metronome-engine.ts` memanfaatkan ini: Web Audio API dipakai untuk penjadwalan ketukan yang presisi (sample-accurate, lookahead scheduler), lalu outputnya dialirkan lewat `MediaStreamAudioDestinationNode` ke elemen `<audio>` tersembunyi — bukan langsung ke speaker. Kombinasi ini juga didaftarkan ke Media Session API supaya lock screen menampilkan kontrol "Now Playing" dan BPM saat ini.

Ini bukan jaminan 100% — perilaku background audio di Safari bisa berubah antar versi iOS. **Wajib diuji langsung**: tekan Mulai, kunci layar, masukkan ke kantong, jalan/lari beberapa menit, dan dengarkan apakah ketukan tetap presisi dan tidak berhenti. Kalau ternyata gagal di iOS versi HP Anda, opsi berikutnya adalah membungkus app ini dengan Capacitor dan sideload gratis lewat Xcode/AltStore (lihat percakapan sebelumnya) — kode Next.js/React di sini bisa banyak dipakai ulang untuk rute itu.

Service worker (`public/sw.js`) meng-cache app shell dan file suara supaya metronome tetap jalan walau tidak ada sinyal saat lari.

## Struktur kode

- `src/lib/metronome-engine.ts` — mesin audio inti (AudioContext, scheduler, routing ke `<audio>`, Media Session).
- `src/hooks/useMetronome.ts` — hook React yang membungkus engine dan menyimpan setelan terakhir ke `localStorage`.
- `src/components/MetronomeApp.tsx` — UI (BPM, preset, pilihan suara, mode ketukan, volume, tombol mulai/berhenti).
- `public/sounds/` — lima klip beat siap pakai (dipotong & di-fade dari file sumber Anda): `click.mp3` (mode "Sama"), `tik.mp3`/`tok.mp3` (pack "Tik-Tok"), `tik2.mp3`/`tak2.mp3` (pack "Tik-Tak", varian lebih tajam).
- `public/sw.js` — service worker untuk offline caching.
- `src/app/manifest.ts` — manifest PWA (ikon, warna tema, mode standalone).
