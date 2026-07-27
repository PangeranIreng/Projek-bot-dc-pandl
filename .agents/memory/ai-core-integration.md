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