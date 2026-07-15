# Keylogger Scanner Bot

Discord bot (discord.js v14) yang memindai file attachment secara otomatis dan melaporkan penilaian ancaman malware. Juga menyertakan BoomBox musik, sistem tiket, laporan bug, dan CPanel role-panel.

---

## Menjalankan Bot

```bash
npm install   # atau: pnpm install
npm start     # atau: node index.js
```

**Secret yang wajib diisi:**
- `BOT_TOKEN` — token bot Discord (Discord Developer Portal → Bot → Token)
- `SCAN_CHANNEL_ID` — (opsional) channel yang dipantau scanner; default dari `config/channels.js`

---

## Struktur Project

```
├── index.js              Entry point — startup, Discord client, event wiring
├── config/
│   ├── bot.js            Pemuatan secret dinamis (BOT_TOKEN, SCAN_CHANNEL_ID)
│   ├── channels.js       Semua Channel ID Discord
│   ├── roles.js          Semua Role ID Discord
│   ├── owner.js          Guild ID + owner/developer user ID
│   ├── settings.js       Limit scanner (ukuran file, ekstensi, dll)
│   └── constants.js      Re-export semua ID + objek IDS gabungan
│
├── src/
│   ├── commands/         Slash commands (/addprem, /cticket, /help, dll)
│   ├── events/           Handler event Discord (ready, messageCreate, interactionCreate)
│   ├── handlers/         Dispatcher pesan & interaksi scanner
│   ├── middleware/        permissions.js — isStaff, isOwner, denyIfNotStaff
│   ├── services/         Downloader eksternal (ytmp3gg, top4top, kaizenDownloader, durationParser)
│   ├── utils/            Helper bersama (logger, fileUtils, embedBuilder, buttons, dll)
│   │
│   ├── database/         Semua DB JSON persisten (boomboxDB, premiumDB, ticketDB, dll)
│   │
│   └── features/
│       ├── scanner/      Engine analisis malware (19 file: decoder, heuristic, riskScore, dll)
│       ├── boombox/      Fitur musik BoomBox (handler, interaction, embed, config)
│       ├── monitoring/   Dashboard monitoring real-time
│       ├── premium/      Manajemen premium (log, roleSync, sweep, statsDashboard)
│       ├── ticket/       Sistem tiket (handler, interaction, embed, dashboard)
│       ├── bugreport/    Sistem laporan bug & feature request
│       ├── logs/         BoomBox log dashboard
│       ├── queue/        Antrian BoomBox (maks 5 concurrent)
│       ├── help/         Handler slash command /help
│       └── setup/        Setup page + CPanel role-button panels
│
├── data/                 Database JSON flat-file (boombox-db, ticket-db, dll)
├── storage/              Download, cache, temp, backup
├── logs/                 Log file
├── scripts/              Skrip utilitas
└── bin/                  Binary yt-dlp
```

---

## Fitur

| Fitur | Deskripsi |
|-------|-----------|
| **Scanner** | Auto-scan file upload → laporan threat + tombol Detail/Preview/Re-scan |
| **BoomBox** | Konversi YouTube/TikTok ke audio, antrian FIFO, limit harian |
| **Ticket** | Open/Claim/Close/Transcript via private thread, dashboard log |
| **Bug Report** | Panel laporan bug & feature request dengan kategori |
| **CPanel** | Panel role toggle interaktif konfigurasi via slash command |
| **Auto Thread** | Buat thread otomatis di channel yang dikonfigurasi |
| **Premium** | Manajemen premium dengan durasi (7d/12h/30m/permanent) |
| **Monitoring** | Dashboard real-time statistik bot (edit message, tidak spam) |

---

## Command

| Command | Deskripsi |
|---------|-----------|
| `/addprem` | Beri Premium ke user/role |
| `/removeprem` | Cabut Premium |
| `/setlimit` | Set limit harian BoomBox |
| `/resetlimit` | Reset limit harian user |
| `/premstats` | Panel statistik premium |
| `/cticket` | Setup panel tiket |
| `/delcticket` | Hapus konfigurasi tiket |
| `/setclaimticket` | Set channel Staff Control tiket |
| `/cbug` | Setup panel bug report |
| `/delcbug` | Hapus konfigurasi bug report |
| `/cpanel` | Buat/kelola CPanel role |
| `/cc` | Setup channel CPanel |
| `/thread` | Toggle auto-thread di channel |
| `/help` | Daftar semua command |

**Prefix command:** `!hesu` — status real-time bot (ping, uptime, statistik per-fitur)

---

## Catatan Penting

- Semua Channel/Role/Guild ID ada di `config/channels.js`, `config/roles.js`, dan `config/owner.js`. **Jangan hardcode ID di file lain.**
- Data bot disimpan di `data/*.json` (flat-file, tidak perlu database eksternal).
- Scanner tidak pernah memfabrikasi hasil yang tidak dapat dihasilkan (analisis bytecode RAR/7z/EXE dilaporkan sebagai "analisis terbatas").
- Monitoring dashboard selalu di-edit (tidak pernah membuat pesan baru) — simpan `messageId` di DB.
