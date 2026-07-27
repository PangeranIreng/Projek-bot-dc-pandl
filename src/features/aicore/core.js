/**
 * AI Core — one central intelligence service for error analysis,
 * investigation, project knowledge, vision input, and fix prompts.
 *
 * It is deliberately advisory: it never edits source code or executes a
 * generated fix. All provider failures are isolated from the bot.
 */
import crypto from "node:crypto";
import OpenAI from "openai";
import { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } from "discord.js";
import { aiCoreDB, encryptionSourceLabel } from "../../database/aiCoreDB.js";
import { rebuildProjectIndex, searchProject } from "./projectIndexer.js";
import { isOwner, isStaff } from "../../middleware/permissions.js";
import { logger } from "../../utils/logger.js";

let client = null;
let openai = null;
let runtimeApiKey = null;
let openaiApiKey = null;
const recentRequests = [];
const activeErrorAnalyses = new Set();
const MAX_REQUESTS_PER_MINUTE = 8;

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function redact(value) {
  return String(value ?? "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-************")
    .replace(/\b(BOT_TOKEN|OPENAI_API_KEY|SESSION_SECRET|API_KEY)\s*=\s*[^\s]+/gi, "$1=************")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1************");
}

/**
 * Send a structured error to the existing error-log channel via logError.
 * Uses a lazy dynamic import to avoid the circular dependency:
 *   core.js ← errorLogger.js → core.js (recordError / getAICoreConfig)
 *
 * Errors from "AI Core" are intentionally filtered out of recordError to
 * prevent analysis loops, but logError still sends the embed to the channel.
 * Never logs API keys, secrets, or ciphertext.
 */
async function logAICoreError(payload) {
  try {
    const { logError } = await import("../../utils/errorLogger.js");
    void logError(payload).catch(() => {});
  } catch (_) { /* never let error-reporting crash the caller */ }
}

function providerReady() {
  return Boolean(getActiveApiKey());
}

function config() {
  return aiCoreDB.getConfig();
}

function getActiveApiKey() {
  if (runtimeApiKey) return runtimeApiKey;
  return aiCoreDB.getApiKey() || process.env.OPENAI_API_KEY?.trim() || null;
}

function providerLabel() {
  return config().provider === "openai" ? "OpenAI" : String(config().provider || "OpenAI");
}

function keyMask(apiKey) {
  if (!apiKey) return "Not configured";
  const suffix = apiKey.slice(-4);
  return `Configured ••••${suffix}`;
}

function keyDiagnostics(apiKey, extra = {}) {
  const value = String(apiKey || "");
  return {
    hasApiKey: Boolean(value),
    keyLength: value.length,
    maskedPrefix: value ? value.slice(0, 3) : null,
    maskedSuffix: value ? value.slice(-4) : null,
    provider: providerLabel(),
    model: config().model,
    ...extra,
  };
}

function apiKeyHash(apiKey) {
  const value = String(apiKey || "");
  return value
    ? crypto.createHash("sha256").update(value, "utf8").digest("hex")
    : null;
}

function providerErrorStatus(error) {
  return Number.isFinite(Number(error?.status)) ? Number(error.status) : null;
}

function providerErrorText(error) {
  const detail = error?.error;
  if (typeof detail === "string") return detail.toLowerCase();
  if (detail && typeof detail === "object") {
    return [detail.message, detail.type, detail.code].filter(Boolean).join(" ").toLowerCase();
  }
  return String(error?.message || "").toLowerCase();
}

function providerErrorCategory(error, { modelRequest = false } = {}) {
  const status = providerErrorStatus(error);
  const code = String(error?.code || "").toLowerCase();
  const message = providerErrorText(error);
  if (code === "ai_key_format") return "invalid_key_format";
  if (code === "ai_storage") return "secure_storage";
  if (status === 401) return "authentication_401";
  if (status === 403) return "permission_403";
  if (status === 404) {
    return modelRequest && /model|not[_ -]?found|does not exist/.test(message)
      ? "model_404"
      : "endpoint_404";
  }
  if (status === 429) return "rate_limit_429";
  if (status === 400) return "invalid_request_400";
  if (status >= 500) return `provider_${status}`;
  if (error?.name === "AbortError" || code.includes("timeout") || message.includes("timeout")) return "timeout";
  if (/network|fetch|econn|socket|dns|connection error/.test(message)) return "network";
  return "unknown";
}

function classifyProviderError(error, { modelRequest = false } = {}) {
  const status = providerErrorStatus(error);
  const code = String(error?.code || "").toLowerCase();
  const message = providerErrorText(error);
  if (code === "ai_key_format") return "API key format is invalid.";
  if (code === "ai_storage") return "Secure credential storage failed.";
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
    return `Provider rate limit or quota reached${status ? ` (HTTP ${status})` : ""}.`;
  }
  if (status === 400) return "Provider rejected the request format (HTTP 400).";
  if (status >= 500) return `Provider service error (HTTP ${status}).`;
  if (error?.name === "AbortError" || code.includes("timeout") || message.includes("timeout")) {
    return "Provider request timed out.";
  }
  if (/network|fetch|econn|socket|dns|connection error/.test(message)) {
    return "Provider network request failed.";
  }
  if (status) return `Provider request failed (HTTP ${status}).`;
  if (/model|not_found/.test(message)) {
    return "The selected model is unavailable.";
  }
  return "Provider connection failed.";
}

function classifyProviderStatus(error, { modelRequest = false } = {}) {
  const status = providerErrorStatus(error);
  const category = providerErrorCategory(error, { modelRequest });
  if (category === "model_404") return "model_error";
  if (
    category === "timeout" ||
    category === "network"
  ) return "network_error";
  return "provider_error";
}

function safeProviderError(error, options = {}) {
  const safe = new Error(classifyProviderError(error, options));
  safe.providerStatus = classifyProviderStatus(error, options);
  safe.providerCategory = providerErrorCategory(error, options);
  safe.httpStatus = providerErrorStatus(error);
  safe.providerReason = safe.message;
  return safe;
}

function logProviderDiagnostic(stage, apiKey, extra = {}) {
  if (process.env.AI_CORE_DIAGNOSTICS !== "true") return;
  logger.info(`[AI Core] ${stage}`, {
    ...keyDiagnostics(apiKey),
    apiKeySha256: apiKeyHash(apiKey),
    ...extra,
  });
}

function canUseAI(member) {
  const cfg = config();
  if (!member) return false;
  if (cfg.accessMode === "staff" || cfg.accessMode === "admin") return isStaff(member);
  if (cfg.accessMode === "role") return cfg.allowedRoleIds.some((id) => member.roles?.cache?.has(id));
  if (cfg.accessMode === "user") return cfg.allowedUserIds.includes(member.id);
  return isOwner(member);
}

function withinRateLimit() {
  const now = Date.now();
  while (recentRequests[0] && now - recentRequests[0] > 60_000) recentRequests.shift();
  if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) return false;
  recentRequests.push(now);
  return true;
}

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

export function initAICore(discordClient) {
  client = discordClient;
  try {
    logger.info(`[AI Core] Encryption source: ${encryptionSourceLabel()}`);
  } catch (encErr) {
    logger.warn(`[AI Core] Encryption unavailable at startup: ${encErr.message}`);
  }
  const activeKey = getActiveApiKey();
  if (activeKey) {
    logger.info("[AI Core] [KEY_STORED_NOT_TESTED] API key found in storage; connection not yet verified at startup.");
    openai = new OpenAI({
      apiKey: activeKey,
      timeout: Math.max(5000, Number(config().timeoutMs) || 30000),
    });
    openaiApiKey = activeKey;
  } else {
    logger.info("[AI Core] [NO_KEY_STORED] No API key configured.");
    openai = null;
    openaiApiKey = null;
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

export function getAICoreStatus() {
  const cfg = config();
  const knowledge = aiCoreDB.getKnowledge();
  const activeKey = getActiveApiKey();
  const hasKey = Boolean(activeKey);
  // Derive keyStatus: if a key exists but DB says "no_key_stored", correct to "key_stored_not_tested"
  const rawKeyStatus = cfg.keyStatus || "no_key_stored";
  const keyStatus = hasKey && rawKeyStatus === "no_key_stored" ? "key_stored_not_tested" : rawKeyStatus;
  const connectionStatus = hasKey ? (cfg.providerStatus || "not_tested") : "not_configured";
  return {
    online: Boolean(client),
    providerReady: providerReady(),
    keyStatus,
    providerStatus: connectionStatus,
    providerStatusReason: hasKey ? (cfg.providerStatusReason || null) : null,
    providerKeyMask: keyMask(activeKey),
    providerSource: runtimeApiKey ? "runtime" : aiCoreDB.hasStoredApiKey() ? "secure_storage" : activeKey ? "environment" : "none",
    knowledgeReady: Boolean(knowledge.builtAt && knowledge.files.length),
    fileCount: knowledge.summary?.fileCount ?? knowledge.files.length,
    errorChannelId: cfg.errorChannelId,
    investigationChannelId: cfg.investigationChannelId,
    accessMode: cfg.accessMode,
    model: cfg.model,
  };
}

export function getAICoreConfig() {
  return config();
}

export function updateAICoreConfig(patch) {
  const allowed = [
    "errorChannelId", "investigationChannelId", "accessMode", "allowedRoleIds",
    "allowedUserIds", "provider", "model", "timeoutMs", "maxResponse",
    "errorAnalysis", "investigation", "codeAnalysis", "visionAnalysis",
  ];
  const safe = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
  return aiCoreDB.updateConfig(safe);
}

export function getProviderConfiguration() {
  const cfg = config();
  const activeKey = getActiveApiKey();
  const hasKey = Boolean(activeKey);
  // Derive keyStatus: if a key exists but DB says "no_key_stored", correct to "key_stored_not_tested"
  const rawKeyStatus = cfg.keyStatus || "no_key_stored";
  const keyStatus = hasKey && rawKeyStatus === "no_key_stored" ? "key_stored_not_tested" : rawKeyStatus;
  const connectionStatus = hasKey ? (cfg.providerStatus || "not_tested") : "not_configured";
  return {
    provider: providerLabel(),
    model: cfg.model,
    apiKeyConfigured: hasKey,
    apiKeyMask: keyMask(activeKey),
    keyStatus,
    source: runtimeApiKey ? "runtime" : aiCoreDB.hasStoredApiKey() ? "secure_storage" : activeKey ? "environment" : "none",
    status: connectionStatus,
    statusReason: hasKey ? (cfg.providerStatusReason || null) : null,
    checkedAt: cfg.providerCheckedAt || null,
    errorAnalysis: cfg.errorAnalysis,
    investigation: cfg.investigation,
    codeAnalysis: cfg.codeAnalysis,
    visionAnalysis: cfg.visionAnalysis,
  };
}

function validateApiKeyFormat(apiKey) {
  const value = String(apiKey || "").trim();
  if (!value || value.length < 20 || /\s/.test(value)) {
    const error = new Error("API key format is invalid.");
    error.code = "AI_KEY_FORMAT";
    throw error;
  }
  return value;
}

async function checkProvider(apiKey) {
  let candidate = null;
  try {
    candidate = new OpenAI({
      apiKey,
      timeout: Math.max(5000, Number(config().timeoutMs) || 30000),
    });
    logProviderDiagnostic("Provider client initialized", apiKey, {
      clientInitialized: true,
      runtimeConfigLoaded: true,
      checkProviderApiKeySha256: apiKeyHash(apiKey),
      baseURL: candidate.baseURL,
      sdkUsage: "openai.models.list",
    });
  } catch (error) {
    logProviderDiagnostic("Provider client initialization failed", apiKey, {
      clientInitialized: false,
      requestStarted: false,
      requestCompleted: false,
      httpStatus: providerErrorStatus(error),
      providerErrorCategory: providerErrorCategory(error),
    });
    throw error;
  }

  logProviderDiagnostic("Provider request started", apiKey, {
    clientInitialized: true,
    requestStarted: true,
    requestCompleted: false,
    endpoint: "/v1/models",
  });
  try {
    await candidate.models.list();
    logProviderDiagnostic("Provider request completed", apiKey, {
      clientInitialized: true,
      requestStarted: true,
      requestCompleted: true,
      httpStatus: 200,
      baseURL: candidate.baseURL,
      endpoint: "/v1/models",
      providerErrorCategory: null,
    });
    return candidate;
  } catch (error) {
    logProviderDiagnostic("Provider request failed", apiKey, {
      clientInitialized: true,
      requestStarted: true,
      requestCompleted: false,
      httpStatus: providerErrorStatus(error),
      checkProviderApiKeySha256: apiKeyHash(apiKey),
      baseURL: candidate.baseURL,
      endpoint: "/v1/models",
      providerErrorCategory: providerErrorCategory(error),
    });
    throw error;
  }
}

export async function validateProviderModel(model) {
  const name = String(model || "").trim().slice(0, 80);
  if (!name) throw new Error("Model is required.");
  const apiKey = getActiveApiKey();
  if (!apiKey) throw new Error("No AI provider API key is configured.");
  let candidate;
  try {
    candidate = await checkProvider(apiKey);
  } catch (error) {
    const safe = safeProviderError(error);
    aiCoreDB.updateConfig({
      providerStatus: safe.providerStatus,
      providerStatusReason: safe.providerReason,
      providerCheckedAt: new Date().toISOString(),
    });
    throw safe;
  }
  try {
    await candidate.models.retrieve(name);
    return true;
  } catch (error) {
    const safe = safeProviderError(error, { modelRequest: true });
    aiCoreDB.updateConfig({
      providerStatus: safe.providerStatus,
      providerStatusReason: safe.providerReason,
      providerCheckedAt: new Date().toISOString(),
    });
    throw safe;
  }
}

export async function updateProviderApiKey(apiKey) {
  const previousConfig = aiCoreDB.getConfig();
  try {
    const rawInputApiKeySha256 = apiKeyHash(apiKey);
    const value = validateApiKeyFormat(apiKey);
    logProviderDiagnostic("Provider key storage started", value, {
      inputApiKeySha256: rawInputApiKeySha256,
      validatedApiKeySha256: apiKeyHash(value),
      storageWriteSuccess: false,
    });

    // Save the key immediately after format validation.
    // Connection test is deliberately separated — use testProviderConnection() for that.
    aiCoreDB.saveApiKey(value);
    const storageWriteSuccess = aiCoreDB.hasStoredApiKey();
    const storageReadValue = aiCoreDB.getApiKey();
    const storageReadSuccess = storageReadValue === value;

    logProviderDiagnostic("Provider credential persisted", value, {
      storageWriteSuccess,
      storageReadSuccess,
      inputApiKeySha256: rawInputApiKeySha256,
      validatedApiKeySha256: apiKeyHash(value),
      storedApiKeySha256: storageReadValue ? apiKeyHash(storageReadValue) : null,
    });

    if (!storageWriteSuccess || !storageReadSuccess) {
      const storageError = new Error("Secure credential storage failed.");
      storageError.code = "AI_STORAGE";
      throw storageError;
    }

    runtimeApiKey = value;
    openai = new OpenAI({
      apiKey: value,
      timeout: Math.max(5000, Number(config().timeoutMs) || 30000),
    });
    openaiApiKey = value;

    logger.info("[AI Core] [KEY_STORED_NOT_TESTED] API key saved to secure storage; use Test Connection to verify.");

    aiCoreDB.updateConfig({
      keyStatus: "key_stored_not_tested",
      providerStatus: "not_tested",
      providerStatusReason: null,
      providerCheckedAt: new Date().toISOString(),
    });

    return getProviderConfiguration();
  } catch (error) {
    // Restore previous state fully — never drop an existing valid key because a new one fails.
    // NOTE: this function makes NO HTTP requests, so safeProviderError (designed for HTTP errors)
    // must NOT be used here. Classify errors directly to avoid misclassification.
    try {
      aiCoreDB.updateConfig({
        keyStatus: previousConfig.keyStatus || (aiCoreDB.hasStoredApiKey() ? "key_stored_not_tested" : "no_key_stored"),
        providerStatus: previousConfig.providerStatus,
        providerStatusReason: previousConfig.providerStatusReason,
        providerCheckedAt: previousConfig.providerCheckedAt,
      });
    } catch (_) { /* ignore config-restore failure */ }

    const code = String(error?.code || "").toLowerCase();

    // Format errors already have a clear message; rethrow as-is.
    if (code === "ai_key_format") {
      error.providerCategory = "invalid_key_format";
      error.providerStatus = "not_configured";
      error.providerReason = error.message;
      throw error;
    }

    // Storage errors (encryption unavailable, write/read mismatch).
    const storageMsg = code === "ai_storage"
      ? (error.message || "Secure credential storage failed.")
      : `Key storage failed: ${String(error?.message || "Unknown error.").slice(0, 180)}`;
    const safe = new Error(storageMsg);
    safe.providerCategory = "secure_storage";
    safe.providerStatus = "not_configured";
    safe.providerReason = storageMsg;
    logger.warn(`[AI Core] [KEY_SAVE_FAILED] (${code || "unknown"}): ${redact(storageMsg)}`);
    void logAICoreError({
      feature: "AI Core — Secure Storage",
      stage: "api_key_save",
      reason: redact(storageMsg),
      errorCategory: "secure_storage",
      suggestion: "Set AI_CORE_ENCRYPTION_KEY or SESSION_SECRET in environment variables, or ensure the data/ directory is writable.",
    });
    throw safe;
  }
}

export function removeProviderApiKey() {
  runtimeApiKey = null;
  openai = null;
  openaiApiKey = null;
  aiCoreDB.removeApiKey();
  const envKeyPresent = Boolean(process.env.OPENAI_API_KEY?.trim());
  logger.info(envKeyPresent ? "[AI Core] [KEY_STORED_NOT_TESTED] Stored key removed; env key still present." : "[AI Core] [NO_KEY_STORED] API key removed from secure storage.");
  aiCoreDB.updateConfig({
    keyStatus: envKeyPresent ? "key_stored_not_tested" : "no_key_stored",
    providerStatus: envKeyPresent ? "not_tested" : "not_configured",
    providerStatusReason: null,
    providerCheckedAt: null,
  });
  logProviderDiagnostic("Provider credential removed", null, {
    runtimeConfigLoaded: false,
    storageWriteSuccess: !aiCoreDB.hasStoredApiKey(),
    storageReadSuccess: aiCoreDB.getApiKey() === null,
    clientInitialized: false,
  });
  return getProviderConfiguration();
}

export async function testProviderConnection() {
  const apiKey = getActiveApiKey();
  if (!apiKey) {
    logger.info("[AI Core] [NO_KEY_STORED] Test Connection called but no API key is configured.");
    aiCoreDB.updateConfig({ keyStatus: "no_key_stored", providerStatus: "not_configured", providerStatusReason: null });
    return { ok: false, reason: "No AI provider API key is configured.", configuration: getProviderConfiguration() };
  }
  logger.info("[AI Core] [KEY_STORED_NOT_TESTED] Testing provider connection...");
  try {
    aiCoreDB.updateConfig({
      providerStatus: "validating",
      providerStatusReason: null,
      providerCheckedAt: new Date().toISOString(),
    });
    const candidate = await checkProvider(apiKey);
    openai = candidate;
    openaiApiKey = apiKey;
    logProviderDiagnostic("Provider runtime connection checked", apiKey, {
      runtimeApiKeySha256: apiKeyHash(runtimeApiKey),
      getActiveApiKeySha256: apiKeyHash(getActiveApiKey()),
      openaiApiKeySha256: apiKeyHash(openaiApiKey),
      baseURL: candidate.baseURL,
      endpoint: "/v1/models",
    });
    logger.info("[AI Core] [PROVIDER_CONNECTED] Connection test successful.");
    aiCoreDB.updateConfig({
      keyStatus: "key_configured",
      providerStatus: "connected",
      providerStatusReason: null,
      providerCheckedAt: new Date().toISOString(),
    });
    return { ok: true, reason: null, configuration: getProviderConfiguration() };
  } catch (error) {
    const safe = safeProviderError(error);
    const category = safe.providerCategory;
    let keyStatus = "key_stored_not_tested";
    let errorLogCategory = "provider_connection";

    if (category === "authentication_401" || category === "permission_403") {
      keyStatus = "authentication_failed";
      errorLogCategory = "provider_authentication";
      logger.info(`[AI Core] [AUTHENTICATION_FAILED] ${safe.providerReason}`);
    } else if (category === "model_404") {
      keyStatus = "model_not_found";
      errorLogCategory = "model_not_found";
      logger.info(`[AI Core] [MODEL_NOT_FOUND] ${safe.providerReason}`);
    } else {
      logger.info(`[AI Core] [PROVIDER_ERROR] ${safe.providerReason}`);
    }

    aiCoreDB.updateConfig({
      keyStatus,
      providerStatus: safe.providerStatus,
      providerStatusReason: safe.providerReason,
      providerCheckedAt: new Date().toISOString(),
    });

    void logAICoreError({
      feature: "AI Core — Provider",
      stage: "provider_connection",
      reason: safe.providerReason,
      errorCategory: errorLogCategory,
      provider: providerLabel(),
      activeProvider: providerLabel(),
      ...(safe.httpStatus ? { status: String(safe.httpStatus) } : {}),
    });

    return { ok: false, reason: safe.providerReason, configuration: getProviderConfiguration() };
  }
}

export function rebuildKnowledge() {
  return rebuildProjectIndex();
}

async function requestModel(messages, maxTokens = config().maxResponse) {
  const apiKey = getActiveApiKey();
  if (!apiKey) throw new Error("AI provider is not configured");
  if (!withinRateLimit()) throw new Error("AI rate limit reached; try again shortly");
  if (!openai || openaiApiKey !== apiKey) {
    openai = new OpenAI({
      apiKey,
      timeout: Math.max(5000, Number(config().timeoutMs) || 30000),
    });
    openaiApiKey = apiKey;
  }
  const cfg = config();
  const model = cfg.model || "gpt-4o-mini";
  logProviderDiagnostic("Model request prepared", apiKey, {
    runtimeApiKeySha256: apiKeyHash(runtimeApiKey),
    getActiveApiKeySha256: apiKeyHash(apiKey),
    openaiApiKeySha256: apiKeyHash(openaiApiKey),
    baseURL: openai?.baseURL ?? null,
    endpoint: "/v1/chat/completions",
    model,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, Number(cfg.timeoutMs) || 30000));
  try {
    const response = await openai.chat.completions.create({
      model,
      messages,
      max_completion_tokens: Math.min(4000, Math.max(300, Number(maxTokens) || 1800)),
    }, { signal: controller.signal });
    aiCoreDB.incrementStat("aiRequests");
    aiCoreDB.updateConfig({
      providerStatus: "connected",
      providerStatusReason: null,
      providerCheckedAt: new Date().toISOString(),
    });
    logProviderDiagnostic("Model request completed", apiKey, {
      runtimeApiKeySha256: apiKeyHash(runtimeApiKey),
      getActiveApiKeySha256: apiKeyHash(getActiveApiKey()),
      openaiApiKeySha256: apiKeyHash(openaiApiKey),
      baseURL: openai?.baseURL ?? null,
      endpoint: "/v1/chat/completions",
      model,
      httpStatus: 200,
    });
    return response.choices?.[0]?.message?.content?.trim() || "AI provider returned an empty response.";
  } catch (err) {
    const safe = safeProviderError(err, { modelRequest: true });
    logProviderDiagnostic("Model request failed", apiKey, {
      runtimeApiKeySha256: apiKeyHash(runtimeApiKey),
      getActiveApiKeySha256: apiKeyHash(getActiveApiKey()),
      openaiApiKeySha256: apiKeyHash(openaiApiKey),
      baseURL: openai?.baseURL ?? null,
      endpoint: "/v1/chat/completions",
      model,
      httpStatus: providerErrorStatus(err),
      providerErrorCategory: providerErrorCategory(err, { modelRequest: true }),
    });
    aiCoreDB.incrementStat("failedRequests");
    aiCoreDB.updateConfig({
      providerStatus: safe.providerStatus,
      providerStatusReason: safe.providerReason,
      providerCheckedAt: new Date().toISOString(),
    });
    throw safe;
  } finally {
    clearTimeout(timeout);
  }
}

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

async function analyzeError(record) {
  const cfg = config();
  if (!cfg.errorAnalysis || !cfg.errorChannelId || activeErrorAnalyses.has(record.errorId)) return;
  activeErrorAnalyses.add(record.errorId);
  try {
    const context = relevantContext(`${record.feature} ${record.module} ${record.function} ${record.reason}`);
    const prompt = [
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
    logger.warn(`[AI Core] Error analysis skipped: ${redact(err.message)}`);
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
      { name: "Error ID", value: `\`${record.errorId}\``, inline: true },
      { name: "Feature", value: truncate(record.feature || "Unknown", 100), inline: true },
      { name: "Occurrences", value: String(record.occurrences || 1), inline: true },
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
  const hash = fingerprint(payload);
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

  const error = payload.error;
  const record = {
    errorId: makeErrorId(payload, hash),
    fingerprint: hash,
    feature: redact(payload.feature || "Unknown"),
    module: redact(payload.module || ""),
    function: redact(payload.function || ""),
    platform: redact(payload.platform || payload.provider || ""),
    action: redact(payload.action || ""),
    stage: redact(payload.stage || ""),
    reason: redact(payload.reason || error?.message || "Unknown error"),
    stack: redact(error?.stack || ""),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    metadata: redact(JSON.stringify(payload.metadata ?? {})).slice(0, 3000),
    occurrences: 1,
    lastSeen: new Date().toISOString(),
    status: "open",
    analysis: null,
  };
  aiCoreDB.addError(record);
  void analyzeError(record);
  return record;
}

export async function investigate({ query, image }) {
  const cfg = config();
  const context = cfg.codeAnalysis ? relevantContext(query) : "";
  const messages = [
    {
      role: "system",
      content: "Anda adalah AI Core untuk developer. Jawab dalam bahasa Indonesia. Gunakan hanya fakta dari project excerpts. Jangan mengarang path/function. Tandai dugaan sebagai kemungkinan. Jangan mengubah source code.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: `PERTANYAAN:\n${redact(query)}\n\nPROJECT EXCERPTS:\n${context || "Tidak ada excerpt yang cocok."}` },
        ...(image ? [{ type: "image_url", image_url: { url: image } }] : []),
      ],
    },
  ];
  if (!providerReady()) {
    return `🤖 AI CORE (mode lokal)\n\n${fallbackErrorAnalysis({
      errorId: "INVESTIGATION",
      feature: "Project Investigation",
      reason: `Pertanyaan: ${query}`,
    })}`;
  }
  return redact(await requestModel(messages));
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
    { role: "user", content: `ERROR:\n${JSON.stringify(record, null, 2)}\n\nPROJECT EXCERPTS:\n${context}` },
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
  const query = message.content?.trim() || "";
  const imageAttachment = [...message.attachments.values()].find((item) => item.contentType?.startsWith("image/"));
  if (!query && !imageAttachment) return false;
  await message.channel.sendTyping().catch(() => {});
  let image = null;
  if (imageAttachment && cfg.visionAnalysis) {
    image = await attachmentAsDataUrl(imageAttachment).catch(() => null);
  }
  try {
    const answer = await investigate({ query, image });
    await message.reply(truncate(answer, 3900)).catch(() => {});
  } catch (err) {
    logger.warn(`[AI Core] Investigation failed: ${redact(err.message)}`);
    await message.reply("❌ AI Core tidak dapat menyelesaikan investigation ini. Periksa konfigurasi provider dan coba lagi.").catch(() => {});
  }
  return true;
}

export function isAICoreAllowed(member) {
  return canUseAI(member);
}