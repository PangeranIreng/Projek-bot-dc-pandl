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
  testProviderConnection, validateProviderModel,
} from "./core.js";
import { logger } from "../../utils/logger.js";

const COLOR = 0x7c3aed;

function deny(interaction) {
  if (isOwner(interaction.member)) return false;
  void interaction.reply({ content: "❌ Hanya Owner yang dapat mengelola AI Core.", ephemeral: true }).catch(() => {});
  return true;
}

function panelEmbed(note = "") {
  const status = getAICoreStatus();
  const cfg = getAICoreConfig();
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("👑 AI CORE")
    .setDescription(`**CENTRAL INTELLIGENCE**${note ? `\n\n${note}` : ""}`)
    .addFields(
      { name: "Status", value: status.online ? "🟢 ONLINE" : "🟡 Menunggu bot login", inline: true },
      { name: "Project Knowledge", value: status.knowledgeReady ? `🟢 READY (${status.fileCount} files)` : "🟡 Belum dibuat", inline: true },
      { name: "Error Analyzer", value: cfg.errorAnalysis ? "🟢 ENABLED" : "⚪ DISABLED", inline: true },
      { name: "Vision Analyzer", value: cfg.visionAnalysis ? "🟢 ENABLED" : "⚪ DISABLED", inline: true },
      { name: "Fix Generator", value: "🟢 ENABLED", inline: true },
      { name: "Provider", value: `${providerStatusLabel(status.providerStatus)} ${cfg.provider} / ${cfg.model}`, inline: true },
      { name: "❌ Error AI Channel", value: cfg.errorChannelId ? `<#${cfg.errorChannelId}>` : "Belum diatur", inline: false },
      { name: "💬 Investigation Channel", value: cfg.investigationChannelId ? `<#${cfg.investigationChannelId}>` : "Belum diatur", inline: false },
      { name: "🔐 Access", value: cfg.accessMode === "owner" ? "Owner Only" : cfg.accessMode, inline: true },
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

function providerStatusLabel(status) {
  return {
    configured: "🟢 CONFIGURED",
    validating: "🟡 VALIDATING",
    invalid: "🔴 INVALID",
    provider_error: "🟠 PROVIDER ERROR",
    model_error: "🔴 MODEL ERROR",
    network_error: "🟠 NETWORK ERROR",
    connected: "🟢 CONNECTED",
    not_configured: "🔴 NOT CONFIGURED",
  }[status] || "🟡 UNKNOWN";
}

function providerConfigEmbed(note = "") {
  const cfg = getProviderConfiguration();
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle("⚙️ AI CONFIGURATION")
    .setDescription(`${note ? `${note}\n\n` : ""}Pengaturan provider AI Core disimpan secara aman dan hanya dapat dikelola Owner.`)
    .addFields(
      { name: "Provider", value: `🟢 ${cfg.provider}`, inline: true },
      { name: "API Key", value: `${providerStatusLabel(cfg.status)}\n${cfg.apiKeyMask}`, inline: true },
      { name: "Connection", value: providerStatusLabel(cfg.status), inline: true },
      { name: "Model", value: `\`${cfg.model}\``, inline: true },
      { name: "Error Analysis", value: cfg.errorAnalysis ? "🟢 ON" : "⚪ OFF", inline: true },
      { name: "Investigation", value: cfg.investigation ? "🟢 ON" : "⚪ OFF", inline: true },
      { name: "Code Analysis", value: cfg.codeAnalysis ? "🟢 ON" : "⚪ OFF", inline: true },
      { name: "Vision Analysis", value: cfg.visionAnalysis ? "🟢 ON" : "⚪ OFF", inline: true },
      { name: "Fix Generator", value: "🟢 ON", inline: true },
      ...(cfg.statusReason ? [{ name: "Provider note", value: cfg.statusReason, inline: false }] : []),
    )
    .setFooter({ text: "API key tidak pernah ditampilkan lengkap atau dikirim ke channel." })
    .setTimestamp();
}

function providerConfigComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("aicore:provider:apikey").setLabel("🔑 Change API Key").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("aicore:provider:test").setLabel("🧪 Test Connection").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("aicore:provider:model").setLabel("🧠 Change Model").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("aicore:provider:settings").setLabel("⚙️ AI Settings").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("aicore:provider:remove").setLabel("🗑️ Remove API Key").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("aicore:setup").setLabel("🔙 AI Core").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function buildAICoreEmbed() {
  return panelEmbed();
}

export function buildAICoreComponents() {
  return panelComponents();
}

export async function handleAICoreInteraction(interaction) {
  const id = interaction.customId ?? "";
  try {
    if (id.startsWith("aicore:fix:")) {
      if (!isAICoreAllowed(interaction.member)) return void interaction.reply({ content: "❌ Kamu tidak memiliki akses ke AI Core.", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      const prompt = await generateFixPrompt(id.slice("aicore:fix:".length));
      await interaction.editReply({ content: `🛠️ **FIX REQUEST**\n\`\`\`md\n${prompt.slice(0, 3800)}\n\`\`\`` });
      return;
    }
    if (deny(interaction)) return;

    if (id === "aicore:setup" || id === "aicore:refresh") {
      await interaction.update({ embeds: [panelEmbed()], components: panelComponents() });
      return;
    }
    if (id === "aicore:back") {
      const { buildMainSetupEmbed, buildMainSetupComponents } = await import("../setup/adminSetup.js");
      await interaction.update({ embeds: [buildMainSetupEmbed()], components: buildMainSetupComponents() });
      return;
    }
    if (id === "aicore:channels") {
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle("📢 AI CHANNELS").setDescription("Kies een kanaal per functie. Konfigurasi tersimpan persistent.")],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("aicore:channel:error").setLabel("❌ Set Error AI Channel").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("aicore:channel:investigation").setLabel("💬 Set Investigation Channel").setStyle(ButtonStyle.Primary),
          ),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("aicore:setup").setLabel("🔙 Kembali ke AI Core").setStyle(ButtonStyle.Secondary)),
        ],
      });
      return;
    }
    const channelAction = /^aicore:channel:(error|investigation)$/.exec(id);
    if (channelAction) {
      const kind = channelAction[1];
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle("📢 Pilih Channel").setDescription(`Pilih channel untuk **${kind === "error" ? "Error AI" : "Investigation"}**.`)],
        components: [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId(`aicore:channel:select:${kind}`).setPlaceholder("Pilih channel text...").addChannelTypes(ChannelType.GuildText),
          ),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("aicore:channels").setLabel("🔙 Kembali").setStyle(ButtonStyle.Secondary)),
        ],
      });
      return;
    }
    const channelSelect = /^aicore:channel:select:(error|investigation)$/.exec(id);
    if (channelSelect && interaction.isChannelSelectMenu()) {
      updateAICoreConfig({ [`${channelSelect[1] === "error" ? "error" : "investigation"}ChannelId`]: interaction.values[0] });
      await interaction.update({ embeds: [panelEmbed("✅ Channel berhasil disimpan.")], components: panelComponents() });
      return;
    }
    if (id === "aicore:access") {
      const cfg = getAICoreConfig();
      const modal = new ModalBuilder().setCustomId("aicore:modal:access").setTitle("AI Core Access");
      const mode = new TextInputBuilder().setCustomId("mode").setLabel("Mode: owner / staff / role / user").setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.accessMode);
      const ids = new TextInputBuilder().setCustomId("ids").setLabel("Role/User IDs (comma-separated; optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue([...(cfg.allowedRoleIds ?? []), ...(cfg.allowedUserIds ?? [])].join(","));
      modal.addComponents(new ActionRowBuilder().addComponents(mode), new ActionRowBuilder().addComponents(ids));
      await interaction.showModal(modal);
      return;
    }
    if (id === "aicore:config") {
      await interaction.update({ embeds: [providerConfigEmbed()], components: providerConfigComponents() });
      return;
    }
    if (id === "aicore:provider:apikey") {
      const modal = new ModalBuilder().setCustomId("aicore:modal:apikey").setTitle("🔐 UPDATE AI API KEY");
      const key = new TextInputBuilder()
        .setCustomId("apiKey")
        .setLabel("Masukkan API key baru")
        .setPlaceholder("API key diproses privat dan tidak dikirim sebagai message")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(20);
      modal.addComponents(new ActionRowBuilder().addComponents(key));
      await interaction.showModal(modal);
      return;
    }
    if (id === "aicore:provider:model") {
      const cfg = getProviderConfiguration();
      const modal = new ModalBuilder().setCustomId("aicore:modal:model").setTitle("🧠 SELECT AI MODEL");
      const model = new TextInputBuilder()
        .setCustomId("model")
        .setLabel("Model provider")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(cfg.model || "gpt-5.4-mini");
      modal.addComponents(new ActionRowBuilder().addComponents(model));
      await interaction.showModal(modal);
      return;
    }
    if (id === "aicore:provider:settings") {
      const cfg = getAICoreConfig();
      const modal = new ModalBuilder().setCustomId("aicore:modal:config").setTitle("AI Core Configuration");
      const limits = new TextInputBuilder().setCustomId("limits").setLabel("Timeout ms, max response chars").setStyle(TextInputStyle.Short).setRequired(true).setValue(`${cfg.timeoutMs}, ${cfg.maxResponse}`);
      const flags = new TextInputBuilder().setCustomId("flags").setLabel("error, investigation, code, vision (on/off)").setStyle(TextInputStyle.Short).setRequired(true).setValue([cfg.errorAnalysis, cfg.investigation, cfg.codeAnalysis, cfg.visionAnalysis].map((v) => v ? "on" : "off").join(","));
      modal.addComponents(new ActionRowBuilder().addComponents(limits), new ActionRowBuilder().addComponents(flags));
      await interaction.showModal(modal);
      return;
    }
    if (id === "aicore:provider:test") {
      await interaction.deferReply({ ephemeral: true });
      const result = await testProviderConnection();
      await interaction.editReply({
        content: result.ok
          ? `🧪 **AI CONNECTION TEST**\nProvider: **${result.configuration.provider}**\nStatus: 🟢 SUCCESS\nAI Core: 🟢 READY\nModel: \`${result.configuration.model}\``
          : `🧪 **AI CONNECTION TEST**\nProvider: **${result.configuration.provider}**\nStatus: 🔴 FAILED\nReason: ${result.reason}`,
      });
      return;
    }
    if (id === "aicore:provider:remove") {
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(COLOR).setTitle("⚠️ REMOVE AI API KEY?").setDescription("API key provider akan dihapus dari secure storage. Project Knowledge, channel configuration, error history, dan AI Core tetap dipertahankan.")],
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
      await interaction.update({ embeds: [providerConfigEmbed("✅ API key dihapus. AI Core tetap berjalan dalam fallback/local mode.")], components: providerConfigComponents() });
      return;
    }
    if (id === "aicore:knowledge") {
      await interaction.deferUpdate();
      const knowledge = rebuildKnowledge();
      await interaction.editReply({ embeds: [panelEmbed(`✅ Project Knowledge diperbarui: ${knowledge.summary.fileCount} file di-index.`)], components: panelComponents() });
      return;
    }
    if (id === "aicore:test") {
      const cfg = getAICoreConfig();
      const targets = [cfg.errorChannelId, cfg.investigationChannelId].filter(Boolean);
      let sent = 0;
      for (const channelId of new Set(targets)) {
        const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send("🧪 **AI CORE TEST** — Channel connection aktif.").catch(() => {});
          sent++;
        }
      }
      await interaction.reply({ content: `✅ Test selesai. ${sent} channel berhasil diuji.`, ephemeral: true });
    }
  } catch (err) {
    logger.warn("[AI Core] Setup interaction failed.");
    const method = interaction.deferred ? "editReply" : interaction.replied ? "followUp" : "reply";
    await interaction[method]({ content: "❌ AI Core setup gagal diproses.", ephemeral: true }).catch(() => {});
  }
}

export async function handleAICoreModal(interaction) {
  if (deny(interaction)) return;
  if (interaction.customId === "aicore:modal:access") {
    const mode = interaction.fields.getTextInputValue("mode").trim().toLowerCase();
    const ids = interaction.fields.getTextInputValue("ids").split(",").map((id) => id.trim()).filter((id) => /^\d{15,25}$/.test(id));
    if (!["owner", "staff", "admin", "role", "user"].includes(mode)) {
      await interaction.reply({ content: "❌ Mode harus owner, staff, role, atau user.", ephemeral: true });
      return;
    }
    updateAICoreConfig({ accessMode: mode, allowedRoleIds: mode === "role" ? ids : [], allowedUserIds: mode === "user" ? ids : [] });
    await interaction.reply({ content: `✅ AI Core access disimpan: **${mode}**.`, ephemeral: true });
    return;
  }
  if (interaction.customId === "aicore:modal:apikey") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const apiKey = interaction.fields.getTextInputValue("apiKey");
      const result = await updateProviderApiKey(apiKey);
      await interaction.editReply({
        content: `✅ **AI API KEY UPDATED**\nProvider: **${result.provider}**\nStatus: 🟢 Connected\nModel: \`${result.model}\`\nAPI Key: ${result.apiKeyMask}\nAI Core: 🟢 ONLINE`,
      });
    } catch (error) {
      const reason = String(error?.providerReason || error?.message || "Provider request failed.").slice(0, 240);
      const category = error?.providerCategory ? `\nCategory: \`${error.providerCategory}\`` : "";
      const status = error?.httpStatus ? `\nHTTP status: \`${error.httpStatus}\`` : "";
      const providerStatus = providerStatusLabel(error?.providerStatus || "provider_error");
      await interaction.editReply({
        content: `❌ **AI PROVIDER VALIDATION FAILED**\nProvider: **OpenAI**\nStatus: ${providerStatus}\nReason: ${reason}${category}${status}`,
      });
    }
    return;
  }
  if (interaction.customId === "aicore:modal:model") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const model = interaction.fields.getTextInputValue("model").trim();
      await validateProviderModel(model);
      updateAICoreConfig({ model });
      await interaction.editReply({ content: `✅ Model berhasil disimpan: \`${model}\`.` });
    } catch (error) {
      await interaction.editReply({ content: `❌ Model tidak dapat divalidasi. ${String(error.message || "Provider rejected the model.").slice(0, 240)}` });
    }
    return;
  }
  if (interaction.customId === "aicore:modal:config") {
    const [timeoutMs, maxResponse] = interaction.fields.getTextInputValue("limits").split(",").map((v) => Number.parseInt(v.trim(), 10));
    const flags = interaction.fields.getTextInputValue("flags").split(",").map((v) => v.trim().toLowerCase() === "on");
    updateAICoreConfig({
      timeoutMs: Number.isFinite(timeoutMs) ? Math.min(120000, Math.max(5000, timeoutMs)) : 30000,
      maxResponse: Number.isFinite(maxResponse) ? Math.min(4000, Math.max(300, maxResponse)) : 1800,
      errorAnalysis: flags[0] ?? true,
      investigation: flags[1] ?? true,
      codeAnalysis: flags[2] ?? true,
      visionAnalysis: flags[3] ?? true,
    });
    await interaction.reply({ content: "✅ AI Core configuration disimpan secara persistent.", ephemeral: true });
  }
}