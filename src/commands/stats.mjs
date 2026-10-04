/**
 * /stats - who has been bonked the most, from logs/bonks.jsonl.
 *
 * Same audience as /bonk (officers), because the list names people. The reply
 * is private by default; `share: True` posts it in the channel instead.
 * Read-only: nothing is sent to anyone and Raid-Helper is not contacted.
 */

import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

import { readBonkLog, computeStats, renderLeaderboard } from "../lib/stats.mjs";

/** People on the board; the rest are summed up in one line. */
const LEADERBOARD_LIMIT = 15;

const DAY_MS = 24 * 60 * 60 * 1000;

const PERIODS = {
  all: { label: "all time", days: null },
  "30d": { label: "the last 30 days", days: 30 },
  "7d": { label: "the last 7 days", days: 7 },
};

export const data = new SlashCommandBuilder()
  .setName("stats")
  .setDescription("Who has been bonked the most")
  .addStringOption((option) =>
    option
      .setName("period")
      .setDescription("Which bonks to count (default: all time)")
      .addChoices(
        { name: "All time", value: "all" },
        { name: "Last 30 days", value: "30d" },
        { name: "Last 7 days", value: "7d" }
      )
  )
  .addBooleanOption((option) =>
    option
      .setName("share")
      .setDescription("Post it in the channel instead of only showing it to you")
  )
  // UI-level hiding only, as for /bonk. The real gate is the officer role check.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

function formatDay(iso) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(iso)
  );
}

export function buildStatsEmbed(stats, { periodLabel }) {
  const embed = new EmbedBuilder().setTitle("🔨 Most Bonked").setColor(0xd95926);

  if (stats.totals.sent === 0) {
    return embed.setDescription(`No bonks delivered in ${periodLabel}. Everyone signed up. 🎉`);
  }

  const champ = stats.leaderboard[0];
  const coChamps = stats.leaderboard.filter((row) => row.rank === 1);
  const range = `${formatDay(stats.firstAt)} – ${formatDay(stats.lastAt)}`;

  embed.setDescription(
    (coChamps.length === 1
      ? `👑 **${champ.name}** leads with **${champ.count}** bonk${champ.count === 1 ? "" : "s"}` +
        ` across ${champ.raids} raid${champ.raids === 1 ? "" : "s"}.`
      : `👑 Shared top spot with **${champ.count}** bonks: ${coChamps.map((row) => `**${row.name}**`).join(", ")}.`) +
      `\n-# Counting ${periodLabel} (${range})`
  );

  embed.addFields({
    name: "Leaderboard",
    value: `\`\`\`\n${renderLeaderboard(stats.leaderboard, { limit: LEADERBOARD_LIMIT })}\n\`\`\``,
  });

  const rest = stats.leaderboard.slice(LEADERBOARD_LIMIT);
  if (rest.length > 0) {
    embed.addFields({
      name: `Also bonked (${rest.length})`,
      value: rest
        .map((row) => `${row.name} ${row.count}`)
        .join(" · ")
        .slice(0, 1000),
    });
  }

  const topRaid = stats.byRaid[0];
  embed.addFields(
    { name: "Bonks delivered", value: `${stats.totals.sent}`, inline: true },
    { name: "Raiders bonked", value: `${stats.totals.people}`, inline: true },
    { name: "Raids", value: `${stats.totals.raids}`, inline: true },
    { name: "Most bonked raid", value: `${topRaid.title} (${topRaid.count})`, inline: true },
    { name: "Bounced", value: `${stats.totals.failed}`, inline: true }
  );

  return embed.setFooter({ text: "Sign up early, avoid the bonk." });
}

export async function execute(interaction, context) {
  const { config } = context;

  if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
    await interaction.reply({
      content: "This command only works in the configured guild.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Same gate as /bonk, checked server-side on every invocation.
  if (!interaction.member.roles.cache.has(config.officerRoleId)) {
    await interaction.reply({
      content: "Only officers can use `/stats`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const share = interaction.options.getBoolean("share") ?? false;
  const period = PERIODS[interaction.options.getString("period") ?? "all"] ?? PERIODS.all;

  await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });

  const { entries } = await readBonkLog();
  const sinceMs = period.days === null ? null : Date.now() - period.days * DAY_MS;
  const stats = computeStats(entries, { sinceMs });

  await interaction.editReply({ embeds: [buildStatsEmbed(stats, { periodLabel: period.label })] });
}
