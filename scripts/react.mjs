#!/usr/bin/env node
/**
 * Adds (or removes) a single reaction on a single message, as the bot user.
 *
 * Unlike cleanup.mjs / purge-channel.mjs this script is non-destructive: the only
 * write it performs is PUT/DELETE on .../reactions/<emoji>/@me, which is trivially
 * reversible with --remove. It therefore has no confirmation phrase, but it keeps
 * the same guards the other scripts use: snowflake validation, a guild check on the
 * target channel, token scrubbing in all output and rate-limit-aware requests.
 *
 * Usage:
 *   node react.mjs --message <id> --emoji :BONK: [--channel <id>] [--remove]
 *
 * Custom emoji are given as :NAME: and resolved against the guild's emoji list.
 * Unicode emoji (e.g. 👍) are passed through as-is.
 * Env fallbacks: REACT_MESSAGE_ID, REACT_EMOJI, REACT_CHANNEL_ID (then CHANNEL_ID).
 */

import "dotenv/config";

import { SafeError, env, isSnowflake, log, logErr, scrub, sleep } from "../src/lib/safe.mjs";

const API = "https://discord.com/api/v10";

function parseArgs(argv) {
  const out = { remove: false };
  const takesValue = { "--message": "message", "--emoji": "emoji", "--channel": "channel" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--remove") { out.remove = true; continue; }
    const key = takesValue[arg];
    if (!key) throw new SafeError(`Unknown argument ${JSON.stringify(arg)}.`);
    const value = argv[++i];
    if (value === undefined) throw new SafeError(`${arg} requires a value.`);
    out[key] = value.trim();
  }
  return out;
}

function loadConfig(argv) {
  const args = parseArgs(argv);
  const token = env("DISCORD_BOT_TOKEN");
  const guildId = env("GUILD_ID");
  const channelId = args.channel ?? (env("REACT_CHANNEL_ID") || env("CHANNEL_ID"));
  const messageId = args.message ?? env("REACT_MESSAGE_ID");
  const emoji = args.emoji ?? env("REACT_EMOJI");

  if (!token) throw new SafeError("Missing DISCORD_BOT_TOKEN.");
  if (token.length < 50 || /\s/.test(token)) {
    throw new SafeError("DISCORD_BOT_TOKEN does not look like a bot token.");
  }
  if (!guildId || !isSnowflake(guildId)) throw new SafeError("GUILD_ID must be a snowflake.");
  if (!channelId) throw new SafeError("No channel: pass --channel <id> or set CHANNEL_ID.");
  if (!isSnowflake(channelId)) {
    throw new SafeError(`Channel must be a snowflake (got ${JSON.stringify(channelId)}).`);
  }
  if (!messageId) throw new SafeError("No message: pass --message <id> or set REACT_MESSAGE_ID.");
  if (!isSnowflake(messageId)) {
    throw new SafeError(`Message must be a snowflake (got ${JSON.stringify(messageId)}).`);
  }
  if (!emoji) throw new SafeError("No emoji: pass --emoji :NAME: (or a unicode emoji).");

  return { token, guildId, channelId, messageId, emoji, remove: args.remove };
}

function makeClient(token) {
  return async function request(path, options = {}) {
    const { headers: extra, retries = 5, ...rest } = options;
    let attempt = 0;
    while (true) {
      let res;
      try {
        res = await fetch(`${API}${path}`, {
          ...rest,
          headers: {
            Authorization: `Bot ${token}`,
            "User-Agent": "RaidCleanup react (one-shot, v1.0)",
            ...(extra ?? {}),
          },
        });
      } catch (e) {
        if (attempt++ >= retries) throw new SafeError(`Network error on ${path}: ${e.message}`);
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const wait = Number(body.retry_after) || Number(res.headers.get("retry-after")) || 1;
        log(`Rate limited${body.global ? " (global)" : ""}. Waiting ${wait}s...`);
        await sleep(Math.ceil(wait * 1000) + 250);
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        attempt++;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new SafeError(`Discord API error ${res.status} on ${path}: ${scrub(text).slice(0, 400)}`);
      }
      return res.status === 204 ? null : res.json();
    }
  };
}

/**
 * Turns user input into the `emoji` path segment the reactions endpoint wants:
 * "name:id" for custom emoji, the raw character(s) for unicode ones.
 */
async function resolveEmoji(request, guildId, input) {
  const custom = input.match(/^<a?:([\w~]+):(\d{17,20})>$/) ?? input.match(/^:?([\w~]+):?$/);
  const looksCustom = /^<a?:|^:/.test(input) || /^[\w~]+$/.test(input);
  if (!looksCustom || !custom) return { identifier: input, label: input };

  // Fully-qualified <:name:id> — no lookup needed.
  if (custom[2]) return { identifier: `${custom[1]}:${custom[2]}`, label: `:${custom[1]}:` };

  const name = custom[1];
  const emojis = await request(`/guilds/${guildId}/emojis`);
  if (!Array.isArray(emojis)) throw new SafeError("Unexpected guild emojis payload.");
  const matches = emojis.filter((e) => e.name?.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) {
    const near = emojis
      .map((e) => e.name)
      .filter((n) => n?.toLowerCase().includes(name.slice(0, 3).toLowerCase()))
      .slice(0, 10);
    throw new SafeError(
      `No emoji named :${name}: in guild ${guildId}.` +
        (near.length ? ` Did you mean: ${near.map((n) => `:${n}:`).join(", ")}?` : "")
    );
  }
  if (matches.length > 1) {
    throw new SafeError(
      `Ambiguous: ${matches.length} emoji named :${name}:. Pass the full form, e.g. ` +
        `<:${matches[0].name}:${matches[0].id}>.`
    );
  }
  const hit = matches[0];
  if (hit.available === false) throw new SafeError(`Emoji :${hit.name}: is unavailable (lost boost tier?).`);
  return { identifier: `${hit.name}:${hit.id}`, label: `:${hit.name}: (id ${hit.id})` };
}

async function main() {
  const cfg = loadConfig(process.argv.slice(2));
  const request = makeClient(cfg.token);

  log("");
  log(cfg.remove ? "Remove reaction" : "Add reaction");
  log("===============");
  log(`Guild:    ${cfg.guildId}`);
  log(`Channel:  ${cfg.channelId}`);
  log(`Message:  ${cfg.messageId}`);
  log(`Emoji:    ${cfg.emoji}`);
  log("");

  const me = await request("/users/@me");
  if (!me?.bot) throw new SafeError("Token is not a bot token. Refusing to continue.");
  log(`Authenticated as ${me.username} (id ${me.id})`);

  const channel = await request(`/channels/${cfg.channelId}`);
  if (!channel?.guild_id) throw new SafeError("Not a guild channel. Refusing to continue.");
  if (channel.guild_id !== cfg.guildId) {
    throw new SafeError(
      `Channel belongs to guild ${channel.guild_id}, not GUILD_ID ${cfg.guildId}. Refusing.`
    );
  }
  log(`Channel verified: #${channel.name ?? "(unnamed)"}`);

  const message = await request(`/channels/${cfg.channelId}/messages/${cfg.messageId}`);
  if (message.channel_id !== cfg.channelId) {
    throw new SafeError("Message is not in the target channel. Refusing.");
  }
  const preview = (message.content ?? "").replace(/\s+/g, " ").slice(0, 120) || "(no text content)";
  log(`Message by ${message.author?.username ?? "?"} at ${message.timestamp}`);
  log(`  ${preview}${(message.content ?? "").length > 120 ? "..." : ""}`);

  const { identifier, label } = await resolveEmoji(request, cfg.guildId, cfg.emoji);
  log(`Emoji resolved: ${label}`);

  const path =
    `/channels/${cfg.channelId}/messages/${cfg.messageId}` +
    `/reactions/${encodeURIComponent(identifier)}/@me`;
  await request(path, { method: cfg.remove ? "DELETE" : "PUT" });

  log("");
  log(cfg.remove ? `Removed ${label}.` : `Reacted with ${label}.`);
  if (!cfg.remove) {
    log(`To undo: node react.mjs --channel ${cfg.channelId} --message ${cfg.messageId} --emoji ${cfg.emoji} --remove`);
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code ?? 0; })
  .catch((error) => {
    logErr("");
    logErr(error instanceof SafeError ? `ERROR: ${error.message}` : `UNEXPECTED ERROR: ${error?.message ?? error}`);
    logErr("");
    process.exitCode = 1;
  });
