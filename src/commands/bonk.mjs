/**
 * /bonk - remind everyone on the raid roster who has not signed up yet.
 *
 * The flow is always preview-then-confirm. There is no flag that sends
 * immediately, because the destructive-ish step here (DMing real people) cannot
 * be undone, and the button is this repo's equivalent of the CONFIRM_DELETE
 * phrase the one-shot scripts require.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

import { SafeError, isSnowflake, logErr } from "../lib/safe.mjs";
import { fetchRoster, diffRoster } from "../lib/roster.mjs";
import { loadTemplate, sendBonks, eventLink } from "../lib/bonk.mjs";

/** How long the confirm button stays live. */
const CONFIRM_WINDOW_MS = 5 * 60 * 1000;

/** Names shown in the preview before we truncate the list. */
const PREVIEW_NAME_LIMIT = 40;

export const data = new SlashCommandBuilder()
  .setName("bonk")
  .setDescription("DM everyone on the raid roster who hasn't signed up yet")
  .addStringOption((option) =>
    option
      .setName("event")
      .setDescription("Raid-Helper event ID or message link (default: the next raid)")
      .setRequired(false)
  )
  // UI-level hiding only. The real gate is the officer role check below;
  // default_member_permissions can be overridden by server admins.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

/** Accepts a raw event id or a full Discord message link. */
function parseEventOption(raw) {
  const value = raw.trim();
  if (isSnowflake(value)) return value;

  const link = value.match(/channels\/\d{17,20}\/\d{17,20}\/(\d{17,20})/);
  if (link) return link[1];

  throw new SafeError(
    "That doesn't look like an event ID or a message link. Right-click the raid " +
      "post and choose Copy Message ID (or Copy Message Link)."
  );
}

async function resolveEvent(interaction, { raidHelper, config, nowSeconds }) {
  const option = interaction.options.getString("event");

  if (option) {
    const event = await raidHelper.getEvent(parseEventOption(option));
    if (event.serverId && event.serverId !== config.guildId) {
      throw new SafeError(
        `That event belongs to a different Discord server (${event.serverId}). ` +
          `Refusing to continue.`
      );
    }
    // Applies to an explicitly named event too: pasting the wrong link is
    // exactly the mistake this guard exists to catch.
    if (
      config.raidChannelIds.length > 0 &&
      event.channelId &&
      !config.raidChannelIds.includes(event.channelId)
    ) {
      throw new SafeError(
        `That event is in <#${event.channelId}>, which is not a raid signup channel. ` +
          `Only events in ${config.raidChannelIds.map((id) => `<#${id}>`).join(", ")} ` +
          `can be bonked. Change RAID_CHANNEL_IDS if that is wrong.`
      );
    }
    return event;
  }

  const event = await raidHelper.findNextEvent(
    config.guildId,
    nowSeconds,
    config.raidChannelIds
  );
  if (!event) {
    const where =
      config.raidChannelIds.length > 0
        ? ` in ${config.raidChannelIds.map((id) => `<#${id}>`).join(", ")}`
        : "";
    throw new SafeError(
      `Raid-Helper has no upcoming events${where}. If the raid is posted, pass it ` +
        "explicitly with the `event:` option."
    );
  }
  return event;
}

function buildPreviewEmbed({ event, diff, config, guildId }) {
  const link = eventLink(guildId, event.channelId, event.id);
  const names = diff.unsigned.map((member) => member.displayName);
  const shown = names.slice(0, PREVIEW_NAME_LIMIT);
  const hidden = names.length - shown.length;

  const embed = new EmbedBuilder()
    .setTitle(`Unsigned for: ${event.title}`)
    .setColor(diff.unsigned.length === 0 ? 0x2ecc71 : 0xe67e22)
    .addFields(
      { name: "Roster", value: `${diff.rosterSize}`, inline: true },
      { name: "Signed up", value: `${diff.signedCount}`, inline: true },
      { name: "Unsigned", value: `${diff.unsigned.length}`, inline: true }
    );

  if (event.startTime) {
    embed.setDescription(`Starts <t:${event.startTime}:F> (<t:${event.startTime}:R>)`);
  }
  if (link) embed.setURL(link);

  if (shown.length > 0) {
    embed.addFields({
      name: "Will be DMed",
      value:
        shown.join(", ").slice(0, 1000) +
        (hidden > 0 ? `\n…and ${hidden} more (all ${names.length} will be DMed)` : ""),
    });
  }

  if (diff.skipped.length > 0) {
    embed.addFields({
      name: "Skipped (already reminded for this event)",
      value: diff.skipped
        .map((member) => member.displayName)
        .join(", ")
        .slice(0, 1000),
    });
  }

  embed.setFooter({ text: `Event ${event.id} · ${config.dmDelayMs}ms between DMs` });
  return embed;
}

function buildResultEmbed({ event, result }) {
  const embed = new EmbedBuilder()
    .setTitle(`Bonked: ${event.title}`)
    .setColor(result.failures.length > 0 ? 0xe74c3c : 0x2ecc71)
    .addFields(
      { name: "Sent", value: `${result.sent.length}`, inline: true },
      { name: "Failed", value: `${result.failures.length}`, inline: true },
      { name: "Skipped", value: `${result.skipped.length}`, inline: true }
    );

  const realFailures = result.failures.filter((failure) => failure.member);
  if (realFailures.length > 0) {
    // Mentions rather than names, so an officer can copy-paste and chase them.
    embed.addFields({
      name: "Could not DM — chase these by hand",
      value: realFailures
        .map((failure) => `${failure.member} (${failure.reason})`)
        .join("\n")
        .slice(0, 1000),
    });
  }

  if (result.skipped.length > 0) {
    embed.addFields({
      name: "Skipped since the preview",
      value: result.skipped
        .map((entry) => `${entry.member.displayName}: ${entry.reason}`)
        .join("\n")
        .slice(0, 1000),
    });
  }

  return embed;
}

export async function execute(interaction, context) {
  const { config, raidHelper, state } = context;

  if (!interaction.inGuild() || interaction.guildId !== config.guildId) {
    await interaction.reply({
      content: "This command only works in the configured guild.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The real permission gate. Checked server-side, every single invocation.
  if (!interaction.member.roles.cache.has(config.officerRoleId)) {
    await interaction.reply({
      content: "Only officers can use `/bonk`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const event = await resolveEvent(interaction, { raidHelper, config, nowSeconds });

  if (event.startTime && event.startTime < nowSeconds) {
    throw new SafeError(
      `"${event.title}" already started. Reminding people now would just be rude.`
    );
  }

  const { members } = await fetchRoster(interaction.guild, config);
  const diff = diffRoster({
    members,
    signedUserIds: event.signedUserIds,
    alreadyBonked: state.bonkedFor(event.id),
  });

  const embed = buildPreviewEmbed({
    event,
    diff,
    config,
    guildId: interaction.guildId,
  });

  if (diff.unsigned.length === 0) {
    embed.setDescription(
      (embed.data.description ? `${embed.data.description}\n\n` : "") +
        "Everyone on the roster has answered. Nothing to do."
    );
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (diff.unsigned.length > config.maxDm) {
    throw new SafeError(
      `${diff.unsigned.length} people are unsigned, which is over the MAX_DM cap of ` +
        `${config.maxDm}. That is a lot of DMs to send at once — if it is genuinely ` +
        `intended, set MAX_DM=${diff.unsigned.length} in .env and restart the bot.`
    );
  }

  const confirmId = `bonk:confirm:${interaction.id}`;
  const cancelId = `bonk:cancel:${interaction.id}`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel(`Send ${diff.unsigned.length} bonk${diff.unsigned.length === 1 ? "" : "s"}`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  const preview = await interaction.editReply({ embeds: [embed], components: [row] });

  let click;
  try {
    click = await preview.awaitMessageComponent({
      componentType: ComponentType.Button,
      // Only the officer who ran the command may confirm it.
      filter: (button) => button.user.id === interaction.user.id,
      time: CONFIRM_WINDOW_MS,
    });
  } catch {
    await interaction.editReply({
      content: "Timed out — nothing was sent.",
      embeds: [embed],
      components: [],
    });
    return;
  }

  if (click.customId === cancelId) {
    await click.update({ content: "Cancelled. Nothing was sent.", embeds: [], components: [] });
    return;
  }

  await click.update({
    content: `Sending ${diff.unsigned.length} DMs…`,
    embeds: [],
    components: [],
  });

  const template = await loadTemplate();
  const result = await sendBonks({
    members: diff.unsigned,
    event,
    guildId: interaction.guildId,
    template,
    config,
    state,
    onProgress: async (done, total) => {
      await interaction.editReply({ content: `Sending DMs… ${done}/${total}` });
    },
  });

  await interaction.editReply({
    content: "",
    embeds: [buildResultEmbed({ event, result })],
    components: [],
  });

  logErr(
    `/bonk by ${interaction.user.tag}: event ${event.id}, sent ${result.sent.length}, ` +
      `failed ${result.failures.length}, skipped ${result.skipped.length}`
  );
}
