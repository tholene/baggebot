/**
 * The Discord-free half of /missing: reading a message reference and building
 * the report. The fetching lives in commands/missing.mjs.
 *
 *   missing = role members - bots - (excluded roles, for the raider role only)
 *             - the post's author - anyone who reacted or voted
 */

import { isSnowflake } from "./safe.mjs";
import { joinWithin } from "./bonk.mjs";

/**
 * Accepts what Discord's "Copy Message Link" and "Copy Message ID" put on the
 * clipboard. A link pins down the channel; a bare ID has to be searched for.
 *
 * @returns { guildId, channelId, messageId } with the first two null for a
 *   bare ID, or null when the input is neither.
 */
export function parseMessageRef(input) {
  const text = String(input ?? "").trim();
  if (isSnowflake(text)) return { guildId: null, channelId: null, messageId: text };

  const match = text.match(
    /^<?https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})>?$/
  );
  if (!match) return null;
  return { guildId: match[1], channelId: match[2], messageId: match[3] };
}

/** First line of the post, for the report title. Empty without Message Content. */
export function excerpt(content, max = 80) {
  const line = String(content ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The report for one /missing run, as a plain embed object.
 *
 * Names rather than mentions for the missing list: mentions inside an embed
 * render as raw IDs on clients that have not seen the user yet, which on
 * mobile is most of them.
 *
 * @param post       { url, channelId, content }
 * @param responses  { reactions: [{ emoji, count }], pollVotes: number|null }
 */
export function buildMissingReport({ post, roleId, diff, responses, invokedBy, now = new Date() }) {
  const answered = diff.signedCount;
  const missing = diff.unsigned;
  const title = excerpt(post.content);

  const lines = [
    `<@${invokedBy.id}> checked who in <@&${roleId}> has responded to ` +
      `[this post](${post.url}) in <#${post.channelId}>.`,
    `**${answered} of ${diff.rosterSize}** have responded.`,
  ];

  const counted = [];
  if (responses.pollVotes !== null) counted.push(`${responses.pollVotes} poll vote${responses.pollVotes === 1 ? "" : "s"}`);
  for (const reaction of responses.reactions) counted.push(`${reaction.emoji} ${reaction.count}`);
  if (counted.length > 0) lines.push(`-# Counted: ${counted.join(" · ")}`);

  const fields = [];
  if (missing.length > 0) {
    fields.push({
      name: `Not responded yet (${missing.length})`,
      value: joinWithin(
        missing.map((member) => member.displayName),
        ", "
      ),
    });
  } else {
    lines.push("", "Everyone has responded. 🎉");
  }

  return {
    title: (title ? `Missing: ${title}` : "Missing responses").slice(0, 256),
    url: post.url,
    description: lines.join("\n"),
    color: missing.length === 0 ? 0x2ecc71 : 0xe67e22,
    fields,
    footer: { text: "Any reaction or poll vote counts. The author counts as responded." },
    timestamp: now.toISOString(),
  };
}
