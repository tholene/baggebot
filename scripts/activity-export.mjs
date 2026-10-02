#!/usr/bin/env node
/**
 * Exports one channel's message history as JSONL, for offline analysis.
 *
 * Read-only. Unlike cleanup.mjs and purge-channel.mjs this script deletes
 * nothing, so it needs no confirmation phrase - but it does copy chat out of
 * Discord onto disk, so its output lands in logs/ (gitignored) alongside
 * bonks.jsonl rather than anywhere that could be committed by accident.
 *
 * Two things about this guild's chat channel shape the whole script:
 *
 *   1. Message text is only returned when the application has the Message
 *      Content privileged intent enabled. Without it every `content` comes back
 *      as "" and the export is timestamps only. The script says so loudly
 *      instead of writing a file that silently means nothing.
 *   2. The channel is bridged from in-game chat, so authors come in two kinds.
 *      A LINKED account is a real Discord user. A PROVISIONAL account is the
 *      placeholder Discord mints for someone posting from the game who has not
 *      linked a Discord account - auto-generated username ("jovial_kitten_04911"),
 *      display name set to the character name. One human can appear as several
 *      provisional accounts, so counting them as people inflates the totals.
 *      Provisional accounts are excluded unless --include-provisional is passed.
 *
 *   node scripts/activity-export.mjs <channel-id> [--include-provisional] [--since=YYYY-MM-DD]
 */

import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";

import { SafeError, envBotToken, isSnowflake, log, logErr, sleep } from "../src/lib/safe.mjs";

const API = "https://discord.com/api/v10";
const PAGE_SIZE = 100;

/** User flag 1 << 23: an unclaimed account minted for a bridged game user. */
const PROVISIONAL_ACCOUNT_FLAG = 1 << 23;

const isProvisional = (user) =>
  (((user.flags ?? 0) | (user.public_flags ?? 0)) & PROVISIONAL_ACCOUNT_FLAG) !== 0;

function parseArgs(argv) {
  const channelId = argv.find((a) => !a.startsWith("--")) ?? "";
  if (!channelId) {
    throw new SafeError(
      "Usage: node scripts/activity-export.mjs <channel-id> [--include-provisional] [--since=YYYY-MM-DD]"
    );
  }
  if (!isSnowflake(channelId)) {
    throw new SafeError(`Channel ID must be a snowflake (got ${JSON.stringify(channelId)}).`);
  }

  const sinceArg = argv.find((a) => a.startsWith("--since="))?.slice("--since=".length);
  let since = null;
  if (sinceArg) {
    since = new Date(sinceArg);
    if (Number.isNaN(since.getTime())) {
      throw new SafeError(`--since must be a date Date() understands (got ${JSON.stringify(sinceArg)}).`);
    }
  }

  return {
    channelId,
    includeProvisional: argv.includes("--include-provisional"),
    since,
  };
}

async function discord(url, token) {
  for (;;) {
    const response = await fetch(url, {
      headers: { Authorization: `Bot ${token}`, "User-Agent": "BaggeBot (activity-export, 1.0)" },
    });

    if (response.status === 429) {
      const body = await response.json().catch(() => ({}));
      const waitMs = (body.retry_after ?? 1) * 1000 + 100;
      log(`Rate limited, waiting ${waitMs}ms.`);
      await sleep(waitMs);
      continue;
    }

    if (response.status === 403 || response.status === 404) {
      throw new SafeError(
        `Discord returned ${response.status} for that channel. The bot needs both ` +
          `View Channel and Read Message History there, and the channel must be in a ` +
          `guild the bot is in.`
      );
    }

    if (!response.ok) {
      throw new SafeError(`Discord returned ${response.status}: ${await response.text()}`);
    }

    // Pause when the bucket is spent rather than earning a 429 on the next page.
    if (Number(response.headers.get("x-ratelimit-remaining") ?? "1") <= 0) {
      await sleep(Number(response.headers.get("x-ratelimit-reset-after") ?? "1") * 1000 + 100);
    }

    return response.json();
  }
}

/** Newest-first, which is the only order Discord's history endpoint offers. */
async function fetchHistory(channelId, token, since) {
  const messages = [];
  let before = null;

  for (;;) {
    const url =
      `${API}/channels/${channelId}/messages?limit=${PAGE_SIZE}` +
      (before ? `&before=${before}` : "");
    const page = await discord(url, token);
    if (page.length === 0) break;

    for (const message of page) {
      if (since && new Date(message.timestamp) < since) return messages;
      messages.push(message);
    }

    log(`Fetched ${messages.length} messages...`);
    if (page.length < PAGE_SIZE) break;
    before = page[page.length - 1].id;
  }

  return messages;
}

/**
 * One flat record per message. Deliberately not the raw Discord object: the raw
 * form is mostly avatar hashes and collectible SKUs, which no analysis wants and
 * which would bury the three fields that matter - who, when, what.
 */
function toRecord(message) {
  const author = message.author;
  return {
    id: message.id,
    at: message.timestamp,
    author_id: author.id,
    author: author.username,
    display_name: author.global_name ?? author.username,
    // Which character the message was sent from, when it came in over the bridge.
    character: message.lobby_member?.additional_name ?? null,
    account: isProvisional(author) ? "provisional" : "linked",
    bot: Boolean(author.bot),
    // Empty for every message unless Message Content is enabled - see the header.
    content: message.content ?? "",
    edited: Boolean(message.edited_timestamp),
    reply_to: message.referenced_message?.id ?? message.message_reference?.message_id ?? null,
    attachments: message.attachments.length,
    // 0 is a normal message; 19 is a reply, 49 an in-game/system bridge notice.
    type: message.type,
  };
}

async function main() {
  const { channelId, includeProvisional, since } = parseArgs(process.argv.slice(2));
  const token = envBotToken();

  const raw = await fetchHistory(channelId, token, since);
  if (raw.length === 0) throw new SafeError("That channel has no messages the bot can see.");

  // Oldest first: a transcript reads forwards, and so does anything summarising it.
  const records = raw.map(toRecord).reverse();

  const kept = records.filter((r) => !r.bot && (includeProvisional || r.account === "linked"));
  const skippedProvisional = records.filter((r) => r.account === "provisional").length;
  const withContent = kept.filter((r) => r.content.length > 0).length;

  mkdirSync("logs", { recursive: true });
  const path = `logs/activity-${channelId}.jsonl`;
  writeFileSync(path, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const people = new Map();
  for (const r of kept) people.set(r.author_id, (people.get(r.author_id) ?? 0) + 1);

  log(`Wrote ${kept.length} messages from ${people.size} accounts to ${path}`);
  log(`Range: ${kept[0]?.at} -> ${kept[kept.length - 1]?.at}`);
  if (!includeProvisional && skippedProvisional > 0) {
    log(
      `Excluded ${skippedProvisional} messages from provisional (unlinked) accounts. ` +
        `Pass --include-provisional to keep them.`
    );
  }

  if (withContent === 0) {
    logErr(
      `\nWARNING: not one of those messages has any text.\n` +
        `  Discord only returns message content to applications with the Message Content\n` +
        `  privileged intent. Turn it on at Developer Portal -> Bot -> Privileged Gateway\n` +
        `  Intents -> Message Content Intent, then re-run this script: history already in\n` +
        `  the channel becomes readable, so nothing said so far is lost.`
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logErr(error instanceof SafeError ? error.message : (error?.stack ?? String(error)));
  process.exit(1);
});
