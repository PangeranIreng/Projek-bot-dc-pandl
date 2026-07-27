/**
 * AI Core — multi-provider central intelligence service.
 *
 * Supports: OpenAI, Google Gemini, Anthropic Claude, Groq, OpenRouter.
 * The active provider is auto-detected from the API key prefix, or can be
 * set manually via the Discord setup panel.
 *
 * Advisory only: never edits source code or executes a generated fix.
 * All provider failures are isolated from the bot.
 */
import crypto from "node:crypto";
import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } from "discord.js";
import { aiCoreDB, encryptionSourceLabel } from "../../database/aiCoreDB.js";
import { rebuildProjectIndex, searchProject } from "./projectIndexer.js";
import { isOwner, isStaff } from "../../middleware/permissions.js";
import { logger } from "../../utils/logger.js";
import * as registry from "./providers/registry.js";

// ── Module-level runtime state ─────────────────────────────────────────────────
let client          = null;   // Discord client
let activeClient    = null;   // Provider SDK client / config object
let runtimeApiKey   = null;   // In-memory key (set after updateProviderApiKey)
let activeApiKey    = null;   // Key used to build the current activeClient
let activeAdapter   = null;   // Provider adapter module (from registry)
const recentRequests        = [];
const activeErrorAnalyses   = new Set();
const MAX_REQUESTS_PER_MINUTE   = 3;
let activeAIRequests            = 0;
const MAX_CONCURRENT_AI_REQUESTS = 2;

// ── Quota exhaustion guard ─────────────────────────────────────────────────────
// When a provider returns quota_exhausted/billing error, ALL subsequent
// requestModel() calls are rejected locally without touching the API.
// Cleared only when the user changes the provider or API key.
let providerQuotaExhausted    = false;
let quotaExhaustedProvider    = null;
let quotaExhaustedAt          = null;

// ── Utilities ──────────────────────────────────────────────────────────────────

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the Retry-After delay (ms) from a raw provider SDK error.
 * Must be called BEFORE safeProviderError() wraps the error.
 */
function extractRetryAfterMs(error) {
  try {
    if (!error?.headers) return null;
    const val = typeof error.headers.get === "function"
      ? error.headers.get("retry-after")
      : (error.headers["retry-after"] ?? error.headers["Retry-After"] ?? null);
    const secs = Number(val);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60_000);
  } catch { /* ignore */ }
  return null;
}

/** Redact API keys of any supported provider from log output / Discord messages. */
export function redact(value) {
  return String(value ?? "")
    // Anthropic
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, "sk-ant-************")
    // OpenRouter
    .replace(/\bsk-or-[A-Za-z0-9_-]{8,}\b/g, "sk-or-************")
    // Groq
    .replace(/\bgsk_[A-Za-z0-9_-]{8,}\b/g, "gsk_************")
    // Gemini
    .replace(/\bAIza[A-Za-z0-9_-]{8,}\b/g, "AIza************")
    // OpenAI (must come AFTER more-specific patterns above)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-************")
    // Env-var assignment patterns
    .replace(/\b(BOT_TOKEN|OPENAI_API_KEY|SESSION_SECRET|API_KEY)\s*=\s*[^\s]+/gi, "$1=************")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1************");
}

// ── Provider helpers ───────────────────────────────────────────────────────────

function config() {
  return aiCoreDB.getConfig();
}

function resolveAdapter() {
  const cfg = config();
  return registry.get(cfg.provider || "openai");
}

function getActiveApiKey() {
  if (runtimeApiKey) return runtimeApiKey;
  const cfg = aiCoreDB.getConfig();
  // A key marked "provider_selection_needed" was saved to DB but the provider
  // has not yet been confirmed. Block it from use — any request would route the
  // key to an unverified endpoint. The owner must call setActiveProvider() first.
  if (cfg.keyStatus === "provider_selection_needed") return null;
  // Prefer the encrypted key from secure storage.
  const stored = aiCoreDB.getApiKey();
  if (stored) return stored;
  // Legacy env-var fallback: OPENAI_API_KEY is only valid when the configured
  // provider is "openai". Never send an OpenAI key to Gemini/Anthropic/Groq/etc.
  const provider = cfg.provider || "openai";
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY?.trim() || null;
  }
  return null;
}

function providerLabel() {
  const adapter = activeAdapter ?? resolveAdapter();
  return adapter.PROVIDER_NAME;
}

function keyMask(apiKey) {
  if (!apiKey) return "Not configured";
  return `Configured ••••${apiKey.slice(-4)}`;
}

function keyDiagnostics(apiKey, extra = {}) {
  const value = String(apiKey || "");
  return {
    hasApiKey:     Boolean(value),
    keyLength:     value.length,
    maskedPrefix:  value ? value.slice(0, 4) : null,
    maskedSuffix:  value ? value.slice(-4)   : null,
    provider:      providerLabel(),
    model:         config().model,
    ...extra,
  };
}

function apiKeyHash(apiKey) {
  const value = String(apiKey || "");
  return value ? crypto.createHash("sha256").update(value, "utf8").digest("hex") : null;
}

function providerReady() {
  return Boolean(getActiveApiKey());
}

function logProviderDiagnostic(stage, apiKey, extra = {}) {
  if (process.env.AI_CORE_DIAGNOSTICS !== "true") return;
  logger.info(`[AI Core] ${stage}`, {
    ...keyDiagnostics(apiKey),
    apiKeySha256: apiKeyHash(apiKey),
    ...extra,
  });
}

// ── Error classification ───────────────────────────────────────────────────────

function providerErrorStatus(error) {
  return Number.isFinite(Number(error?.status)) ? Number(error.status) : null;
}

function providerErrorText(error) {
  // Support both SDK-style (.error object) and fetch-based error objects
  const detail = error?.error;
  if (typeof detail === "string") return detail.toLowerCase();
  if (detail && typeof detail === "object") {
    return [detail.message, detail.type, detail.code].filter(Boolean).join(" ").toLowerCase();
  }
  return String(error?.message || "").toLowerCase();
}

function providerErrorCategory(error, { modelRequest = false } = {}) {
  const status  = providerErrorStatus(error);
  const code    = String(error?.code || "").toLowerCase();
  const message = providerErrorText(error);
  if (code === "ai_key_format")  return "invalid_key_format";
  if (code === "ai_storage")     return "secure_storage";
  if (status === 401) return "authentication_401";
  if (status === 403) return "permission_403";
  if (status === 404) {
    return modelRequest && /model|not[_ -]?found|does not exist/.test(message)
      ? "model_404"
      : "endpoint_404";
  }
  if (status === 429) {
    // Distinguish temporary rate limit from permanent quota/billing exhaustion.
    if (/quota|exceeded|insufficient_quota|billing|credit|payment|balance|debit/i.test(message)) {
      return "quota_exhausted";
    }
    return "rate_limit_429";
  }
  if (status === 400) return "invalid_request_400";
  if (status >= 500)  return `provider_${status}`;
  if (error?.name === "AbortError" || code.includes("timeout") || message.includes("timeout")) return "timeout";
  if (/network|fetch|econn|socket|dns|connection error/.test(message)) return "network";
  return "unknown";
}

function classifyProviderError(error, { modelRequest = false } = {}) {
  const status  = providerErrorStatus(error);
  const code    = String(error?.code || "").toLowerCase();
  const message = providerErrorText(error);
  if (code === "ai_key_format") return "API key format is invalid.";
  if (code === "ai_storage")    return "Secure credential storage failed.";
  if (status === 401 || /authentication failed|invalid api key|incorrect api key|unauthorized/.test(message)) {
    return `Provider authentication failed${status ? ` (HTTP ${status})` : ""}.`;
  }
  if (status === 403 || /permission|forbidden/.test(message)) {
    return `Provider permission denied${status ? ` (HTTP ${status})` : ""}.`;
  }
  if (status === 404 && modelRequest && /model|not[_ -]?found|does not exist/.test(message)) {
    return "The selected model is unavailable (HTTP 404).";
  }
  if (status === 404) return "The provider endpoint was not found (HTTP 404).";
  if (status === 429 || code.includes("rate") || /rate limit|quota|too many request/.test(message)) {
    const isQuotaExhausted = /quota|exceeded|insufficient_quota|billing|credit|payment|balance|debit/i.test(message);
    if (isQuotaExhausted) {
      return `Provider quota habis atau ada masalah billing${status ? ` (HTTP ${status})` : ""}. Periksa saldo/billing di dashboard provider.`;
    }
    return `Provider rate limit reached${status ? ` (HTTP ${status})` : ""}. Coba lagi dalam beberapa saat.`;
  }
  if (status === 400) return "Provider rejected the request format (HTTP 400).";
  if (status >= 500)  return `Provider service error (HTTP ${status}).`;
  if (error?.name === "AbortError" || code.includes("timeout") || message.includes("timeout")) {
    return "Provider request timed out.";
  }
  if (/network|fetch|econn|socket|dns|connection error/.test(message)) {
    return "Provider network request failed.";
  }
  if (status) return `Provider request failed (HTTP ${status}).`;
  if (/model|not_found/.test(message)) return "The selected model is unavailable.";
  return "Provider connection failed.";
}

function classifyProviderStatus(error, { modelRequest = false } = {}) {
  const category = providerErrorCategory(error, { modelRequest });
  if (category === "model_404")                   return "model_error";
  if (category === "timeout" || category === "network") return "network_error";
  return "provider_error";
}

function safeProviderError(error, options = {}) {
  const safe = new Error(classifyProviderError(error, options));
  safe.providerStatus   = classifyProviderStatus(error, options);
  safe.providerCategory = providerErrorCategory(error, options);
  safe.httpStatus       = providerErrorStatus(error);
  safe.providerReason   = safe.message;
  return safe;
}

// ── Lazy dynamic import (avoids circular dependency with errorLogger) ──────────

async function logAICoreError(payload) {
  try {
    const { logError } = await import("../../utils/errorLogger.js");
    void logError(payload).catch(() => {});
  } catch (_) { /* never let error-reporting crash the caller */ }
}

// ── Access control ─────────────────────────────────────────────────────────────

function canUseAI(member) {
  const cfg = config();
  if (!member) return false;
  if (cfg.accessMode === "staff" || cfg.accessMode === "admin") return isStaff(member);
  if (cfg.accessMode === "role")  return cfg.allowedRoleIds.some((id) => member.roles?.cache?.has(id));
  if (cfg.accessMode === "user")  return cfg.allowedUserIds.includes(member.id);
  return isOwner(member);
}

export function isAICoreAllowed(member) {
  return canUseAI(member);
}

// ── Quota exhaustion status ────────────────────────────────────────────────────

export function isProviderQuotaExhausted() {
  return providerQuotaExhausted;
}

export function getQuotaExhaustedInfo() {
  return {
    exhausted: providerQuotaExhausted,
    provider:  quotaExhaustedProvider,
    since:     quotaExhaustedAt,
  };
}

/** Called internally whenever provider/key changes to clear the block. */
function _clearQuotaExhausted() {
  providerQuotaExhausted = false;
  quotaExhaustedProvider = null;
  quotaExhaustedAt       = null;
}

/** Manual reset — exposed so setupInteraction can offer a "clear quota" button. */
export function resetQuotaExhaustedStatus() {
  _clearQuotaExhausted();
  logger.info("[AI Core] Quota exhausted status cleared manually.");
}

// ── Rate limiting ──────────────────────────────────────────────────────────────

function withinRateLimit() {
  const now = Date.now();
  while (recentRequests[0] && now - recentRequests[0] > 60_000) recentRequests.shift();
  if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) return false;
  recentRequests.push(now);
  return true;
}

// ── Error fingerprinting ───────────────────────────────────────────────────────

function fingerprint(payload) {
  const source = [
    payload.feature, payload.module, payload.function, payload.stage,
    payload.reason, payload.action, payload.errorCategory,
  ].map((part) => String(part ?? "").trim().toLowerCase()).join("|");
  return crypto.createHash("sha256").update(source).digest("hex");
}

function makeErrorId(payload, hash) {
  const feature = String(payload.feature || "SYSTEM").replace(/[^a-z0-9]/gi, "-").toUpperCase().slice(0, 16);
  return `ERR-${feature}-${hash.slice(0, 4).toUpperCase()}`;
}

// ── Initialisation ─────────────────────────────────────────────────────────────

export function initAICore(discordClient) {
  client = discordClient;
  try {
    logger.info(`[AI Core] Encryption source: ${encryptionSourceLabel()}`);
  } catch (encErr) {
    logger.warn(`[AI Core] Encryption unavailable at startup: ${encErr.message}`);
  }

  const storedKey = getActiveApiKey();
  if (storedKey) {
    const cfg     = config();
    activeAdapter = registry.get(cfg.provider || "openai");
    try {
      activeClient = activeAdapter.createClient(storedKey, Number(cfg.timeoutMs) || 30_000);
      activeApiKey = storedKey;
      logger.info(`[AI Core] [KEY_STORED_NOT_TESTED] API key found; provider: ${activeAdapter.PROVIDER_NAME}; connection not yet verified.`);
    } catch (initErr) {
      logger.warn(`[AI Core] Client init failed at startup: ${initErr.message}`);
      activeClient = null;
      activeApiKey = null;
    }
  } else {
    logger.info("[AI Core] [NO_KEY_STORED] No API key configured.");
    activeClient = null;
    activeApiKey = null;
    activeAdapter = registry.get("openai");
  }

  const knowledge = aiCoreDB.getKnowledge();
  if (!knowledge.builtAt || !knowledge.files.length) {
    try {
      rebuildProjectIndex();
      logger.info("[AI Core] Project knowledge index ready");
    } catch (err) {
      logger.warn(`[AI Core] Project index failed (non-fatal): ${err.message}`);
    }
  }
}

// ── Status / config accessors ──────────────────────────────────────────────────

export function getAICoreStatus() {
  const cfg        = config();
  const storedKey  = getActiveApiKey();
  const hasKey     = Boolean(storedKey);
  const rawStatus  = cfg.keyStatus || "no_key_stored";
  const keyStatus  = hasKey && rawStatus === "no_key_stored" ? "key_stored_not_tested" : rawStatus;
  const connStatus = hasKey ? (cfg.providerStatus || "not_tested") : "not_configured";
  return {
    online:             Boolean(client),
    providerReady:      providerReady(),
    keyStatus,
    providerStatus:     connStatus,
    providerStatusReason: hasKey ? (cfg.providerStatusReason || null) : null,
    providerKeyMask:    keyMask(storedKey),
    providerSource:     runtimeApiKey ? "runtime"
                        : aiCoreDB.hasStoredApiKey() ? "secure_storage"
                        : storedKey ? "environment"
                        : "none",
    knowledgeReady:     Boolean(aiCoreDB.getKnowledge().builtAt && aiCoreDB.getKnowledge().files.length),
    fileCount:          aiCoreDB.getKnowledge().summary?.fileCount ?? aiCoreDB.getKnowledge().files.length,
    errorChannelId:     cfg.errorChannelId,
    investigationChannelId: cfg.investigationChannelId,
    accessMode:         cfg.accessMode,
    model:              cfg.model,
    provider:           cfg.provider,
  };
}

export function getAICoreConfig() {
  return config();
}

export function updateAICoreConfig(patch) {
  const allowed = [
    "errorChannelId", "investigationChannelId", "conversationChannelId",
    "accessMode", "allowedRoleIds", "allowedUserIds", "provider", "model",
    "timeoutMs", "maxResponse",
    "errorAnalysis", "investigation", "codeAnalysis", "visionAnalysis", "conversation",
  ];
  const safe = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
  return aiCoreDB.updateConfig(safe);
}

export function getProviderConfiguration() {
  const cfg       = config();
  const storedKey = getActiveApiKey();
  const hasKey    = Boolean(storedKey);
  const rawStatus = cfg.keyStatus || "no_key_stored";
  const keyStatus = hasKey && rawStatus === "no_key_stored" ? "key_stored_not_tested" : rawStatus;
  const connStatus = hasKey ? (cfg.providerStatus || "not_tested") : "not_configured";
  const adapter   = registry.get(cfg.provider || "openai");
  return {
    provider:         adapter.PROVIDER_NAME,
    providerId:       adapter.PROVIDER_ID,
    model:            cfg.model,
    defaultModel:     adapter.DEFAULT_MODEL,
    models:           adapter.MODELS,
    apiKeyConfigured: hasKey,
    apiKeyMask:       keyMask(storedKey),
    keyStatus,
    source:           runtimeApiKey ? "runtime"
                      : aiCoreDB.hasStoredApiKey() ? "secure_storage"
                      : storedKey ? "environment"
                      : "none",
    status:           connStatus,
    statusReason:     hasKey ? (cfg.providerStatusReason || null) : null,
    checkedAt:        cfg.providerCheckedAt || null,
    errorAnalysis:    cfg.errorAnalysis,
    investigation:    cfg.investigation,
    codeAnalysis:     cfg.codeAnalysis,
    visionAnalysis:   cfg.visionAnalysis,
  };
}

// ── API key management ─────────────────────────────────────────────────────────

function validateApiKeyFormat(apiKey) {
  const value = String(apiKey || "").trim();
  if (!value || value.length < 20 || /\s/.test(value)) {
    const error = new Error("API key format is invalid (too short or contains whitespace).");
    error.code = "AI_KEY_FORMAT";
    throw error;
  }
  return value;
}

/**
 * Save a new API key.
 *
 * Steps:
 *  1. Basic format sanity check
 *  2. Auto-detect provider from key prefix
 *  3. Provider-specific format validation (if provider detected)
 *  4. Persist key to secure storage
 *  5. Instantiate the provider client
 *
 * Returns the new provider configuration.
 * If the provider could not be auto-detected, returns detectionNeeded: true —
 * the caller (setupInteraction) should prompt the user to select a provider.
 */
export async function updateProviderApiKey(apiKey) {
  const previousConfig = aiCoreDB.getConfig();
  try {
    const value = validateApiKeyFormat(apiKey);

    // Auto-detect provider
    const detected = registry.detect(value);

    // If detected, run provider-specific key-format validation for better error messages
    if (detected) {
      try {
        detected.validateKeyFormat(value);
      } catch (fmtErr) {
        fmtErr.code = fmtErr.code || "AI_KEY_FORMAT";
        throw fmtErr;
      }
    }

    // Persist key
    aiCoreDB.saveApiKey(value);
    if (!aiCoreDB.hasStoredApiKey() || aiCoreDB.getApiKey() !== value) {
      const storageError = new Error("Secure credential storage failed.");
      storageError.code = "AI_STORAGE";
      throw storageError;
    }

    if (detected === null) {
      // Provider could not be auto-detected from the key prefix.
      // IMPORTANT: Do NOT set runtimeApiKey, activeClient, activeAdapter, or
      // activeApiKey here. Applying an unknown key to the existing provider's
      // endpoint would route it to the wrong service.
      // Mark the key as pending until the owner explicitly chooses a provider.
      aiCoreDB.updateConfig({
        // Do NOT change config.provider — leave it as-is to avoid confusion
        keyStatus:          "provider_selection_needed",
        providerStatus:     "not_configured",
        providerStatusReason: "Provider harus dipilih sebelum key dapat digunakan.",
        providerCheckedAt:  new Date().toISOString(),
      });
      logger.info("[AI Core] [KEY_STORED] API key saved but provider unknown — owner must select provider.");
      const result = getProviderConfiguration();
      result.detectionNeeded    = true;
      result.detectedProviderId = null;
      return result;
    }

    // Provider detected — apply key and client to runtime
    // Clear any existing quota-exhausted block: new key = fresh start.
    _clearQuotaExhausted();
    runtimeApiKey = value;
    activeAdapter = detected;
    activeClient  = detected.createClient(value, Number(config().timeoutMs) || 30_000);
    activeApiKey  = value;

    const cfg = config();
    // Switch to the new provider's default model if the current model is not
    // compatible with the new provider (avoids sending gpt-4-turbo to Gemini, etc.)
    const keepModel = detected.isCompatibleModel(cfg.model || "");
    aiCoreDB.updateConfig({
      provider:             detected.PROVIDER_ID,
      model:                keepModel ? cfg.model : detected.DEFAULT_MODEL,
      keyStatus:            "key_stored_not_tested",
      providerStatus:       "not_tested",
      providerStatusReason: null,
      providerCheckedAt:    new Date().toISOString(),
    });

    logger.info(`[AI Core] [KEY_STORED_NOT_TESTED] API key saved; provider: ${detected.PROVIDER_NAME}; use Test Connection to verify.`);

    const result = getProviderConfiguration();
    result.detectionNeeded    = false;
    result.detectedProviderId = detected.PROVIDER_ID;
    return result;

  } catch (error) {
    // Restore previous config — never lose an existing valid key because a new one fails
    try {
      aiCoreDB.updateConfig({
        keyStatus:          previousConfig.keyStatus  || (aiCoreDB.hasStoredApiKey() ? "key_stored_not_tested" : "no_key_stored"),
        providerStatus:     previousConfig.providerStatus,
        providerStatusReason: previousConfig.providerStatusReason,
        providerCheckedAt:  previousConfig.providerCheckedAt,
      });
    } catch (_) { /* ignore config-restore failure */ }

    const code = String(error?.code || "").toLowerCase();
    if (code === "ai_key_format") {
      error.providerCategory = "invalid_key_format";
      error.providerStatus   = "not_configured";
      error.providerReason   = error.message;
      throw error;
    }
    const msg = code === "ai_storage"
      ? (error.message || "Secure credential storage failed.")
      : `Key storage failed: ${String(error?.message || "Unknown error.").slice(0, 180)}`;
    const safe = new Error(msg);
    safe.providerCategory = "secure_storage";
    safe.providerStatus   = "not_configured";
    safe.providerReason   = msg;
    logger.warn(`[AI Core] [KEY_SAVE_FAILED] (${code || "unknown"}): ${redact(msg)}`);
    void logAICoreError({
      feature:    "AI Core — Secure Storage",
      stage:      "api_key_save",
      reason:     redact(msg),
      errorCategory: "secure_storage",
      suggestion: "Set AI_CORE_ENCRYPTION_KEY or SESSION_SECRET in environment variables.",
    });
    throw safe;
  }
}

/**
 * Override the active provider for an already-saved key (called when user
 * selects provider manually after auto-detection fails).
 */
export function setActiveProvider(providerId) {
  const adapter = registry.get(providerId);
  const cfg     = config();

  // Prefer the key that was stored in DB — this is the correct path when the
  // key was saved in the "provider_selection_needed" state (detection failed).
  // Fall back to runtimeApiKey only if no DB key is present.
  const dbKey   = aiCoreDB.getApiKey();
  const keyToUse = dbKey || runtimeApiKey;

  // Changing the active provider always clears quota exhaustion — the new
  // provider/key has its own quota budget.
  _clearQuotaExhausted();

  if (keyToUse) {
    try {
      activeAdapter = adapter;
      activeClient  = adapter.createClient(keyToUse, Number(cfg.timeoutMs) || 30_000);
      activeApiKey  = keyToUse;
      runtimeApiKey = keyToUse; // promote the pending DB key to runtime
    } catch (err) {
      logger.warn(`[AI Core] setActiveProvider client init failed: ${err.message}`);
      activeAdapter = adapter;  // still update adapter for display
      activeClient  = null;
      activeApiKey  = null;
    }
  } else {
    activeAdapter = adapter;
  }

  // Switch to the new provider's default model when the current model is not
  // compatible with the new provider (e.g. "gpt-4-turbo" → Gemini switch)
  const currentModel   = cfg.model || "";
  const newModel       = adapter.isCompatibleModel(currentModel) ? currentModel : adapter.DEFAULT_MODEL;

  aiCoreDB.updateConfig({
    provider:             adapter.PROVIDER_ID,
    model:                newModel,
    keyStatus:            keyToUse ? "key_stored_not_tested" : "no_key_stored",
    providerStatus:       keyToUse ? "not_tested" : "not_configured",
    providerStatusReason: null,
    providerCheckedAt:    new Date().toISOString(),
  });

  logger.info(`[AI Core] Provider manually set to: ${adapter.PROVIDER_NAME} (model: ${newModel})`);
  return getProviderConfiguration();
}

export function removeProviderApiKey() {
  // Key removal always clears quota — no key means no quota to exhaust.
  _clearQuotaExhausted();
  runtimeApiKey = null;
  activeClient  = null;
  activeApiKey  = null;
  activeAdapter = registry.get("openai"); // reset to default for display
  aiCoreDB.removeApiKey();
  const envKeyPresent = Boolean(process.env.OPENAI_API_KEY?.trim());
  logger.info(envKeyPresent
    ? "[AI Core] [KEY_STORED_NOT_TESTED] Stored key removed; env key still present."
    : "[AI Core] [NO_KEY_STORED] API key removed from secure storage.");
  aiCoreDB.updateConfig({
    keyStatus:          envKeyPresent ? "key_stored_not_tested" : "no_key_stored",
    providerStatus:     envKeyPresent ? "not_tested" : "not_configured",
    providerStatusReason: null,
    providerCheckedAt:  null,
  });
  return getProviderConfiguration();
}

// ── Provider connection test ───────────────────────────────────────────────────

async function buildCheckedClient(apiKey) {
  const cfg     = config();
  const adapter = registry.get(cfg.provider || "openai");
  const c       = adapter.createClient(apiKey, Number(cfg.timeoutMs) || 30_000);
  logProviderDiagnostic("Provider request started", apiKey, {
    provider: adapter.PROVIDER_NAME,
    clientInitialized: true,
    requestStarted: true,
  });
  try {
    await adapter.testConnection(c);
    logProviderDiagnostic("Provider request completed", apiKey, {
      provider: adapter.PROVIDER_NAME,
      httpStatus: 200,
    });
    return { adapter, c };
  } catch (error) {
    logProviderDiagnostic("Provider request failed", apiKey, {
      provider:             adapter.PROVIDER_NAME,
      httpStatus:           providerErrorStatus(error),
      providerErrorCategory: providerErrorCategory(error),
    });
    throw error;
  }
}

export async function testProviderConnection() {
  const apiKey = getActiveApiKey();
  if (!apiKey) {
    aiCoreDB.updateConfig({ keyStatus: "no_key_stored", providerStatus: "not_configured", providerStatusReason: null });
    return { ok: false, reason: "No AI provider API key is configured.", configuration: getProviderConfiguration() };
  }
  logger.info(`[AI Core] [KEY_STORED_NOT_TESTED] Testing provider connection (${providerLabel()})…`);
  try {
    aiCoreDB.updateConfig({ providerStatus: "validating", providerStatusReason: null, providerCheckedAt: new Date().toISOString() });
    const { adapter, c } = await buildCheckedClient(apiKey);
    activeAdapter = adapter;
    activeClient  = c;
    activeApiKey  = apiKey;
    logger.info(`[AI Core] [PROVIDER_CONNECTED] ${adapter.PROVIDER_NAME} connection test successful.`);
    aiCoreDB.updateConfig({
      keyStatus:          "key_configured",
      providerStatus:     "connected",
      providerStatusReason: null,
      providerCheckedAt:  new Date().toISOString(),
    });
    return { ok: true, reason: null, configuration: getProviderConfiguration() };
  } catch (error) {
    const safe     = safeProviderError(error);
    const category = safe.providerCategory;
    let keyStatus  = "key_stored_not_tested";
    if (category === "authentication_401" || category === "permission_403") {
      keyStatus = "authentication_failed";
      logger.info(`[AI Core] [AUTHENTICATION_FAILED] ${safe.providerReason}`);
    } else if (category === "model_404") {
      keyStatus = "model_not_found";
      logger.info(`[AI Core] [MODEL_NOT_FOUND] ${safe.providerReason}`);
    } else if (category === "quota_exhausted") {
      // Mark quota as exhausted — no further requests will be sent to this provider.
      providerQuotaExhausted = true;
      quotaExhaustedProvider = providerLabel();
      quotaExhaustedAt       = new Date().toISOString();
      logger.warn(`[AI Core] [QUOTA_EXHAUSTED] ${safe.providerReason} — blocking all future requests to ${quotaExhaustedProvider}`);
    } else {
      logger.info(`[AI Core] [PROVIDER_ERROR] ${safe.providerReason}`);
    }
    aiCoreDB.updateConfig({
      keyStatus,
      providerStatus:     safe.providerStatus,
      providerStatusReason: safe.providerReason,
      providerCheckedAt:  new Date().toISOString(),
    });
    void logAICoreError({
      feature:       "AI Core — Provider",
      stage:         "provider_connection",
      reason:        safe.providerReason,
      errorCategory: category,
      provider:      providerLabel(),
      activeProvider: providerLabel(),
      status:        safe.httpStatus ? String(safe.httpStatus) : undefined,
      retry:         false,
    });
    return { ok: false, reason: safe.providerReason, configuration: getProviderConfiguration() };
  }
}

export async function validateProviderModel(model) {
  const name = String(model || "").trim().slice(0, 80);
  if (!name) throw new Error("Model is required.");

  // Do not make any API calls if quota is exhausted.
  if (providerQuotaExhausted) {
    const err = new Error(
      `Provider quota habis (${quotaExhaustedProvider ?? "unknown"}). ` +
      "Tidak ada validasi yang akan dilakukan. Ganti provider atau API key terlebih dahulu."
    );
    err.providerCategory = "quota_exhausted";
    err.providerStatus   = "provider_error";
    err.providerReason   = err.message;
    err.retry            = false;
    throw err;
  }

  const apiKey = getActiveApiKey();
  if (!apiKey) throw new Error("No AI provider API key is configured.");

  const cfg     = config();
  const adapter = registry.get(cfg.provider || "openai");

  // Step 1 — verify provider connectivity
  let providerClient;
  try {
    const { c } = await buildCheckedClient(apiKey);
    providerClient = c;
  } catch (error) {
    const safe = safeProviderError(error);
    aiCoreDB.updateConfig({
      providerStatus:       safe.providerStatus,
      providerStatusReason: safe.providerReason,
      providerCheckedAt:    new Date().toISOString(),
    });
    throw safe;
  }

  // Step 2 — validate the specific model identifier via the adapter
  if (typeof adapter.validateModel === "function") {
    try {
      await adapter.validateModel(providerClient, name);
    } catch (error) {
      const safe = safeProviderError(error, { modelRequest: true });
      aiCoreDB.updateConfig({
        providerStatus:       safe.providerStatus,
        providerStatusReason: safe.providerReason,
        providerCheckedAt:    new Date().toISOString(),
      });
      throw safe;
    }
  }
  // If the adapter has no validateModel (shouldn't happen given all five define it),
  // connectivity success is accepted as sufficient.
  return true;
}

export function rebuildKnowledge() {
  return rebuildProjectIndex();
}

// ── Core request engine ────────────────────────────────────────────────────────

/**
 * Send a request to the active provider.
 * All features (investigation, conversation, error analysis, fix gen) must
 * go through this single function — never build a separate provider client.
 */
async function requestModel(messages, maxTokens = config().maxResponse) {
  // ── Global quota guard — reject immediately without touching the API ──────
  if (providerQuotaExhausted) {
    const blocked = new Error(
      `Provider quota habis (${quotaExhaustedProvider ?? "unknown"}). ` +
      "Tidak ada request yang akan dikirim sampai provider atau API key diganti."
    );
    blocked.providerCategory = "quota_exhausted";
    blocked.providerStatus   = "provider_error";
    blocked.providerReason   = blocked.message;
    blocked.retry            = false;
    throw blocked;
  }

  const apiKey = getActiveApiKey();
  if (!apiKey) throw new Error("AI provider is not configured");

  if (activeAIRequests >= MAX_CONCURRENT_AI_REQUESTS) {
    const busy = new Error("AI Core is processing another request. Please wait a moment.");
    busy.providerCategory = "concurrent_limit";
    busy.providerStatus   = "provider_error";
    busy.providerReason   = busy.message;
    throw busy;
  }

  if (!withinRateLimit()) throw new Error("AI rate limit reached; try again shortly");

  const cfg = config();

  // Re-build client if key or provider changed
  if (!activeClient || activeApiKey !== apiKey) {
    activeAdapter = registry.get(cfg.provider || "openai");
    activeClient  = activeAdapter.createClient(apiKey, Number(cfg.timeoutMs) || 30_000);
    activeApiKey  = apiKey;
  }

  const model     = cfg.model || activeAdapter.DEFAULT_MODEL;
  const timeoutMs = Math.max(5000, Number(cfg.timeoutMs) || 30_000);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  logProviderDiagnostic("Model request prepared", apiKey, {
    provider: activeAdapter.PROVIDER_NAME,
    model,
    activeAIRequests,
  });

  activeAIRequests++;
  try {
    const text = await activeAdapter.chatCompletions(
      activeClient,
      model,
      messages,
      Math.min(4000, Math.max(300, Number(maxTokens) || 1800)),
      controller.signal,
    );
    aiCoreDB.incrementStat("aiRequests");
    aiCoreDB.updateConfig({
      providerStatus:     "connected",
      providerStatusReason: null,
      providerCheckedAt:  new Date().toISOString(),
    });
    return text || "AI provider returned an empty response.";
  } catch (err) {
    const retryAfterMs = extractRetryAfterMs(err);
    const safe = safeProviderError(err, { modelRequest: true });
    if (retryAfterMs) safe.retryAfterMs = retryAfterMs;
    aiCoreDB.incrementStat("failedRequests");
    aiCoreDB.updateConfig({
      providerStatus:     safe.providerStatus,
      providerStatusReason: safe.providerReason,
      providerCheckedAt:  new Date().toISOString(),
    });

    // ── Permanent quota exhaustion: block all future requests immediately ──
    if (safe.providerCategory === "quota_exhausted") {
      providerQuotaExhausted = true;
      quotaExhaustedProvider = (activeAdapter ?? resolveAdapter()).PROVIDER_NAME;
      quotaExhaustedAt       = new Date().toISOString();
      safe.retry             = false;
      logger.warn(
        `[AI Core] [QUOTA_EXHAUSTED] Provider=${quotaExhaustedProvider} ` +
        `— all future requests BLOCKED until provider/key changes.`
      );
    }

    throw safe;
  } finally {
    activeAIRequests--;
    clearTimeout(timeoutHandle);
  }
}

// ── Project context ────────────────────────────────────────────────────────────

function relevantContext(query) {
  const matches = searchProject(query, 8);
  return matches.map((item) =>
    `FILE: ${item.path}\nFUNCTIONS: ${item.functions.join(", ") || "none"}\nEXCERPT:\n${item.excerpt}`
  ).join("\n\n---\n\n").slice(0, 28_000);
}

function fallbackErrorAnalysis(record) {
  const related = searchProject(`${record.feature} ${record.module} ${record.function} ${record.reason}`, 5);
  const paths = related.map((item) => `\`${item.path}\``).join(", ") || "Tidak ditemukan secara pasti dari project index.";
  return [
    `📌 Masalah: Error ${record.errorId} terjadi pada feature **${record.feature || "Unknown"}**.`,
    `🔍 Kemungkinan penyebab: ${record.reason || "Pesan error tidak tersedia"}. Penyebab akar belum dapat dipastikan tanpa provider AI.`,
    `📁 File terkait: ${paths}`,
    "⚠️ Tingkat kepastian: Rendah — ini adalah ringkasan berbasis metadata lokal, bukan diagnosis final.",
    "🛠️ Solusi: Periksa stack trace dan file terkait; konfigurasi provider AI untuk analisis mendalam.",
  ].join("\n");
}

// ── Error analysis ─────────────────────────────────────────────────────────────

async function analyzeError(record) {
  const cfg = config();
  if (!cfg.errorAnalysis || !cfg.errorChannelId || activeErrorAnalyses.has(record.errorId)) return;

  // When provider quota is exhausted, skip AI call and use local fallback immediately.
  // This prevents a cascade of API calls that would all fail with 429.
  if (providerQuotaExhausted) {
    logger.debug(`[AI Core] analyzeError(${record.errorId}): quota exhausted — using local fallback.`);
    const fallback = fallbackErrorAnalysis(record);
    const updated  = aiCoreDB.updateError(record.errorId, { analysis: fallback, status: "fix_suggested" }) || record;
    void sendErrorAnalysis(updated);
    return;
  }

  activeErrorAnalyses.add(record.errorId);
  try {
    const context = relevantContext(`${record.feature} ${record.module} ${record.function} ${record.reason}`);
    const prompt  = [
      "You are the central diagnostic intelligence for an existing Discord bot.",
      "Analyze only the supplied error and project excerpts. Never invent files, functions, causes, or certainty.",
      "Clearly label hypotheses as possible/suspected and distinguish facts from hypotheses.",
      "Return concise Indonesian Markdown with sections: Masalah, Kemungkinan penyebab, File terkait, Solusi, Severity, Confidence, Testing.",
      `ERROR RECORD:\n${JSON.stringify({ ...record, stack: redact(record.stack) }, null, 2)}`,
      `PROJECT EXCERPTS:\n${context || "No matching project excerpt was found."}`,
    ].join("\n\n");
    const analysis = providerReady()
      ? await requestModel([{ role: "system", content: "You are a careful software diagnostician." }, { role: "user", content: prompt }])
      : fallbackErrorAnalysis(record);
    const updated = aiCoreDB.updateError(record.errorId, { analysis: redact(analysis), status: "fix_suggested" }) || record;
    await sendErrorAnalysis(updated);
  } catch (err) {
    // If the analysis itself failed with quota_exhausted, fall back to local analysis
    // so the error record is still useful, and DON'T log this back through errorLogger
    // (that would create an AI→error→AI→error loop).
    if (err?.providerCategory === "quota_exhausted") {
      logger.warn(`[AI Core] analyzeError(${record.errorId}): quota exhausted during analysis — falling back to local.`);
      const fallback = fallbackErrorAnalysis(record);
      const updated  = aiCoreDB.updateError(record.errorId, { analysis: fallback, status: "fix_suggested" }) || record;
      void sendErrorAnalysis(updated);
    } else {
      logger.warn(`[AI Core] Error analysis skipped: ${redact(err.message)}`);
    }
  } finally {
    activeErrorAnalyses.delete(record.errorId);
  }
}

async function sendErrorAnalysis(record) {
  if (!client) return;
  const channel = await client.channels.fetch(config().errorChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const label = record.occurrences > 1
    ? (record.occurrences >= 5 ? "⚠️ RECURRING" : "🔁 REPEATED")
    : "🆕 NEW";
  const embed = new EmbedBuilder()
    .setColor(record.occurrences >= 5 ? 0xed4245 : 0x5865f2)
    .setTitle(`🤖 AI CORE ANALYSIS • ${label}`)
    .setDescription(truncate(record.analysis || fallbackErrorAnalysis(record), 3900))
    .addFields(
      { name: "Error ID",    value: `\`${record.errorId}\``,               inline: true },
      { name: "Feature",     value: truncate(record.feature || "Unknown", 100), inline: true },
      { name: "Occurrences", value: String(record.occurrences || 1),        inline: true },
    )
    .setTimestamp(new Date(record.timestamp));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`aicore:fix:${record.errorId}`).setLabel("🛠️ Generate Fix Prompt").setStyle(ButtonStyle.Primary),
  );
  await channel.send({ embeds: [embed], components: [row] }).catch((err) =>
    logger.warn(`[AI Core] Could not post analysis: ${err.message}`)
  );
}

export async function recordError(payload = {}) {
  if (String(payload.feature || "").toLowerCase().includes("ai core")) return null;
  const hash    = fingerprint(payload);
  const existing = aiCoreDB.findError(hash);
  if (existing) {
    const updated = aiCoreDB.updateError(existing.errorId, {
      occurrences: (existing.occurrences || 1) + 1,
      lastSeen: new Date().toISOString(),
      status: (existing.occurrences || 1) >= 4 ? "recurring" : "repeated",
    });
    if (updated && (updated.occurrences === 2 || updated.occurrences === 5)) {
      void sendErrorAnalysis(updated);
    }
    return updated;
  }
  const error  = payload.error;
  const record = {
    errorId:     makeErrorId(payload, hash),
    fingerprint: hash,
    feature:     redact(payload.feature || "Unknown"),
    module:      redact(payload.module  || ""),
    function:    redact(payload.function || ""),
    platform:    redact(payload.platform || payload.provider || ""),
    action:      redact(payload.action  || ""),
    stage:       redact(payload.stage   || ""),
    reason:      redact(payload.reason  || error?.message || "Unknown error"),
    stack:       redact(error?.stack    || ""),
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    metadata:    redact(JSON.stringify(payload.metadata ?? {})).slice(0, 3000),
    occurrences: 1,
    lastSeen:    new Date().toISOString(),
    status:      "open",
    analysis:    null,
  };
  aiCoreDB.addError(record);
  void analyzeError(record);
  return record;
}

// ── Investigation & conversation (exported to conversation.js / events) ────────

export async function investigate({ query, image }) {
  const cfg     = config();
  const adapter = activeAdapter ?? resolveAdapter();
  const context = cfg.codeAnalysis ? relevantContext(query) : "";

  // Check vision support — if provider doesn't support vision, strip the image
  // and prepend a clear warning so the user knows their image was not analyzed.
  let effectiveImage = image;
  let visionNote = "";
  if (image && adapter.SUPPORTS_VISION === false) {
    effectiveImage = null;
    visionNote = `\n\n⚠️ **Vision tidak didukung oleh ${adapter.PROVIDER_NAME}.** Gambar tidak dapat dianalisis. Ganti provider ke OpenAI / Google Gemini / Anthropic untuk mengaktifkan vision analysis.`;
  }

  const messages = [
    {
      role:    "system",
      content: "Anda adalah AI Core untuk developer. Jawab dalam bahasa Indonesia. Gunakan hanya fakta dari project excerpts. Jangan mengarang path/function. Tandai dugaan sebagai kemungkinan. Jangan mengubah source code.",
    },
    {
      role:    "user",
      content: [
        { type: "text", text: `PERTANYAAN:\n${redact(query)}\n\nPROJECT EXCERPTS:\n${context || "Tidak ada excerpt yang cocok."}` },
        ...(effectiveImage ? [{ type: "image_url", image_url: { url: effectiveImage } }] : []),
      ],
    },
  ];
  if (!providerReady()) {
    return `🤖 AI CORE (mode lokal)\n\n${fallbackErrorAnalysis({
      errorId: "INVESTIGATION",
      feature: "Project Investigation",
      reason:  `Pertanyaan: ${query}`,
    })}${visionNote}`;
  }
  return redact(await requestModel(messages)) + visionNote;
}

export async function generateFixPrompt(errorId) {
  const record = aiCoreDB.getError(errorId);
  if (!record) return "Error record tidak ditemukan atau sudah dihapus.";
  const context = relevantContext(`${record.feature} ${record.module} ${record.function} ${record.reason}`);
  if (!providerReady()) {
    return [
      "FIX REQUEST",
      `Error ID: ${record.errorId}`,
      `Masalah: ${record.reason}`,
      `File yang ditemukan: ${searchProject(`${record.feature} ${record.reason}`, 5).map((item) => item.path).join(", ") || "Tidak ditemukan secara pasti."}`,
      "Jangan mengubah fitur lain. Jangan mengarang file/function.",
      "Testing: reproduksi error, uji jalur sukses, restart bot, dan pastikan fitur lama tetap berjalan.",
    ].join("\n");
  }
  const prompt = await requestModel([
    { role: "system", content: "Buat FIX REQUEST yang aman untuk developer/Replit. Jangan mengusulkan file/function yang tidak ada di excerpts. Jangan minta auto-apply. Sertakan masalah, bukti, penyebab yang dibedakan dari dugaan, perubahan minimal, hal yang tidak boleh diubah, dan testing." },
    { role: "user",   content: `ERROR:\n${JSON.stringify(record, null, 2)}\n\nPROJECT EXCERPTS:\n${context}` },
  ], 2200);
  return redact(prompt);
}

async function attachmentAsDataUrl(attachment) {
  if (!attachment?.contentType?.startsWith("image/") || Number(attachment.size) > 4_000_000) return null;
  const response = await fetch(attachment.url);
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${attachment.contentType};base64,${buffer.toString("base64")}`;
}

export async function handleAICoreMessage(message) {
  const cfg = config();
  if (!cfg.investigationChannelId || message.channelId !== cfg.investigationChannelId || !cfg.investigation) return false;
  if (!canUseAI(message.member)) {
    await message.reply("❌ AI Investigation hanya tersedia untuk akses yang dikonfigurasi.").catch(() => {});
    return true;
  }
  const query           = message.content?.trim() || "";
  const imageAttachment = [...message.attachments.values()].find((item) => item.contentType?.startsWith("image/"));
  if (!query && !imageAttachment) return false;
  if (!imageAttachment && query.length < 10) {
    await message.reply("💡 Kirim pertanyaan teknis, kode, atau error untuk diinvestigasi AI Core.").catch(() => {});
    return true;
  }

  await message.channel.sendTyping().catch(() => {});
  let image = null;
  if (imageAttachment && cfg.visionAnalysis) {
    image = await attachmentAsDataUrl(imageAttachment).catch(() => null);
  }

  let answer, lastErr;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      answer  = await investigate({ query, image });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // ONLY retry on temporary rate limit (429 rate_limit), NOT on quota_exhausted.
      // quota_exhausted means the billing ceiling is hit — retrying would just burn
      // another API call, get another 429, and potentially loop.
      const isTemporaryRateLimit = err?.providerCategory === "rate_limit_429";
      if (isTemporaryRateLimit && attempt === 0) {
        const waitMs = Math.min(err?.retryAfterMs ?? 10_000, 30_000);
        logger.info(`[AI Core] Investigation rate_limit_429 — waiting ${waitMs}ms before single retry`);
        await sleep(waitMs);
        await message.channel.sendTyping().catch(() => {});
        continue;
      }
      break;
    }
  }

  if (!lastErr) {
    await message.reply(truncate(answer, 3900)).catch(() => {});
    return true;
  }

  const err            = lastErr;
  const providerReason = String(err?.providerReason || err?.message || "Unknown error").slice(0, 300);
  const category       = err?.providerCategory || "unknown";
  const httpStatus     = err?.httpStatus ?? null;
  const isRateLimit    = category === "rate_limit_429" || httpStatus === 429;
  const isQuota        = category === "quota_exhausted";
  const isBusy         = category === "concurrent_limit";
  const retryAfterSec  = err?.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : null;

  logger.warn(`[AI Core] Investigation failed (${category}${httpStatus ? ` HTTP ${httpStatus}` : ""}): ${redact(providerReason)}`);

  const userMessage = isBusy
    ? "⏳ AI Core sedang memproses request lain. Coba lagi dalam beberapa detik."
    : isQuota
      ? `❌ **AI Core — Quota Habis** (HTTP 429)\nQuota atau billing provider habis. Periksa dashboard provider Anda.\nReason: ${redact(providerReason)}`
      : isRateLimit
        ? `❌ **AI Core — Rate Limit** (HTTP 429)\nProvider membatasi request.${retryAfterSec ? ` Retry-After: ${retryAfterSec}s.` : " Coba lagi dalam beberapa menit."}\nReason: ${redact(providerReason)}`
        : httpStatus
          ? `❌ **AI Core — Provider Error** (HTTP ${httpStatus})\n${redact(providerReason)}`
          : `❌ **AI Core — Investigation Gagal**\n${redact(providerReason)}`;
  await message.reply(userMessage).catch(() => {});

  if (!isBusy) {
    void logAICoreError({
      feature:       "AI Core — Investigation",
      stage:         "investigate",
      reason:        redact(providerReason),
      errorCategory: category,
      provider:      providerLabel(),
      activeProvider: providerLabel(),
      ...(httpStatus ? { status: String(httpStatus) } : {}),
      ...(err?.retryAfterMs ? { retryAfterMs: String(err.retryAfterMs) } : {}),
      metadata: { channelId: message.channelId, userId: message.author?.id, queryLength: query?.length ?? 0, hadImage: Boolean(image) },
    });
  }
  return true;
}

/**
 * Thin wrapper — lets conversation.js send arbitrary message arrays through
 * the same provider runtime without duplicating client/key/rate-limit logic.
 */
export async function chatWithAI(messages, maxTokens) {
  return requestModel(messages, maxTokens);
}

/**
 * Send a structured error payload to the error-log channel.
 * Exported so conversation.js can report 429/provider failures without
 * importing errorLogger directly or bypassing the redaction wrapper.
 */
export async function reportError(payload) {
  return logAICoreError(payload);
}

/**
 * Build a structured AI error payload for error-log channel.
 * Centralises field names so all callers emit a consistent format.
 *
 * @param {{
 *   feature:        string,
 *   stage:          string,
 *   provider:       string,
 *   model?:         string,
 *   status?:        number|string,
 *   category:       string,
 *   retry:          boolean,
 *   retryAfterMs?:  number,
 *   reason:         string,
 *   requestId?:     string,
 *   metadata?:      object,
 * }} fields
 */
export function buildStructuredAIError({
  feature, stage, provider, model, status, category, retry,
  retryAfterMs, reason, requestId, metadata,
}) {
  return {
    feature:       feature ?? "AI Core",
    stage:         stage   ?? "unknown",
    provider:      provider ?? "unknown",
    activeProvider: provider ?? "unknown",
    model:         model   ?? config().model,
    status:        status  != null ? String(status) : undefined,
    errorCategory: category ?? "unknown",
    retry:         Boolean(retry),
    retryAfterMs:  retryAfterMs != null ? String(retryAfterMs) : undefined,
    reason:        redact(String(reason ?? "Unknown error")),
    requestId:     requestId ?? undefined,
    metadata:      metadata  ?? {},
  };
}
