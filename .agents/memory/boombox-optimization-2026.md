---
name: BoomBox Optimization – July 2026
description: Ringkasan optimasi total BoomBox production-ready: timeouts, embed, Kaizen endpoint, logging.
---

# BoomBox Optimization – July 2026

## Rule
Setelah optimasi ini, arsitektur provider YouTube harus:
1. yt-dlp (multi-method: default → android_vr → android)
2. @distube/ytdl-core
3. Kaizen API (endpoint primer: kaizenapi.my.id/downloader/youtube, fallback: api.kaizenapi.my.id/ytmp3)

**Why:** "Analytzy" tidak ada dalam codebase; provider order di atas adalah yang verified working.

## How to apply
- Jangan tambah smoothDelay() kembali — sudah dihapus by design.
- Embed hanya 3 step (0=Processing, 1=Downloading, 2=Finishing) — jangan kembali ke 6 step.
- getVideoInfo timeout: 8s (non-fatal, boleh gagal).
- yt-dlp per-method timeout: 30s early, 90s last.
- Kaizen API timeout: 8s untuk API call, 60s untuk file download.
- kaizenDownload() menerima signal (AbortSignal) sebagai param ke-5.
