#!/usr/bin/env node
/**
 * Deletes EVERY message in one explicitly named channel, regardless of author.
 *
 * This is deliberately a SEPARATE script from cleanup.mjs. cleanup.mjs only ever
 * deletes messages authored by RAID_HELPER_USER_ID and that invariant is what
 * makes it safe to re-run; this script has no author filter at all, so it gets
 * its own name, its own confirmation phrase and its own guards.
 *
 * Required to actually delete:
 *   PURGE_CHANNEL_ID=<channel>
 *   PURGE_DRY_RUN=false
 *   PURGE_CONFIRM=DELETE_ALL_MESSAGES_IN_CHANNEL
 */

import "dotenv/config";

import {
  SafeError,
  env,
  envBool,
  isSnowflake,
  log,
  logErr,
  scrub,
  sleep,
} from "../src/lib/safe.mjs";

const API = "https://discord.com/api/v10";
const AUDIT_REASON = "Channel wipe: outdated boss tactics ahead of new season";
const CONFIRM_PHRASE = "DELETE_ALL_MESSAGES_IN_CHANNEL";
const DEFAULT_MAX_DELETE = 1000;

function loadConfig() {
  const token = env("DISCORD_BOT_TOKEN");
  const guildId = env("GUILD_ID");
  const purgeChannelId = env("PURGE_CHANNEL_ID");
  const signupChannelId = env("CHANNEL_ID");

  if (!token) throw new SafeError("Missing DISCORD_BOT_TOKEN.");
  if (token.length < 50 || /\s/.test(token)) {
    throw new SafeError("DISCORD_BOT_TOKEN does not look like a bot token.");
  }
  if (!guildId || !isSnowflake(guildId)) throw new SafeError("GUILD_ID must be a snowflake.");
  if (!purgeChannelId) {
    throw new SafeError(
      "PURGE_CHANNEL_ID is required. This script never guesses which channel to wipe."
    );
  }
  if (!isSnowflake(purgeChannelId)) {
    throw new SafeError(`PURGE_CHANNEL_ID must be a snowflake (got ${JSON.stringify(purgeChannelId)}).`);
  }
  // Hard guard: this script must never be pointed at the raid signup channel.
  if (signupChannelId && purgeChannelId === signupChannelId) {
    throw new SafeError(
      `Refusing to run: PURGE_CHANNEL_ID equals CHANNEL_ID (${signupChannelId}), the raid ` +
        `signup channel. Use cleanup.mjs for that channel — it filters by author.`
    );
  }

  const maxRaw = env("PURGE_MAX_DELETE");
  let maxDelete = DEFAULT_MAX_DELETE;
  if (maxRaw !== "") {
    if (!/^\d+$/.test(maxRaw) || Number(maxRaw) < 1) {
      throw new SafeError(`PURGE_MAX_DELETE must be a positive integer or empty.`);
    }
    maxDelete = Number(maxRaw);
  }

  return {
    token,
    guildId,
    purgeChannelId,
    dryRun: envBool("PURGE_DRY_RUN", true),
    confirm: env("PURGE_CONFIRM"),
    maxDelete,
  };
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
            "User-Agent": "RaidCleanup purge (one-shot, v1.0)",
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
  const cfg = loadConfig();
  const request = makeClient(cfg.token);

  log("");
  log("Channel purge (ALL authors)");
  log("===========================");
  log(`Guild:        ${cfg.guildId}`);
  log(`Channel:      ${cfg.purgeChannelId}`);
  log(`Dry run:      ${cfg.dryRun}`);
  log(`Max delete:   ${cfg.maxDelete}`);
  log("");

  const me = await request("/users/@me");
  if (!me?.bot) throw new SafeError("Token is not a bot token. Refusing to continue.");
  log(`Authenticated as ${me.username} (id ${me.id})`);

  const channel = await request(`/channels/${cfg.purgeChannelId}`);
  if (!channel?.guild_id) throw new SafeError("Not a guild channel. Refusing to continue.");
  if (channel.guild_id !== cfg.guildId) {
    throw new SafeError(
      `Channel belongs to guild ${channel.guild_id}, not GUILD_ID ${cfg.guildId}. Refusing.`
    );
  }
  log(`Channel verified: #${channel.name ?? "(unnamed)"} in guild ${channel.guild_id}`);

  log("");
  log("Fetching channel history...");
  const all = [];
  const seen = new Set();
  let before;
  let pages = 0;
  while (true) {
    const q = new URLSearchParams({ limit: "100" });
    if (before) q.set("before", before);
    const batch = await request(`/channels/${cfg.purgeChannelId}/messages?${q}`);
    if (!Array.isArray(batch)) throw new SafeError("Unexpected messages payload.");
    pages++;
    if (!batch.length) break;
    for (const m of batch) {
      if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
    }
    const oldest = batch[batch.length - 1].id;
    if (oldest === before) break;
    before = oldest;
    log(`  page ${pages}: ${all.length} messages scanned so far...`);
    if (batch.length < 100) break;
  }
  log(`Done: ${all.length} messages across ${pages} page(s).`);

  if (all.length === 0) {
    log("");
    log("Channel is already empty. Nothing to do.");
    return 0;
  }

  const oldestFirst = [...all].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));
  const authors = new Map();
  for (const m of all) {
    const key = `${m.author?.username ?? "?"}${m.author?.bot ? " [BOT]" : ""} (${m.author?.id})`;
    authors.set(key, (authors.get(key) ?? 0) + 1);
  }

  log("");
  log(`Messages to delete: ${all.length}`);
  log(`Range: ${oldestFirst[0].timestamp} -> ${oldestFirst.at(-1).timestamp}`);
  log(`Pinned included: ${all.filter((m) => m.pinned).length}`);
  log("");
  log("Authors affected:");
  for (const [k, n] of [...authors].sort((a, b) => b[1] - a[1])) {
    log(`  ${String(n).padStart(4)}  ${k}`);
  }

  const overCap = all.length > cfg.maxDelete;
  if (overCap) {
    log("");
    log(`WARNING: ${all.length} messages exceeds PURGE_MAX_DELETE=${cfg.maxDelete}.`);
  }

  if (cfg.dryRun) {
    log("");
    log("DRY RUN — nothing was deleted.");
    log(`To execute: PURGE_DRY_RUN=false PURGE_CONFIRM=${CONFIRM_PHRASE}`);
    return 0;
  }

  if (cfg.confirm !== CONFIRM_PHRASE) {
    throw new SafeError(`Refusing to delete: set PURGE_CONFIRM=${CONFIRM_PHRASE}.`);
  }
  if (overCap) {
    throw new SafeError(
      `Refusing to delete ${all.length} messages: PURGE_MAX_DELETE is ${cfg.maxDelete}. ` +
        `Set PURGE_MAX_DELETE=${all.length} or higher to proceed.`
    );
  }

  log("");
  log("DESTRUCTIVE MODE ENABLED — deleting EVERY message in this channel.");
  log("");

  let deleted = 0;
  let failed = 0;
  const failures = [];

  for (const [i, m] of oldestFirst.entries()) {
    const pos = `[${i + 1}/${oldestFirst.length}]`;
    try {
      if (m.channel_id && m.channel_id !== cfg.purgeChannelId) {
        throw new SafeError("message is not in the target channel");
      }
      if (!isSnowflake(m.id)) throw new SafeError("invalid message id");
      await request(`/channels/${cfg.purgeChannelId}/messages/${m.id}`, {
        method: "DELETE",
        headers: { "X-Audit-Log-Reason": encodeURIComponent(AUDIT_REASON) },
      });
      deleted++;
      if (deleted % 25 === 0 || deleted === oldestFirst.length) {
        log(`${pos} deleted ${m.id}`);
      }
    } catch (error) {
      failed++;
      failures.push({ id: m.id, reason: error.message });
      logErr(`${pos} FAILED ${m.id}: ${error.message}`);
      if (/Discord API error 40[13]/.test(error.message)) {
        logErr("");
        logErr('Aborting: unauthorised. The bot likely lacks "Manage Messages" here.');
        break;
      }
    }
    await sleep(120);
  }

  log("");
  log("Summary");
  log("-------");
  log(`Messages found:   ${all.length}`);
  log(`Deleted:          ${deleted}`);
  log(`Failed:           ${failed}`);

  if (failures.length) {
    log("");
    log("Failures:");
    for (const f of failures.slice(0, 20)) log(`  ${f.id}: ${f.reason}`);
    log("");
    log("Completed WITH FAILURES.");
    return 1;
  }
  log("");
  log("Completed successfully.");
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
