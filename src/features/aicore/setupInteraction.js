import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelSelectMenuBuilder, ChannelType, ModalBuilder, TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { isOwner } from "../../middleware/permissions.js";
import {
  getAICoreStatus, getAICoreConfig, updateAICoreConfig,
  rebuildKnowledge, isAICoreAllowed, generateFixPrompt,
  getProviderConfiguration, updateProviderApiKey, removeProviderApiKey,
  testProviderConnection, validateProviderModel, setActiveProvider,
  isProviderQuotaExhausted, getQuotaExhaustedInfo, resetQuotaExhaustedStatus,
  redact,
} from "./core.js";
import { clearConversationHistory, getConversationStats } from "./conversation.js";
import { logger } from "../../utils/logger.js";
import { list as listProviders } from "./providers/registry.js";

const COLOR = 0x7c3aed;

function deny(interaction) {
  if (isOwner(interaction.member)) return false;
  void interaction.reply({ content: "❌ Hanya Owner yang dapat mengelola AI Core.", ephemeral: true }).catch(() => {});
  return true;
}

// ── Status label helpers ───────────────────────────────────────────────────────

function keyStatusLabel(keyStatus) {
  return {
    no_key_stored:         "🔴 NOT CONFIGURED",
    key_stored_not_tested: "🟡 CONFIGURED (Belum diuji)",
    key_configured:        "🟢 CONFIGURED",
    authentication_failed: "🔴 AUTH FAILED",
    model_not_found:       "🟠 CONFIGURED (Model error)",
  }[keyStatus] || "🔴 NOT CONFIGURED";
}

function connectionStatusLabel(status) {
  return {
    not_configured:       "🔴 NOT CONFIGURED",
    not_tested:           "🟡 NOT TESTED",
    validating:           "🟡 VALIDATING...",
    connected:            "🟢 CONNECTED",
    authentication_failed: "🔴 AUTHENTICATION FAILED",
    model_not_found:      "🔴 MODEL NOT FOUND",
    provider_error:       "🔴 PROVIDER ERROR",
    model_error:          "🔴 MODEL ERROR",
    network_error:        "🟠 NETWORK ERROR",
  }[status] || "🟡 UNKNOWN";
}

// ── Main panel ─────────────────────────────────────────────────────────────────

function panelEmbed(note = "") {
  const status = getAICoreStatus();
  const cfg    = getAICoreConfig();
  const prov   = getProviderConfiguration();
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("👑 AI CORE")
    .setDescription(`**CENTRAL INTELLIGENCE**${note ? `\n\n${note}` : ""}`)
    .addFields(
      { name: "Status",           value: status.online ? "🟢 ONLINE" : "🟡 Menunggu bot login", inline: true },
      { name: "Project Knowledge",value: status.knowledgeReady ? `🟢 READY (${status.fileCount} files)` : "🟡 Belum dibuat", inline: true },
      { name: "Error Analyzer",   value: cfg.errorAnalysis  ? "🟢 ENABLED" : "⚪ DISABLED", inline: true },
      { name: "Vision Analyzer",  value: cfg.visionAnalysis ? "🟢 ENABLED" : "⚪ DISABLED", inline: true },
      { name: "AI Conversation",  value: cfg.conversation   ? "🟢 ENABLED" : "⚪ DISABLED", inline: true },
      { name: "Fix Generator",    value: "🟢 ENABLED", inline: true },
      { name: "Provider",         value: `${connectionStatusLabel(prov.status)} **${prov.provider}** / \`${prov.model}\``, inline: false },
      { name: "❌ Error AI Channel",    value: cfg.errorChannelId         ? `<#${cfg.errorChannelId}>`         : "Belum diatur", inline: false },
      { name: "💬 Investigation Channel", value: cfg.investigationChannelId ? `<#${cfg.investigationChannelId}>` : "Belum diatur", inline: false },
      { name: "🗨️ Conversation Channel",  value: cfg.conversationChannelId  ? `<#${cfg.conversationChannelId}>`  : "Belum diatur", inline: false },
      { name: "🔐 Access",         value: cfg.accessMode === "owner" ? "Owner Only" : cfg.accessMode, inline: true },
    )
    .setFooter({ text: "AI Core tidak mengubah source code secara otomatis." })
    .setTimestamp();
}

function panelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("aicore:channels").setLabel("📢 Channels").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("aicore:access").setLabel("🔐 Access").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("aicore:config").setLabel("⚙️ AI Configuration").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("aicore:knowledge").setLabel("🧠 Rebuild Project Knowledge").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("aicore:test").setLabel("🧪 Test Core").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("aicore:back").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Provider config panel ──────────────────────────────────────────────────────

function providerConfigEmbed(note = "") {
  const cfg   = getProviderConfiguration();
  const prov  = listProviders();
  const activeProviderInfo = prov.find((p) => p.id === cfg.providerId);
  const quota = getQuotaExhaustedInfo();

  // Build a quota warning note if the provider is in QUOTA_EXHAUSTED state.
  const quotaNote = quota.exhausted
    ? `\n\n⛔ **QUOTA EXHAUSTED** — Provider **${quota.provider ?? cfg.provider}** sedang diblokir secara lokal.\nSemua request AI ditolak tanpa menyentuh API sampai provider atau API key diganti.\nWaktu: <t:${Math.floor(new Date(quota.since).getTime() / 1000)}:R>`
    : "";

  return new EmbedBuilder()
    .setColor(quota.exhausted ? 0xed4245 : COLOR)
    .setTitle("⚙️ AI CONFIGURATION")
    .setDescription(
      `${note ? `${note}\n\n` : ""}${quotaNote ? quotaNote + "\n\n" : ""}` +
      `Pengaturan provider AI Core disimpan secara aman.\n` +
      `Provider tersedia: **${prov.map((p) => p.name).join(", ")}**`
    )
    .addFields(
      { name: "Provider",       value: `🟢 **${cfg.provider}**`,                           inline: true },
      { name: "API Key",        value: `${keyStatusLabel(cfg.keyStatus)}\n${cfg.apiKeyMask}`, inline: true },
      { name: "Connection",     value: connectionStatusLabel(cfg.status),                   inline: true },
      { name: "Quota Status",   value: quota.exhausted ? "⛔ QUOTA EXHAUSTED" : "✅ OK",    inline: true },
      { name: "Model",          value: `\`${cfg.model}\``,                                  inline: true },
      { name: "Default Model",  value: `\`${activeProviderInfo?.defaultModel ?? cfg.model}\``, inline: true },
      { name: "Error Analysis", value: cfg.errorAnalysis  ? "🟢 ON" : "⚪ OFF", inline: true },
      { name: "Investigation",  value: cfg.investigation  ? "🟢 ON" : "⚪ OFF", inline: true },
      { name: "Code Analysis",  value: cfg.codeAnalysis   ? "🟢 ON" : "⚪ OFF", inline: true },
      { name: "Vision Analysis",value: cfg.visionAnalysis ? "🟢 ON" : "⚪ OFF", inline: true },
      { name: "AI Conversation",value: cfg.conversation   ? "🟢 ON" : "⚪ OFF", inline: true },
      { name: "Fix Generator",  value: "🟢 ON", inline: true },
      ...(cfg.statusReason ? [{ name: "Provider note", value: String(cfg.statusReason).slice(0, 1024), inline: false }] : []),
    )
    .setFooter({ text: "API key tidak pernah ditampilkan lengkap atau dikirim ke channel." })
    .setTimestamp();
}

function providerConfigComponents() {
  const quota = getQuotaExhaustedInfo();
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("aicore:provider:apikey").setLabel("🔑 Change API Key").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("aicore:provider:test").setLabel("🧪 Test Connection").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("aicore:provider:model").setLabel("🧠 Change Model").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("aicore:provider:change").setLabel("🔄 Change Provider").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("aicore:provider:settings").setLabel("⚙️ AI Settings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("aicore:provider:remove").setLabel("🗑️ Remove API Key").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      ...(quota.exhausted
        ? [new ButtonBuilder().setCustomId("aicore:quota:reset").setLabel("🔄 Reset Quota Status").setStyle(ButtonStyle.Secondary)]
        : []
      ),
      new ButtonBuilder().setCustomId("aicore:setup").setLabel("🔙 AI Core").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

// ── Provider selection panel ───────────────────────────────────────────────────

/**
 * Build a provider selection embed + row of buttons.
 * Called when auto-detection failed (unknown key format) or when the user
 * clicks "Change Provider" manually.
 */
function providerSelectEmbed(note = "") {
  const providers = listProviders();
  const lines = providers.map((p) => `• **${p.name}** — default model: \`${p.defaultModel}\``).join("\n");
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("🔄 PILIH AI PROVIDER")
    .setDescription(
      `${note ? `${note}\n\n` : ""}API key berhasil disimpan tetapi provider tidak dapat dideteksi otomatis.\n` +
      `Pilih provider yang sesuai dengan API key yang baru dimasukkan:\n\n${lines}`
    )
    .setFooter({ text: "Provider menentukan endpoint dan format request yang digunakan." })
    .setTimestamp();
}

function providerSelectComponents() {
  const providers = listProviders();
  // Discord allows max 5 buttons per row; we have exactly 5 providers
  const buttons = providers.map((p) =>
    new ButtonBuilder()
      .setCustomId(`aicore:provider:select:${p.id}`)
      .setLabel(p.name)
      .setStyle(ButtonStyle.Primary),
  );
  return [new ActionRowBuilder().addComponents(...buttons)];
}

// ── Exported helpers (for adminSetup / commands) ───────────────────────────────

export function buildAICoreEmbed()      { return panelEmbed(); }
export function buildAICoreComponents() { return panelComponents(); }

// ── Main interaction handler ───────────────────────────────────────────────────

export async function handleAICoreInteraction(interaction) {
  const id = interaction.customId ?? "";
  try {
    // Fix prompt — accessible to all allowed users (not just owner)
    if (id.startsWith("aicore:fix:")) {
      if (!isAICoreAllowed(interaction.member)) {
        return void interaction.reply({ content: "❌ Kamu tidak memiliki akses ke AI Core.", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const prompt = await generateFixPrompt(id.slice("aicore:fix:".length));
      await interaction.editReply({ content: `🛠️ **FIX REQUEST**\n\`\`\`md\n${prompt.slice(0, 3800)}\n\`\`\`` });
      return;
    }

    if (deny(interaction)) return;

    // ── Navigation ──────────────────────────────────────────────────────────
    if (id === "aicore:setup" || id === "aicore:refresh") {
      await interaction.update({ embeds: [panelEmbed()], components: panelComponents() });
      return;
    }
    if (id === "aicore:back") {
      const { buildMainSetupEmbed, buildMainSetupComponents } = await import("../setup/adminSetup.js");
      await interaction.update({ embeds: [buildMainSetupEmbed()], components: buildMainSetupComponents() });
      return;
    }

    // ── Channel configuration ────────────────────────────────────────────────
    if (id === "aicore:channels") {
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle("📢 AI CHANNELS").setDescription("Konfigurasi channel per fitur. Tersimpan persistent.")],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("aicore:channel:error").setLabel("❌ Error AI Channel").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("aicore:channel:investigation").setLabel("💬 Investigation Channel").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("aicore:channel:conversation").setLabel("🗨️ Conversation Channel").setStyle(ButtonStyle.Secondary),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("aicore:setup").setLabel("🔙 Kembali ke AI Core").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }
    const channelAction = /^aicore:channel:(error|investigation|conversation)$/.exec(id);
    if (channelAction) {
      const kind = channelAction[1];
      const kindLabel = kind === "error" ? "Error AI" : kind === "investigation" ? "Investigation" : "AI Conversation";
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle("📢 Pilih Channel").setDescription(`Pilih channel untuk **${kindLabel}**.`)],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId(`aicore:channel:select:${kind}`)
              .setPlaceholder("Pilih channel text...")
              .addChannelTypes(ChannelType.GuildText),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("aicore:channels").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }
    const channelSelect = /^aicore:channel:select:(error|investigation|conversation)$/.exec(id);
    if (channelSelect && interaction.isChannelSelectMenu()) {
      updateAICoreConfig({ [`${channelSelect[1]}ChannelId`]: interaction.values[0] });
      await interaction.update({ embeds: [panelEmbed("✅ Channel berhasil disimpan.")], components: panelComponents() });
      return;
    }

    // ── Access config ────────────────────────────────────────────────────────
    if (id === "aicore:access") {
      const cfg   = getAICoreConfig();
      const modal = new ModalBuilder().setCustomId("aicore:modal:access").setTitle("AI Core Access");
      const mode  = new TextInputBuilder().setCustomId("mode").setLabel("Mode: owner / staff / role / user").setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.accessMode);
      const ids   = new TextInputBuilder().setCustomId("ids").setLabel("Role/User IDs (comma-separated; optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue([...(cfg.allowedRoleIds ?? []), ...(cfg.allowedUserIds ?? [])].join(","));
      modal.addComponents(new ActionRowBuilder().addComponents(mode), new ActionRowBuilder().addComponents(ids));
      await interaction.showModal(modal);
      return;
    }

    // ── Provider config panel ────────────────────────────────────────────────
    if (id === "aicore:config") {
      await interaction.update({ embeds: [providerConfigEmbed()], components: providerConfigComponents() });
      return;
    }

    // ── API key input ────────────────────────────────────────────────────────
    if (id === "aicore:provider:apikey") {
      const modal = new ModalBuilder().setCustomId("aicore:modal:apikey").setTitle("🔐 UPDATE AI API KEY");
      const key   = new TextInputBuilder()
        .setCustomId("apiKey")
        .setLabel("Masukkan API key baru")
        .setPlaceholder("OpenAI: sk-…  Gemini: AIza…  Anthropic: sk-ant-…  Groq: gsk_…  OpenRouter: sk-or-…")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(20);
      modal.addComponents(new ActionRowBuilder().addComponents(key));
      await interaction.showModal(modal);
      return;
    }

    // ── Manual provider override ─────────────────────────────────────────────
    if (id === "aicore:provider:change") {
      await interaction.update({
        embeds: [providerSelectEmbed("Pilih provider untuk API key yang sedang aktif.")],
        components: [
          ...providerSelectComponents(),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("aicore:config").setLabel("🔙 Batal").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }

    // ── Provider selection (from detection-failed flow OR manual change) ──────
    const providerSelect = /^aicore:provider:select:([a-z]+)$/.exec(id);
    if (providerSelect) {
      const providerId = providerSelect[1];
      const result     = setActiveProvider(providerId);
      await interaction.update({
        embeds: [providerConfigEmbed(
          `✅ Provider diset ke **${result.provider}**.\nModel default: \`${result.defaultModel}\`\nGunakan **🧪 Test Connection** untuk memverifikasi.`
        )],
        components: providerConfigComponents(),
      });
      return;
    }

    // ── Quota reset (manual override when user changes billing/key externally) ──
    if (id === "aicore:quota:reset") {
      resetQuotaExhaustedStatus();
      await interaction.update({
        embeds: [providerConfigEmbed("✅ Quota status di-reset. Provider akan dicoba kembali pada request berikutnya.\nGunakan 🧪 Test Connection untuk memverifikasi koneksi.")],
        components: providerConfigComponents(),
      });
      return;
    }

    // ── Test connection ──────────────────────────────────────────────────────
    if (id === "aicore:provider:test") {
      await interaction.deferReply({ ephemeral: true });
      // If quota is exhausted, clear it first before testing — user pressed
      // "Test Connection" to verify after billing top-up, not to get blocked.
      const quotaBefore = isProviderQuotaExhausted();
      if (quotaBefore) resetQuotaExhaustedStatus();
      const result = await testProviderConnection();
      await interaction.editReply({
        content: result.ok
          ? [
              `🧪 **AI CONNECTION TEST**`,
              `Provider: **${result.configuration.provider}**`,
              `Model: \`${result.configuration.model}\``,
              `Status: 🟢 SUCCESS`,
              `AI Core: 🟢 READY`,
            ].join("\n")
          : [
              `🧪 **AI CONNECTION TEST**`,
              `Provider: **${result.configuration.provider}**`,
              `Status: 🔴 FAILED`,
              `Reason: ${result.reason}`,
            ].join("\n"),
      });
      // Refresh the panel in-place so the user sees the updated connection
      // status (e.g. 🟢 CONNECTED / 🔴 AUTH FAILED) without navigating away.
      await interaction.message
        .edit({ embeds: [providerConfigEmbed()], components: providerConfigComponents() })
        .catch(() => {});
      return;
    }

    // ── Model selection ──────────────────────────────────────────────────────
    if (id === "aicore:provider:model") {
      const cfg   = getProviderConfiguration();
      const modal = new ModalBuilder().setCustomId("aicore:modal:model").setTitle("🧠 SELECT AI MODEL");
      const model = new TextInputBuilder()
        .setCustomId("model")
        .setLabel(`Model provider (${cfg.provider})`)
        .setPlaceholder(`Default: ${cfg.defaultModel}`)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(cfg.model || cfg.defaultModel);
      modal.addComponents(new ActionRowBuilder().addComponents(model));
      await interaction.showModal(modal);
      return;
    }

    // ── AI settings ──────────────────────────────────────────────────────────
    if (id === "aicore:provider:settings") {
      const cfg   = getAICoreConfig();
      const modal = new ModalBuilder().setCustomId("aicore:modal:config").setTitle("⚙️ AI Core Settings");

      const timeout = new TextInputBuilder()
        .setCustomId("timeout")
        .setLabel("Timeout (ms) — antara 5000 dan 120000")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(cfg.timeoutMs ?? 30000));

      const maxTok = new TextInputBuilder()
        .setCustomId("maxtokens")
        .setLabel("Max response tokens — antara 300 dan 4000")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(cfg.maxResponse ?? 1800));

      const ana1 = new TextInputBuilder()
        .setCustomId("analysis1")
        .setLabel("Error & Investigation (on/off, on/off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Error Analysis, lalu Investigation — contoh: on, on")
        .setValue(`${cfg.errorAnalysis ? "on" : "off"}, ${cfg.investigation ? "on" : "off"}`);

      const ana2 = new TextInputBuilder()
        .setCustomId("analysis2")
        .setLabel("Code & Vision Analysis (on/off, on/off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Code Analysis, lalu Vision Analysis — contoh: on, on")
        .setValue(`${cfg.codeAnalysis ? "on" : "off"}, ${cfg.visionAnalysis ? "on" : "off"}`);

      const conv = new TextInputBuilder()
        .setCustomId("conversation")
        .setLabel("AI Conversation (on/off)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(cfg.conversation ? "on" : "off");

      modal.addComponents(
        new ActionRowBuilder().addComponents(timeout),
        new ActionRowBuilder().addComponents(maxTok),
        new ActionRowBuilder().addComponents(ana1),
        new ActionRowBuilder().addComponents(ana2),
        new ActionRowBuilder().addComponents(conv),
      );
      await interaction.showModal(modal);
      return;
    }

    // ── Remove API key ───────────────────────────────────────────────────────
    if (id === "aicore:provider:remove") {
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR)
            .setTitle("⚠️ REMOVE AI API KEY?")
            .setDescription("API key provider akan dihapus dari secure storage. Project Knowledge, channel configuration, error history, dan AI Core tetap dipertahankan."),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("aicore:provider:remove:confirm").setLabel("🗑️ Remove permanently").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("aicore:config").setLabel("Batal").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }
    if (id === "aicore:provider:remove:confirm") {
      removeProviderApiKey();
      await interaction.update({
        embeds: [providerConfigEmbed("✅ API key dihapus. AI Core tetap berjalan dalam fallback/local mode.")],
        components: providerConfigComponents(),
      });
      return;
    }

    // ── Rebuild project knowledge ────────────────────────────────────────────
    if (id === "aicore:knowledge") {
      await interaction.deferUpdate();
      const knowledge = rebuildKnowledge();
      await interaction.editReply({
        embeds: [panelEmbed(`✅ Project Knowledge diperbarui: ${knowledge.summary.fileCount} file di-index.`)],
        components: panelComponents(),
      });
      return;
    }

    // ── Test core channels ───────────────────────────────────────────────────
    if (id === "aicore:test") {
      // Defer immediately — up to 6 network calls (fetch + send per channel)
      // can easily exceed Discord's 3-second interaction deadline.
      await interaction.deferReply({ ephemeral: true });
      const cfg = getAICoreConfig();
      const rawTargets = [
        ["Error Channel", cfg.errorChannelId],
        ["Investigation Channel", cfg.investigationChannelId],
        ["Conversation Channel", cfg.conversationChannelId],
      ];

      // Discord snowflakes must be scalar string/number values. Normalize and
      // validate before fetch so malformed config cannot produce the vague
      // "Expected the value to be a string or number" error.
      const targets = rawTargets
        .map(([label, value]) => [label, String(value ?? "").trim()])
        .filter(([, value]) => /^\d{15,25}$/.test(value));

      const results = [];
      for (const [label, channelId] of new Map(targets).entries()) {
        const ch = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!ch) {
          results.push(`🔴 ${label}: channel tidak ditemukan`);
          continue;
        }
        if (!ch.isTextBased()) {
          results.push(`🟡 ${label}: bukan text channel`);
          continue;
        }
        const sent = await ch.send("🧪 **AI CORE TEST** — Channel connection aktif.").then(() => true).catch(() => false);
        results.push(`${sent ? "🟢" : "🔴"} ${label}: ${sent ? "OK" : "gagal mengirim"}`);
      }

      const summary = results.length
        ? results.join("\n")
        : "🟡 Belum ada channel AI Core yang dikonfigurasi.";

      await interaction.editReply({
        content: `🧪 **AI CORE CHANNEL TEST**\n${summary}`,
      });
      return;
    }

  } catch (err) {
    logger.warn(`[AI Core] Setup interaction failed (${id}): ${err.message}`);
    const safe     = redact(String(err?.providerReason || err?.message || "Unknown error")).slice(0, 300);
    const category = err?.providerCategory ?? null;
    const status   = err?.httpStatus       ?? null;
    const method   = interaction.deferred ? "editReply" : interaction.replied ? "followUp" : "reply";

    // Show a specific error message based on the error category instead of a generic fallback.
    const categoryMessages = {
      invalid_key_format:  "❌ **Format API Key Tidak Valid**\nAPI key terlalu pendek atau mengandung spasi.",
      secure_storage:      "❌ **Secure Storage Gagal**\nKredensial tidak bisa disimpan. Pastikan `SESSION_SECRET` atau `AI_CORE_ENCRYPTION_KEY` sudah dikonfigurasi.",
      authentication_401:  "❌ **Autentikasi Gagal (HTTP 401)**\nAPI key atau autentikasi provider tidak valid. Periksa kembali API key Anda.",
      permission_403:      "❌ **Akses Ditolak (HTTP 403)**\nProvider menolak akses. Periksa izin API key Anda.",
      model_404:           "❌ **Model Tidak Ditemukan (HTTP 404)**\nModel tidak tersedia di provider ini. Gunakan model lain.",
      endpoint_404:        "❌ **Endpoint Tidak Ditemukan (HTTP 404)**\nEndpoint provider tidak dapat dijangkau.",
      rate_limit_429:      "❌ **Rate Limit (HTTP 429)**\nProvider membatasi request. Coba lagi dalam beberapa menit.",
      quota_exhausted:     "❌ **Quota Habis (HTTP 429)**\nQuota atau billing provider habis. Tidak ada retry otomatis. Periksa dashboard provider Anda.",
      timeout:             "❌ **Timeout**\nProvider tidak merespons dalam batas waktu. Coba lagi atau naikkan timeout di ⚙️ AI Settings.",
      network:             "❌ **Network Error**\nKoneksi ke provider gagal. Periksa koneksi jaringan.",
      concurrent_limit:    "⏳ **AI Core Sibuk**\nSedang memproses request lain. Coba lagi dalam beberapa detik.",
    };

    const friendlyMessage = (category && categoryMessages[category])
      ? `${categoryMessages[category]}\n> ${safe}`
      : status
        ? `❌ **AI Core Error (HTTP ${status})**\n> ${safe}`
        : `❌ **AI Core Error**\n> ${safe}`;

    await interaction[method]({
      content: friendlyMessage,
      ephemeral: true,
    }).catch(() => {});
  }
}

// ── Modal handler ──────────────────────────────────────────────────────────────

export async function handleAICoreModal(interaction) {
  if (deny(interaction)) return;

  // Access mode
  if (interaction.customId === "aicore:modal:access") {
    const mode = interaction.fields.getTextInputValue("mode").trim().toLowerCase();
    const ids  = interaction.fields.getTextInputValue("ids").split(",").map((id) => id.trim()).filter((id) => /^\d{15,25}$/.test(id));
    if (!["owner", "staff", "admin", "role", "user"].includes(mode)) {
      await interaction.reply({ content: "❌ Mode harus owner, staff, role, atau user.", ephemeral: true });
      return;
    }
    updateAICoreConfig({
      accessMode:      mode,
      allowedRoleIds:  mode === "role" ? ids : [],
      allowedUserIds:  mode === "user" ? ids : [],
    });
    await interaction.reply({ content: `✅ AI Core access disimpan: **${mode}**.`, ephemeral: true });
    return;
  }

  // API key
  if (interaction.customId === "aicore:modal:apikey") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const apiKey = interaction.fields.getTextInputValue("apiKey").trim();
      const result = await updateProviderApiKey(apiKey);

      if (result.detectionNeeded) {
        // Auto-detection failed — ask user to pick a provider
        await interaction.editReply({
          content: [
            "✅ **API KEY DISIMPAN**",
            `API Key: ${result.apiKeyMask}`,
            `Status: 🟡 Tersimpan — provider tidak dapat dideteksi otomatis`,
            "",
            "**Pilih provider yang sesuai** menggunakan tombol di panel ⚙️ AI Configuration → 🔄 Change Provider.",
          ].join("\n"),
        });
      } else {
        await interaction.editReply({
          content: [
            "✅ **API KEY DISIMPAN**",
            `Provider: **${result.provider}**`,
            `Model: \`${result.model}\``,
            `API Key: ${result.apiKeyMask}`,
            `Status: 🟡 Tersimpan — belum diuji`,
            "",
            "Gunakan tombol **🧪 Test Connection** untuk memverifikasi koneksi ke provider.",
          ].join("\n"),
        });
      }
    } catch (error) {
      const reason   = String(error?.providerReason || error?.message || "Gagal menyimpan API key.").slice(0, 240);
      const category = error?.providerCategory ? `\nCategory: \`${error.providerCategory}\`` : "";
      await interaction.editReply({ content: `❌ **API KEY GAGAL DISIMPAN**\nReason: ${reason}${category}` });
    }
    return;
  }

  // Model selection
  if (interaction.customId === "aicore:modal:model") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const model = interaction.fields.getTextInputValue("model").trim();
      await validateProviderModel(model);
      updateAICoreConfig({ model });
      await interaction.editReply({ content: `✅ Model berhasil disimpan: \`${model}\`.` });
    } catch (error) {
      await interaction.editReply({
        content: `❌ Model tidak dapat divalidasi.\n${String(error.message || "Provider rejected the model.").slice(0, 240)}`,
      });
    }
    return;
  }

  // AI settings
  if (interaction.customId === "aicore:modal:config") {
    const parseOnOff  = (v) => String(v ?? "").trim().toLowerCase() === "on";
    const parseTwo    = (raw) => String(raw ?? "").split(",").map((v) => parseOnOff(v));
    const timeoutMs   = Number.parseInt(interaction.fields.getTextInputValue("timeout").trim(),   10);
    const maxResponse = Number.parseInt(interaction.fields.getTextInputValue("maxtokens").trim(), 10);
    const [errorAnalysis, investigation] = parseTwo(interaction.fields.getTextInputValue("analysis1"));
    const [codeAnalysis, visionAnalysis] = parseTwo(interaction.fields.getTextInputValue("analysis2"));
    const conversation = parseOnOff(interaction.fields.getTextInputValue("conversation"));
    updateAICoreConfig({
      timeoutMs:    Number.isFinite(timeoutMs)   ? Math.min(120_000, Math.max(5_000, timeoutMs))   : 30_000,
      maxResponse:  Number.isFinite(maxResponse) ? Math.min(4_000,   Math.max(300,   maxResponse)) : 1_800,
      errorAnalysis,
      investigation,
      codeAnalysis,
      visionAnalysis,
      conversation,
    });
    await interaction.reply({ content: "✅ AI Core configuration disimpan secara persistent.", ephemeral: true });
  }
}
