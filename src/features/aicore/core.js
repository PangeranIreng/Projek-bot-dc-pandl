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
import { aiCoreDB } from "../../database/aiCoreDB.js";
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

function classifyProviderError(error) {
  const status = Number(error?.status);
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  if (status === 401 || status === 403 || /auth|api key|credential|unauthorized|forbidden/.test(message)) {
    return "Provider rejected the credentials.";
  }
  if (status === 429 || code.includes("rate") || message.includes("rate limit")) {
    return "Provider rate limit reached.";
  }
  if (/model|not_found/.test(message) || status === 404) {
    return "The selected model is unavailable.";
  }
  if (error?.name === "AbortError" || code.includes("timeout") || message.includes("timeout")) {
    return "Provider request timed out.";
  }
  if (/network|fetch|econn|socket|dns/.test(message)) {
    return "Provider network request failed.";
  }
  return "Provider connection failed.";
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
  const currentProviderStatus = activeKey
    ? (cfg.providerStatus === "not_configured" ? "configured" : (cfg.providerStatus || "configured"))
    : "not_configured";
  return {
    online: Boolean(client),
    providerReady: providerReady(),
    providerStatus: currentProviderStatus,
    providerStatusReason: activeKey ? (cfg.providerStatusReason || null) : null,
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
  const storedStatus = cfg.providerStatus === "not_configured" && activeKey
    ? "configured"
    : (cfg.providerStatus || "not_configured");
  return {
    provider: providerLabel(),
    model: cfg.model,
    apiKeyConfigured: Boolean(activeKey),
    apiKeyMask: keyMask(activeKey),
    source: runtimeApiKey ? "runtime" : aiCoreDB.hasStoredApiKey() ? "secure_storage" : activeKey ? "environment" : "none",
    status: activeKey ? storedStatus : "not_configured",
    statusReason: activeKey ? (cfg.providerStatusReason || null) : null,
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
    throw new Error("API key format is invalid.");
  }
  return value;
}

async function checkProvider(apiKey) {
  const candidate = new OpenAI({
    apiKey,
    timeout: Math.max(5000, Number(config().timeoutMs) || 30000),
  });
  await candidate.models.list();
  return candidate;
}

export async function validateProviderModel(model) {
  const name = String(model || "").trim().slice(0, 80);
  if (!name) throw new Error("Model is required.");
  const apiKey = getActiveApiKey();
  if (!apiKey) throw new Error("No AI provider API key is configured.");
  const candidate = await checkProvider(apiKey);
  try {
    await candidate.models.retrieve(name);
    return true;
  } catch (error) {
    throw new Error(classifyProviderError(error));
  }
}

export async function updateProviderApiKey(apiKey) {
  let candidate;
  const previousConfig = aiCoreDB.getConfig();
  try {
    const value = validateApiKeyFormat(apiKey);
    aiCoreDB.updateConfig({
      providerStatus: "validating",
      providerStatusReason: null,
      providerCheckedAt: new Date().toISOString(),
    });
    candidate = await checkProvider(value);
    aiCoreDB.saveApiKey(value);
    runtimeApiKey = value;
    openai = candidate;
    openaiApiKey = value;
    aiCoreDB.updateConfig({
      providerStatus: "connected",
      providerStatusReason: null,
      providerCheckedAt: new Date().toISOString(),
    });
    return getProviderConfiguration();
  } catch (error) {
    const hadExistingKey = Boolean(getActiveApiKey());
    aiCoreDB.updateConfig(hadExistingKey
      ? {
          providerStatus: previousConfig.providerStatus,
          providerStatusReason: previousConfig.providerStatusReason,
          providerCheckedAt: previousConfig.providerCheckedAt,
        }
      : {
          providerStatus: "invalid",
          providerStatusReason: classifyProviderError(error),
          providerCheckedAt: new Date().toISOString(),
        });
    throw new Error(classifyProviderError(error));
  }
}

export function removeProviderApiKey() {
  runtimeApiKey = null;
  openai = null;
  openaiApiKey = null;
  aiCoreDB.removeApiKey();
  aiCoreDB.updateConfig({
    providerStatus: process.env.OPENAI_API_KEY?.trim() ? "configured" : "not_configured",
    providerStatusReason: null,
    providerCheckedAt: null,
  });
  return getProviderConfiguration();
}

export async function testProviderConnection() {
  const apiKey = getActiveApiKey();
  if (!apiKey) {
    aiCoreDB.updateConfig({ providerStatus: "not_configured", providerStatusReason: null });
    return { ok: false, reason: "No AI provider API key is configured.", configuration: getProviderConfiguration() };
  }
  try {
    aiCoreDB.updateConfig({
      providerStatus: "validating",
      providerStatusReason: null,
      providerCheckedAt: new Date().toISOString(),
    });
    const candidate = await checkProvider(apiKey);
    openai = candidate;
    openaiApiKey = apiKey;
    aiCoreDB.updateConfig({
      providerStatus: "connected",
      providerStatusReason: null,
      providerCheckedAt: new Date().toISOString(),
    });
    return { ok: true, reason: null, configuration: getProviderConfiguration() };
  } catch (error) {
    const reason = classifyProviderError(error);
    aiCoreDB.updateConfig({
      providerStatus: error?.status === 429 ? "provider_error" : "invalid",
      providerStatusReason: reason,
      providerCheckedAt: new Date().toISOString(),
    });
    return { ok: false, reason, configuration: getProviderConfiguration() };
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
    openai = new OpenAI({ apiKey });
    openaiApiKey = apiKey;
  }
  const cfg = config();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, Number(cfg.timeoutMs) || 30000));
  try {
    const response = await openai.chat.completions.create({
      model: cfg.model || "gpt-5.4-mini",
      messages,
      max_completion_tokens: Math.min(4000, Math.max(300, Number(maxTokens) || 1800)),
    }, { signal: controller.signal });
    aiCoreDB.incrementStat("aiRequests");
    return response.choices?.[0]?.message?.content?.trim() || "AI provider returned an empty response.";
  } catch (err) {
    aiCoreDB.incrementStat("failedRequests");
    throw err;
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