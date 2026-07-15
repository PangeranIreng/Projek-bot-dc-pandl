/**
 * commands/setclaimticket.js — /setclaimticket channel role
 *
 * Mengatur channel Staff Control untuk sistem Ticket.
 * Saat user membuka Ticket, bot mengirim notifikasi ke channel ini
 * dengan tombol Claim / Close / Transcript / Delete.
 *
 * Tidak mengubah /cticket, /setlogticket, atau konfigurasi lama.
 * Owner/Developer only.
 */

import { SlashCommandBuilder, ChannelType } from "discord.js";
import { denyIfNotStaff } from "./permissions.js";
import { ticketDB } from "../ticket/ticketDB.js";

export const data = new SlashCommandBuilder()
  .setName("setclaimticket")
  .setDescription("Atur channel Staff Control untuk notifikasi & tombol Ticket (Owner/Developer only)")
  .addChannelOption((opt) =>
    opt
      .setName("channel")
      .setDescription("Channel Staff Control tempat notifikasi & tombol Ticket dikirim")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true),
  )
  .addRoleOption((opt) =>
    opt
      .setName("role")
      .setDescription("Role yang di-mention di notifikasi Staff Control")
      .setRequired(true),
  );

export async function execute(interaction) {
  if (await denyIfNotStaff(interaction)) return;

  const channel = interaction.options.getChannel("channel", true);
  const role    = interaction.options.getRole("role", true);

  ticketDB.setConfig({
    claimChannelId: channel.id,
    claimRoleId:    role.id,
  });

  await interaction.reply({
    content: [
      "✅ **Staff Control Ticket telah dikonfigurasi!**",
      "",
      `📌 **Channel Staff Control:** ${channel}`,
      `🔔 **Role Notification:** ${role}`,
      "",
      "Mulai sekarang, setiap kali ada user yang membuka Ticket,",
      `bot akan mengirim notifikasi ke ${channel} dengan tombol **Claim**, **Close**, **Transcript**, dan **Delete**.`,
    ].join("\n"),
    ephemeral: true,
  });
}
