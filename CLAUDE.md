@AGENTS.md

# Alur kerja

Setelah perubahan selesai dan terverifikasi (tsc, lint, cek tampilan), langsung commit dan push ke `main` tanpa menunggu diminta. Commit hanya file yang diubah, pesan commit berbahasa Indonesia. Tetap tanya dulu untuk aksi destruktif (force push, hapus branch, rewrite history).

# Target browser

Aplikasi harus jalan di iPhone 7 (iOS 15.8, Safari 15). Jangan hapus `browserslist` di `package.json`, volume ditanam ke sampel WAV karena iOS mengabaikan `audio.volume`, dan layout harus muat satu layar tanpa scroll di sekitar 375x553.
