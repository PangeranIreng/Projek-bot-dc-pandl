---
name: DATABASE system
description: Arsitektur sistem DATABASE baru — setup, panel, backup, smart clean, console, member list
---

# DATABASE System

## File yang dibuat
- `src/database/databaseDB.js` — JSON store di `data/database-db.json`
- `src/commands/setup.js` — slash command `/setup`
- `src/features/database/embed.js` — semua embed builder
- `src/features/database/backup.js` — ZIP backup (adm-zip), storage stats, smart clean logic
- `src/features/database/console.js` — console channel logger (new message per event)
- `src/features/database/memberList.js` — member stats + export
- `src/features/database/interaction.js` — handler semua `db:` interactions

## File yang dimodifikasi
- `src/events/interactionCreate.js` — tambah route `db:` → `handleDatabaseInteraction`
- `src/features/help/handler.js` — tambah kategori "database" di CATEGORIES + USAGE
- `src/events/ready.js` — tambah `initConsole(client)` + `consoleLog("online", ...)`

## Custom ID prefix: `db:`

### Setup flow IDs
- `db:setup:open` → buka setup (jika belum ada: channel select; jika ada: manage menu)
- `db:setup:close` / `db:setup:cancel` → tutup ephemeral
- `db:select:botSetting/backup/console/memberList` → ChannelSelectMenu, update session Map
- `db:setup:create` → tampilkan summary setelah semua channel dipilih
- `db:setup:confirmcreate` → buat semua panel dan simpan ke DB
- `db:setup:edit` → kembali ke channel select (prefill dari DB jika sudah ada)
- `db:setup:rebuild` → hapus + buat ulang panel
- `db:setup:delete` → hapus pesan panel (bukan data/channel)

### Panel IDs
- `db:panel:setting:edit/refresh` — Bot Setting
- `db:panel:backup:backup/smartclean/storage/refresh` — Backup
- `db:panel:backup:download:<tmpId>` / `db:panel:backup:upload:<tmpId>` — post-backup actions
- `db:panel:clean:detail/clean/confirmyes/confirmno/rescan` — Smart Clean flow
- `db:panel:member:view/search/export/refresh` — Member List

### Modal IDs
- `db:modal:setting` — edit GitHub repo, auto backup, auto clean
- `db:modal:member:search` — cari member

## In-memory session stores (interaction.js)
- `_setupSessions: Map<userId, {botSetting,backup,console,memberList}>` — pilihan channel sementara
- `_cleanSessions: Map<userId, SmartCleanResult>` — hasil scan smart clean sementara

## Aturan penting
- Console TIDAK pakai Edit Message — setiap log = pesan baru
- Bot Setting, Backup, Member List = SATU pesan, selalu Edit Message
- "Hapus Panel" hanya hapus Discord messages, TIDAK hapus channel/database/config
- Smart Clean: cek `PROTECTED_PATTERNS` dua kali (scan + saat execute) untuk safety
- GitHub upload: baca `process.env.GITHUB_TOKEN`, repo dari env atau `databaseDB.get().github.repo`
- Backup ZIP pakai `adm-zip` (sudah ada di dependencies)
- Backup temp disimpan di `os.tmpdir()/bot-backups/`, auto-delete setelah 30 menit

**Why:** Sistem terpisah dari fitur lama (scanner, ticket, premium, boombox) — tidak ada import circular, tidak ada perubahan ke fitur existing.
