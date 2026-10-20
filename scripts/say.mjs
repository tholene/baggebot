#!/usr/bin/env node
/**
 * Posts a single message to a single channel, as the bot user.
 *
 * The only write is one POST to /channels/<id>/messages. allowed_mentions is
 * locked down so the message can ping at most the one user given with --mention:
 * no @everyone/@here, no roles, no other users, and no reply ping. It keeps the
 * same guards the other scripts use: snowflake validation, a bot-token check, a
 * guild check on the target channel, token scrubbing in all output and
 * rate-limit-aware requests.
 *
 * Usage:
 *   node say.mjs --channel <id> [--mention <userId>] [--reply-to <messageId>] <text...>
 *
 * With --mention, "<@userId> " is prepended to the text unless the text already
 * contains that mention.
 */

import "dotenv/config";

import { SafeError, env, isSnowflake, log, logErr, scrub, sleep } from "../src/lib/safe.mjs";

const API = "https://discord.com/api/v10";
const MAX_LENGTH = 2000;

function parseArgs(argv) {
  const out = { words: [] };
  const takesValue = { "--channel": "channel", "--mention": "mention", "--reply-to": "replyTo" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const key = takesValue[arg];
    if (!key) {
      if (arg.startsWith("--")) throw new SafeError(`Unknown argument ${JSON.stringify(arg)}.`);
      out.words.push(arg);
      continue;
    }
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
  const { channel: channelId, mention, replyTo } = args;

  if (!token) throw new SafeError("Missing DISCORD_BOT_TOKEN.");
  if (token.length < 50 || /\s/.test(token)) {
    throw new SafeError("DISCORD_BOT_TOKEN does not look like a bot token.");
  }
  if (!guildId || !isSnowflake(guildId)) throw new SafeError("GUILD_ID must be a snowflake.");
  if (!channelId) throw new SafeError("No channel: pass --channel <id>.");
  if (!isSnowflake(channelId)) {
    throw new SafeError(`Channel must be a snowflake (got ${JSON.stringify(channelId)}).`);
  }
  if (mention !== undefined && !isSnowflake(mention)) {
    throw new SafeError(`--mention must be a user snowflake (got ${JSON.stringify(mention)}).`);
  }
  if (replyTo !== undefined && !isSnowflake(replyTo)) {
    throw new SafeError(`--reply-to must be a message snowflake (got ${JSON.stringify(replyTo)}).`);
  }

  let content = args.words.join(" ").trim();
  if (!content) throw new SafeError("No text: pass the message as the remaining arguments.");
  if (mention && !content.includes(`<@${mention}>`) && !content.includes(`<@!${mention}>`)) {
    content = `<@${mention}> ${content}`;
  }
  if (content.length > MAX_LENGTH) {
    throw new SafeError(`Message is ${content.length} characters; Discord allows ${MAX_LENGTH}.`);
  }

  return { token, guildId, channelId, mention, replyTo, content };
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
            "User-Agent": "RaidCleanup say (one-shot, v1.0)",
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

async function main() {
  const cfg = loadConfig(process.argv.slice(2));
  const request = makeClient(cfg.token);

  log("");
  log("Send message");
  log("============");
  log(`Guild:    ${cfg.guildId}`);
  log(`Channel:  ${cfg.channelId}`);
  log(`Mention:  ${cfg.mention ?? "(none)"}`);
  log(`Reply to: ${cfg.replyTo ?? "(none)"}`);
  log(`Text:     ${cfg.content}`);
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

  const body = {
    content: cfg.content,
    allowed_mentions: {
      parse: [],
      users: cfg.mention ? [cfg.mention] : [],
      replied_user: false,
    },
  };
  if (cfg.replyTo) {
    body.message_reference = {
      message_id: cfg.replyTo,
      channel_id: cfg.channelId,
      fail_if_not_exists: true,
    };
  }

  const sent = await request(`/channels/${cfg.channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  log("");
  log(`Sent message ${sent.id}.`);
  log(`https://discord.com/channels/${cfg.guildId}/${cfg.channelId}/${sent.id}`);
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
