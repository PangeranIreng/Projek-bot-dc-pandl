---
name: AI Core integration
description: Durable boundaries for the bot's central intelligence layer
---

AI Core is an advisory, owner-controlled layer that must stay inside the existing
setup, error logging, and message-routing architecture. It may analyze and
generate fix prompts, but it must not edit source code, respond to public chat,
or create a second process-level error handler.

**Why:** The bot already has centralized routing and structured error logging;
duplicating those paths would risk breaking BoomBox, scanner, and admin features.

**How to apply:** Add new AI capabilities behind the existing AI Core service,
keep investigation channel-scoped, redact secrets before persistence/provider
calls, and preserve a local fallback when the model provider is unavailable.

Provider credentials may be managed from the Owner-only AI Configuration panel:
validate before commit, encrypt at rest with `AI_CORE_ENCRYPTION_KEY` or
`SESSION_SECRET`, hot-reload the provider client, and fall back to
`OPENAI_API_KEY` when no stored credential exists.

**Why:** The bot needs Discord-based key rotation without exposing credentials in
messages or logs, while existing deployments must continue working unchanged.

**How to apply:** Keep provider status and masked key metadata in the AI Core
config, never persist plaintext credentials, preserve the existing key on failed
replacement validation, and keep removal limited to provider credentials.