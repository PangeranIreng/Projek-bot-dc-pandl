---
name: Lua Tools Architecture
description: File layout, DB singleton export, interaction prefix, and API env vars for the Lua Tools feature.
---

# Lua Tools Architecture

**Why:** Added as a new feature alongside BoomBox/Scanner — must not touch any existing feature code except wiring files.

## File layout
- `src/database/luaToolsDB.js` — JSON DB class (channels + logChannels per tool)
- `src/database/db.js` — exports `ltDB = new LuaToolsDB()` singleton alongside `db` and `premDB`
- `src/features/luatools/embed.js` — all embed builders
- `src/features/luatools/beautify.js` — local Lua beautifier (luaparse for validation, line-by-line indent)
- `src/features/luatools/api.js` — generic multipart POST API client for obfuscator/deobfuscator
- `src/features/luatools/handler.js` — messageCreate handler (checks ltDB channels, processes .lua files)
- `src/features/luatools/setup/panel.js` — main setup panel (configured vs unconfigured views)
- `src/features/luatools/setup/channelSetup.js` — channel picker per tool
- `src/features/luatools/setup/logChannelSetup.js` — log channel picker per tool
- `src/features/luatools/setupInteraction.js` — routes all `ltsetup:` interactions
- `src/commands/setupluatools.js` — `/setupluatools` command (denyIfNotStaff)

## Wiring
- `src/events/interactionCreate.js` — added `ltsetup:` routing → `handleLuaToolsSetupInteraction`
- `src/events/messageCreate.js` — added `handleLuaToolsMessage(message)` after BoomBox
- `src/features/help/handler.js` — added `luatools` category + `setupluatools` USAGE entry

## Interaction prefixes
- `ltsetup:` — all setup wizard buttons/selects
- No `lt:` buttons needed — feature is purely message-driven

## API environment variables
- `LUA_OBFUSCATOR_API_URL` + `LUA_OBFUSCATOR_API_KEY` — obfuscator POST endpoint + bearer token
- `LUA_DEOBFUSCATOR_API_URL` + `LUA_DEOBFUSCATOR_API_KEY` — deobfuscator POST endpoint + bearer token
- API expects multipart/form-data with field `file`; responds with plain text or JSON `{result|code|output}`

**How to apply:** Any future Lua Tools change should touch only `src/features/luatools/` and its wiring points. Do not touch BoomBox, Scanner, or other features.
