/**
 * commands/thread.js — /thread subcommands: on, off, list
 *
 * /thread channel:#gallery on   → aktifkan auto-thread di channel tersebut
 * /thread channel:#gallery off  → nonaktifkan auto-thread
 * /thread list                  → tampilkan semua channel yang terdaftar
 *
 * Owner/Developer only.
 */

import { SlashCommandBuilder, ChannelType, EmbedBuilder } from "discord.js";
import { denyIfNotStaff } from "./permissions.js";
import { threadDB } from "../thread/threadDB.js";

export const data = new SlashCommandBuilder()
  .setName("thread")
  .setDescription("Kelola Auto Thread per channel (Owner/Developer only)")

  .addSubcommand((sub) =>
    sub
      .setName("on")
      .setDescription("Aktifkan Auto Thread di channel tertentu")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel yang akan diaktifkan Auto Thread-nya")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildNews)
          .setRequired(true),
      ),
  )

  .addSubcommand((sub) =>
    sub
      .setName("off")
      .setDescription("Nonaktifkan Auto Thread di channel tertentu")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel yang akan dinonaktifkan Auto Thread-nya")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildNews)
          .setRequired(true),
      ),
  )

  .addSubcommand((sub) =>
    sub.setName("list").setDescription("Tampilkan semua channel yang terdaftar Auto Thread"),
  );

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const sub = interaction.options.getSubcommand();

  if (sub === "on") {
    const channel = interaction.options.getChannel("channel", true);
    threadDB.enable(channel.id, interaction.guildId);
    await interaction.reply({
      content: `✅ Auto Thread diaktifkan di ${channel}.\nSetiap posting baru akan otomatis dibuat thread bernama **Chat Disini**.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "off") {
    const channel = interaction.options.getChannel("channel", true);
    threadDB.disable(channel.id);
    await interaction.reply({
      content: `✅ Auto Thread dinonaktifkan di ${channel}.`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "list") {
    const allChannels = threadDB.getAll(interaction.guildId);

    if (allChannels.length === 0) {
      await interaction.reply({
        content: "📭 Belum ada channel yang terdaftar Auto Thread.\nGunakan `/thread on channel:#nama-channel` untuk mengaktifkan.",
        ephemeral: true,
      });
      return;
    }

    const lines = allChannels.map(({ channelId, enabled }) => {
      const dot = enabled ? "🟢" : "🔴";
      return `${dot} <#${channelId}>`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🧵 Auto Thread")
      .setDescription(lines.join("\n"))
      .addFields({
        name: "━━━━━━━━━━",
        value: `Total Channel : **${allChannels.length}**\n\n🟢 = ON  |  🔴 = OFF`,
        inline: false,
      })
      .setFooter({ text: "Pangeran Assistant AI • Auto Thread" })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}
