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
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";

import { SafeError, logErr } from "../lib/safe.mjs";
import { fetchRoster, diffRoster } from "../lib/roster.mjs";
import {
  loadTemplate,
  sendBonks,
  eventLink,
  makeEmojiResolver,
  allClearMessage,
} from "../lib/bonk.mjs";

/** How long the confirm button stays live. */
const CONFIRM_WINDOW_MS = 5 * 60 * 1000;

/** Names shown in the preview before we truncate the list. */
const PREVIEW_NAME_LIMIT = 40;

/** Discord's hard cap on the number of options in a select menu. */
const MAX_CHOICES = 25;

export const data = new SlashCommandBuilder()
  .setName("bonk")
  .setDescription("DM everyone on the raid roster who hasn't signed up yet")
  // No options at all: the raid is chosen from the picker in the preview, so
  // there is nothing to type. Officers do this on phones.
  //
  // setDefaultMemberPermissions is UI-level hiding only. The real gate is the
  // officer role check below; admins can override the permission.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

/**
 * The upcoming raids, and the full first one.
 *
 * One calendar read serves both: the list endpoint returns summaries, which is
 * everything the picker needs, but not signups - so the raid actually being
 * previewed is re-fetched in full.
 */
async function loadRaids({ raidHelper, config, nowSeconds }) {
  const choices = await raidHelper.listUpcomingEvents(
    config.guildId,
    nowSeconds,
    config.raidChannelIds,
    MAX_CHOICES
  );

  if (choices.length === 0) {
    const where =
      config.raidChannelIds.length > 0
        ? ` in ${config.raidChannelIds.map((id) => `<#${id}>`).join(", ")}`
        : "";
    throw new SafeError(
      `Raid-Helper has no upcoming events${where}, so there is nothing to bonk for. ` +
        `If the raid is posted, check it is in the right channel and has not already started.`
    );
  }

  return { choices, event: await raidHelper.getEvent(choices[0].id) };
}

/**
 * Start time for a select-menu option. Components render plain text only, so
 * Discord's <t:...> stamps do not work here and the zone has to be spelled out.
 */
function formatChoiceTime(startTime) {
  if (!startTime) return "time unknown";
  return `${new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(startTime * 1000))} UTC`;
}

/**
 * The raid picker, with the current event selected.
 *
 * Ebri does this on a phone, where copying an event ID out of a raid post and
 * back into a slash command is genuinely painful. The list is the whole point:
 * the next raid is already chosen, and switching is one tap.
 */
function buildChoiceRow({ choices, event, selectId }) {
  const options = choices.map((choice) =>
    new StringSelectMenuOptionBuilder()
      .setValue(choice.id)
      .setLabel(choice.title.slice(0, 100))
      .setDescription(formatChoiceTime(choice.startTime).slice(0, 100))
      .setDefault(choice.id === event.id)
  );

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(selectId)
      .setPlaceholder(event.title.slice(0, 150))
      .addOptions(options)
  );
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
  const { config, raidHelper } = context;

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
  const { choices, event: firstEvent } = await loadRaids({ raidHelper, config, nowSeconds });
  let event = firstEvent;

  // The list only offers raids that have not started, so this should not fire.
  // It is here for the gap between reading the calendar and reading the event.
  if (event.startTime && event.startTime < nowSeconds) {
    throw new SafeError(
      `"${event.title}" already started. Reminding people now would just be rude.`
    );
  }

  // The roster is a property of the guild, not of the raid, so it survives the
  // officer switching events in the picker below.
  const { members } = await fetchRoster(interaction.guild, config);

  const selectId = `bonk:event:${interaction.id}`;
  const confirmId = `bonk:confirm:${interaction.id}`;
  const cancelId = `bonk:cancel:${interaction.id}`;

  // The whole preview-and-choose session shares one window. Switching raids is
  // not a way to keep a confirm button alive indefinitely.
  const deadline = Date.now() + CONFIRM_WINDOW_MS;

  let diff;
  let click;

  while (true) {
    diff = diffRoster({ members, signedUserIds: event.signedUserIds });

    const embed = buildPreviewEmbed({
      event,
      diff,
      config,
      guildId: interaction.guildId,
    });

    const components = [];
    if (choices.length > 1) components.push(buildChoiceRow({ choices, event, selectId }));

    if (diff.unsigned.length === 0) {
      embed.setDescription(
        (embed.data.description ? `${embed.data.description}\n\n` : "") +
          allClearMessage({ user: interaction.user, config })
      );
    } else {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(confirmId)
            .setLabel(
              `Send ${diff.unsigned.length} bonk${diff.unsigned.length === 1 ? "" : "s"}`
            )
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(cancelId)
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary)
        )
      );
    }

    const preview = await interaction.editReply({ embeds: [embed], components });

    // Nothing to send and nothing to pick from: this is the final answer.
    if (components.length === 0) return;

    const remaining = deadline - Date.now();
    try {
      if (remaining <= 0) throw new Error("window closed");
      click = await preview.awaitMessageComponent({
        // Only the officer who ran the command may confirm it.
        filter: (component) => component.user.id === interaction.user.id,
        time: remaining,
      });
    } catch {
      await interaction.editReply({
        content: "Timed out — nothing was sent.",
        embeds: [embed],
        components: [],
      });
      return;
    }

    if (click.customId === selectId) {
      // Re-fetch in full: the calendar listing carries no signups.
      await click.deferUpdate();
      event = await raidHelper.getEvent(click.values[0]);
      continue;
    }

    if (click.customId === cancelId) {
      await click.update({
        content: "Cancelled. Nothing was sent.",
        embeds: [],
        components: [],
      });
      return;
    }

    break;
  }

  await click.update({
    content: `Sending ${diff.unsigned.length} DMs…`,
    embeds: [],
    components: [],
  });

  const template = await loadTemplate();
  const resolveEmoji = makeEmojiResolver(interaction.guild);
  const result = await sendBonks({
    members: diff.unsigned,
    event,
    guildId: interaction.guildId,
    template,
    config,
    resolveEmoji,
    run: {
      id: interaction.id,
      invokedBy: { id: interaction.user.id, tag: interaction.user.tag },
    },
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
