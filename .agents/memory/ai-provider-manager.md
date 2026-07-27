---
name: AI Provider Manager
description: Multi-provider AI Core architecture — adapters, registry, detection, and Discord setup flow.
---

# AI Provider Manager Architecture

## Provider adapter location
`src/features/aicore/providers/` — one file per provider + `registry.js`.

## Supported providers & key detection
- **OpenAI** (`openai.js`) — `sk-` prefix (must NOT match sk-ant- or sk-or-)
- **Google Gemini** (`gemini.js`) — `AIza` prefix; uses native fetch (no SDK)
- **Anthropic Claude** (`anthropic.js`) — `sk-ant-` prefix; uses native fetch
- **Groq** (`groq.js`) — `gsk_` prefix; OpenAI SDK with `baseURL: https://api.groq.com/openai/v1`
- **OpenRouter** (`openrouter.js`) — `sk-or-` prefix; OpenAI SDK with `baseURL: https://openrouter.ai/api/v1`

Detection order in registry matters: anthropic/gemini/groq/openrouter (specific prefixes) checked BEFORE openai (generic sk- fallback).

## Single runtime state (core.js)
`activeAdapter`, `activeClient`, `activeApiKey` — all rebuilt in `requestModel()` if key/provider changes.
All features (investigation, conversation, error analysis, fix gen) call through `requestModel()` — no separate clients.

## Flow: save key → detect → use
1. `updateProviderApiKey(key)` → format-check → `registry.detect(key)` → save → create client
2. Returns `detectionNeeded: true` if prefix unknown → setupInteraction shows provider-select buttons
3. `setActiveProvider(providerId)` for manual override; also auto-selects default model for new provider

## Vision handling per provider
- OpenAI/OpenRouter: `image_url` content parts passed as-is
- Gemini: converted to `inline_data` (base64)
- Anthropic: converted to `{type:"image", source:{type:"base64",...}}`
- Groq: image parts STRIPPED silently (most Groq models don't support vision)

## Why
**Why:** OpenAI SDK can't talk to Gemini/Anthropic endpoints; each provider has different auth headers, request/response shapes, and error formats. The adapter pattern keeps all provider-specific logic isolated without changing any downstream consumer.

**How to apply:** Any new provider = new file in providers/ implementing: `PROVIDER_ID`, `PROVIDER_NAME`, `DEFAULT_MODEL`, `MODELS`, `detectFromKey`, `validateKeyFormat`, `createClient`, `testConnection`, `chatCompletions`, `normalizeError`. Register in `registry.js` ALL_PROVIDERS array before the openai fallback.
