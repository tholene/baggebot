/**
 * /missing - who in a role has not reacted to (or voted on) a post yet.
 *
 * Officers ask for "all raiders to respond to this one" and then have to count
 * by hand. This does the counting and posts the answer to
 * MISSING_REPORT_CHANNEL_ID for the other officers.
 *
 * Read-only towards members: nobody is DMed or pinged. The only write is the
 * report itself.
 */

import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  ReactionType,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

import { SafeError, logErr } from "../lib/safe.mjs";
import { fetchRoster, diffRoster } from "../lib/roster.mjs";
import { parseMessageRef, buildMissingReport } from "../lib/missing.mjs";

/** Discord's page size for reaction users and poll voters. */
const PAGE = 100;

/** Discord's cap on answers in one poll. */
const MAX_POLL_ANSWERS = 10;

export const data = new SlashCommandBuilder()
  .setName("missing")
  .setDescription("Who in a role hasn't reacted to or voted on a post yet")
  .addStringOption((option) =>
    option
      .setName("post")
      .setDescription("Link to the post (Copy Message Link), or its message ID")
      .setRequired(true)
  )
  .addRoleOption((option) =>
    option.setName("role").setDescription("Who should have responded (default: the raider role)")
  )
  // UI-level hiding only, as for /bonk. The real gate is the officer role check.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setDMPermission(false);

/** Every page of a paginated user list, as a set of IDs. */
async function fetchAllUserIds(fetchPage) {
  const ids = new Set();
  let after;
  while (true) {
    const users = await fetchPage({ limit: PAGE, after });
    for (const user of users) ids.add(user.id);
    if (users.length < PAGE) return ids;
    after = users[users.length - 1].id;
  }
}

/**
 * Find the message. A link names its channel; a bare ID is tried in the
 * channel the command was run in, then in every channel and active thread the
 * bot can read.
 */
async function findMessage(interaction, ref) {
  const { guild } = interaction;

  if (ref.channelId) {
    // Through the client rather than the guild, so a link into a thread works too.
    const channel = await interaction.client.channels.fetch(ref.channelId).catch(() => null);
    const message =
      channel?.guildId === guild.id
        ? await channel.messages?.fetch(ref.messageId).catch(() => null)
        : null;
    if (!message) {
      throw new SafeError(
        "I can't open that post. Check the link, and that I can see the channel " +
          "(View Channel and Read Message History)."
      );
    }
    return message;
  }

  const candidates = [];
  if (interaction.channel) candidates.push(interaction.channel);
  const channels = await guild.channels.fetch();
  const { threads } = await guild.channels.fetchActiveThreads();
  for (const channel of [...channels.values(), ...threads.values()]) {
    if (!channel || channel.id === interaction.channelId) continue;
    if (!channel.isTextBased() || channel.type === ChannelType.GuildVoice) continue;
    if (!channel.viewable) continue;
    candidates.push(channel);
  }

  for (const channel of candidates) {
    const message = await channel.messages?.fetch(ref.messageId).catch(() => null);
    if (message) return message;
  }

  throw new SafeError(
    `No message ${ref.messageId} in any channel I can read. Paste the message link ` +
      "instead (long-press the post → Copy Message Link)."
  );
}

/**
 * Poll voters, or null when the post is not a poll.
 *
 * Without the Message Content intent Discord leaves `message.poll` empty for
 * other people's posts, so when it is missing the answers are probed by ID:
 * they are numbered from 1, at most 10. Probing stops at the first error, and
 * the post only counts as a poll if somebody voted.
 */
async function fetchPollVoters(message) {
  const rest = message.client.rest;
  const answerIds = message.poll
    ? [...message.poll.answers.keys()]
    : Array.from({ length: MAX_POLL_ANSWERS }, (_, index) => index + 1);

  const voters = new Set();
  for (const answerId of answerIds) {
    let ids;
    try {
      ids = await fetchAllUserIds(async ({ limit, after }) => {
        const data = await rest.get(
          Routes.pollAnswerVoters(message.channelId, message.id, answerId),
          { query: new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) }) }
        );
        return data.users ?? [];
      });
    } catch (error) {
      if (message.poll) throw error;
      break; // Probed past the last answer, or this is not a poll at all.
    }
    for (const id of ids) voters.add(id);
  }
  return message.poll || voters.size > 0 ? voters : null;
}

/** Everyone who responded, plus per-emoji and poll counts for the report. */
async function collectResponses(message) {
  const responders = new Set([message.author.id]);
  const reactions = [];

  for (const reaction of message.reactions.cache.values()) {
    const fetchType = (type) =>
      fetchAllUserIds(async (options) => [
        ...(await reaction.users.fetch({ ...options, type })).values(),
      ]);
    const users = await fetchType(ReactionType.Normal);
    // Super reactions are listed separately; skip the extra call when there are none.
    if ((reaction.countDetails?.burst ?? 0) > 0) {
      for (const id of await fetchType(ReactionType.Burst)) users.add(id);
    }
    for (const id of users) responders.add(id);
    reactions.push({ emoji: reaction.emoji.toString(), count: users.size });
  }

  const voters = await fetchPollVoters(message);
  for (const id of voters ?? []) responders.add(id);

  return { responders, reactions, pollVotes: voters ? voters.size : null };
}

/**
 * Post the report to MISSING_REPORT_CHANNEL_ID, if set. Never throws: the
 * officer still gets the result privately when posting fails.
 *
 * @returns null when no channel is configured, else { url } or { reason }
 */
async function postReport({ interaction, config, embed }) {
  const channelId = config.missingReportChannelId;
  if (!channelId) return null;

  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel || channel.guildId !== config.guildId || typeof channel.send !== "function") {
      return { reason: `<#${channelId}> is not a text channel or thread in this server.` };
    }
    const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return { url: message.url };
  } catch (error) {
    logErr(`/missing report to ${channelId} failed: ${error?.message ?? error}`);
    const reason =
      error?.code === 50001 || error?.code === 50013
        ? `the bot lacks permission to post in <#${channelId}>.`
        : `${error?.message ?? "unknown error"}.`;
    return { reason };
  }
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
      content: "Only officers can use `/missing`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ref = parseMessageRef(interaction.options.getString("post", true));
  if (!ref) {
    throw new SafeError(
      "That doesn't look like a message link or ID. Long-press the post → Copy Message Link."
    );
  }
  if (ref.guildId && ref.guildId !== config.guildId) {
    throw new SafeError("That post is in a different server.");
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const roleId = interaction.options.getRole("role")?.id ?? config.raiderRoleId;
  // Trials, socials and alt-only members are left off the raider roster for
  // /bonk, and the same people are not expected to answer "all raiders".
  // Any other role is taken as it is.
  const { members } = await fetchRoster(interaction.guild, {
    raiderRoleId: roleId,
    excludeRoleIds: roleId === config.raiderRoleId ? config.excludeRoleIds : [],
  });

  const message = await findMessage(interaction, ref);
  const responses = await collectResponses(message);
  const diff = diffRoster({ members, signedUserIds: responses.responders });

  const embed = buildMissingReport({
    post: {
      url: message.url,
      channelId: message.channelId,
      content: message.content,
    },
    roleId,
    diff,
    responses,
    invokedBy: interaction.user,
  });

  const report = await postReport({ interaction, config, embed });

  let content = "";
  if (report?.url) content = `Posted for the officers: ${report.url}`;
  else if (report) content = `⚠️ Could not post the report: ${report.reason}`;

  await interaction.editReply({ content, embeds: [embed] });

  logErr(
    `/missing by ${interaction.user.tag}: message ${message.id}, role ${roleId}, ` +
      `${diff.signedCount}/${diff.rosterSize} responded, ${diff.unsigned.length} missing`
  );
}
