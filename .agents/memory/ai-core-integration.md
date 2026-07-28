---
name: AI Core integration
description: Advisory, channel-scoped intelligence; architecture rules, investigation modes, file handling, and search scoring for AI Core.
---

# AI Core — Integration Rules & Architecture

**Why:** Multiple rounds of enhancement; these constraints prevent regressions.

## Architecture Rules
- Advisory only — AI Core never edits source code or executes a generated fix.
- All provider calls go through `requestModel()` in `core.js` — never build separate provider clients.
- `investigate()` is the main entry point for deep analysis; `chatWithAI()` is for conversation.
- `getProjectKnowledge()` auto-rebuilds the project index when stale (TTL 1 hr + package.json mtime).

## Investigation Modes (`getInvestigationMode(query)` in core.js)
Returns one of: `"security"` | `"performance"` | `"discord"` | `"provider"` | `"database"` | `null` (generic bug hunt).  
Each mode has a dedicated system prompt in `buildSpecializedSystemPrompt()`.

Triggers (in `INVESTIGATION_TRIGGERS`):
- Generic: "cek bug", "cek error", "audit", "review", "investigasi", "root cause", "trace", "debug", "flow"
- Specialized: "security review/audit", "performance review/audit", "discord review", "provider review", "database review"

## File Attachment Handling (conversation.js)
- **Image attachments** → `attachmentAsDataUrl()` → passed as `image` to `investigate()`
- **Text attachments** (.js, .json, .log, .yml, .sql, .csv, .md, .txt, etc.) → `attachmentAsText()` → passed as `fileContent` to `investigate()`
- `fileContent` is prepended to project context in `investigate()` as highest-priority source
- Max text attachment size: 20 KB per file
- ZIP and PDF/DOCX are NOT yet supported (separate follow-up tasks proposed)

## Project Index Fields (`extractMetadata()` in projectIndexer.js)
Extracted per file: `functions`, `classes`, `methods`, `constants`, `events`, `commands`, `customIds`, `imports`, `exports`, `todos`

Search scoring weights:
- +3: path match
- +2: exports, classes, commands, customIds, constants
- +1: methods, events, functions, imports, todos

## Context Building
- **Deep mode** (`gatherDeepContext`): top 10 candidate files, full contents + 2 levels of local imports, 32 KB cap
- **Shallow mode** (`relevantContext`): top 8 files, 60-line keyword-anchored excerpts, 28 KB cap
- **Conversation injection** (`buildProjectContextSnippet`): top 4 matches, 3 KB cap, only when PROJECT_CONTEXT_KEYWORDS regex matches

## How to Apply
- When adding new review modes: add detection regex to `getInvestigationMode()`, add prompt lines to `modeLines` in `buildSpecializedSystemPrompt()`.
- When adding new metadata fields: update `extractMetadata()`, `rebuildProjectIndex()` return shape, `formatFileContext()`, and `searchProject()` scoring.
- When adding new attachment types: add to `TEXT_EXTENSIONS`/`TEXT_MIME_PATTERN` in conversation.js.
