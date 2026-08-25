#!/usr/bin/env node
/**
 * One-shot cleanup of historical Raid-Helper signup posts from a single
 * Discord channel, using the Discord REST API v10 directly.
 *
 * Design rules:
 *   - Dry run is the default. Deletion requires several deliberate settings.
 *   - Identity is decided ONLY by the immutable author user ID. Never by
 *     message content, embeds, usernames or bot flags. (So no Message Content
 *     intent is required.)
 *   - Every failure path fails closed: we refuse to delete rather than guess.
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
const AUDIT_REASON = "One-shot cleanup of orphaned Raid-Helper signup posts";
const DEFAULT_MAX_DELETE = 500;
const CONFIRM_PHRASE = "DELETE_RAID_HELPER_MESSAGES";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

function loadConfig() {
  const token = env("DISCORD_BOT_TOKEN");
  const guildId = env("GUILD_ID");
  const channelId = env("CHANNEL_ID");
  const raidHelperUserId = env("RAID_HELPER_USER_ID");
  const keepFromMessageId = env("KEEP_FROM_MESSAGE_ID");
  const confirmDelete = env("CONFIRM_DELETE");
  const maxDeleteRaw = env("MAX_DELETE");

  const missing = [];
  if (!token) missing.push("DISCORD_BOT_TOKEN");
  if (!guildId) missing.push("GUILD_ID");
  if (!channelId) missing.push("CHANNEL_ID");
  if (!raidHelperUserId) missing.push("RAID_HELPER_USER_ID");
  if (missing.length) {
    throw new SafeError(
      `Missing required .env values: ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill it in.`
    );
  }

  // The application public key is NOT a bot token; catch that mistake early.
  if (token.length < 50 || /\s/.test(token)) {
    throw new SafeError(
      "DISCORD_BOT_TOKEN does not look like a Discord bot token. " +
        "Use the token from the application's Bot page (not APP_ID/PUBLIC_KEY)."
    );
  }

  for (const [name, value] of [
    ["GUILD_ID", guildId],
    ["CHANNEL_ID", channelId],
    ["RAID_HELPER_USER_ID", raidHelperUserId],
  ]) {
    if (!isSnowflake(value)) {
      throw new SafeError(
        `${name} must be a numeric Discord snowflake ID (got ${JSON.stringify(value)}).`
      );
    }
  }

  if (keepFromMessageId && !isSnowflake(keepFromMessageId)) {
    throw new SafeError(
      `KEEP_FROM_MESSAGE_ID must be a numeric Discord snowflake ID or empty ` +
        `(got ${JSON.stringify(keepFromMessageId)}).`
    );
  }

  const dryRun = envBool("DRY_RUN", true);
  const deleteAllMatches = envBool("DELETE_ALL_MATCHES", false);

  // Ambiguous configuration -> fail closed, do not guess the intent.
  if (deleteAllMatches && keepFromMessageId) {
    throw new SafeError(
      "Ambiguous configuration: DELETE_ALL_MATCHES=true and KEEP_FROM_MESSAGE_ID " +
        "are both set. Choose exactly one deletion strategy and clear the other."
    );
  }

  let maxDelete = DEFAULT_MAX_DELETE;
  if (maxDeleteRaw !== "") {
    if (!/^\d+$/.test(maxDeleteRaw) || Number(maxDeleteRaw) < 1) {
      throw new SafeError(
        `MAX_DELETE must be a positive integer or empty (got ${JSON.stringify(maxDeleteRaw)}).`
      );
    }
    maxDelete = Number(maxDeleteRaw);
  }

  return {
    token,
    guildId,
    channelId,
    raidHelperUserId,
    keepFromMessageId,
    confirmDelete,
    dryRun,
    deleteAllMatches,
    maxDelete,
    maxDeleteIsDefault: maxDeleteRaw === "",
  };
}

/* -------------------------------------------------------------------------- */
/* Discord REST                                                               */
/* -------------------------------------------------------------------------- */

function makeClient(token) {
  return async function discordRequest(path, options = {}) {
    const { headers: extraHeaders, retries = 5, ...rest } = options;
    let attempt = 0;

    while (true) {
      let response;
      try {
        response = await fetch(`${API}${path}`, {
          ...rest,
          headers: {
            Authorization: `Bot ${token}`,
            "User-Agent": "RaidCleanup (one-shot cleanup script, v1.0)",
            ...(extraHeaders ?? {}),
          },
        });
      } catch (networkError) {
        if (attempt++ >= retries) {
          throw new SafeError(`Network error calling ${path}: ${networkError.message}`);
        }
        const wait = Math.min(30_000, 1000 * 2 ** attempt);
        log(`Network error on ${path}; retrying in ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
        continue;
      }

      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        const headerRetry = Number(response.headers.get("retry-after"));
        const retryAfterSeconds =
          Number(body.retry_after) || (Number.isFinite(headerRetry) ? headerRetry : 1);
        const isGlobal = body.global === true;
        log(
          `Rate limited${isGlobal ? " (global)" : ""}. ` +
            `Waiting ${retryAfterSeconds}s before retrying...`
        );
        await sleep(Math.ceil(retryAfterSeconds * 1000) + 250);
        continue;
      }

      if (response.status >= 500 && attempt < retries) {
        attempt++;
        const wait = Math.min(30_000, 1000 * 2 ** attempt);
        log(`Discord returned ${response.status}; retrying in ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
        continue;
      }

      if (!response.ok) {
        // Response bodies from Discord never contain our token, but scrub anyway.
        const text = await response.text().catch(() => "");
        throw new SafeError(
          `Discord API error ${response.status} on ${path}: ${scrub(text).slice(0, 500)}`
        );
      }

      if (response.status === 204) return null;
      return response.json();
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

async function verifyToken(request) {
  let me;
  try {
    me = await request("/users/@me");
  } catch (error) {
    throw new SafeError(
      `Could not authenticate with Discord. Check DISCORD_BOT_TOKEN.\n  ${error.message}`
    );
  }
  if (!me?.id) throw new SafeError("Discord returned an unexpected /users/@me response.");
  if (!me.bot) {
    throw new SafeError(
      "The supplied token belongs to a user account, not a bot. Refusing to continue."
    );
  }
  const tag = me.discriminator && me.discriminator !== "0"
    ? `${me.username}#${me.discriminator}`
    : me.username;
  log(`Authenticated as ${tag} (id ${me.id})`);
  return me;
}

async function verifyChannel(request, config) {
  let channel;
  try {
    channel = await request(`/channels/${config.channelId}`);
  } catch (error) {
    throw new SafeError(
      `Could not read channel ${config.channelId}. The bot needs "View Channel" there.\n  ${error.message}`
    );
  }

  if (!channel?.id) throw new SafeError("Discord returned an unexpected channel payload.");
  if (channel.id !== config.channelId) {
    throw new SafeError("Channel ID mismatch in Discord response. Refusing to continue.");
  }
  if (!channel.guild_id) {
    throw new SafeError(
      "The configured channel is not a guild channel (it may be a DM). Refusing to continue."
    );
  }
  if (channel.guild_id !== config.guildId) {
    throw new SafeError(
      `Channel ${config.channelId} belongs to guild ${channel.guild_id}, ` +
        `not the configured GUILD_ID ${config.guildId}. Refusing to continue.`
    );
  }

  log(`Channel verified: #${channel.name ?? "(unnamed)"} in guild ${channel.guild_id}`);
  return channel;
}

async function fetchAllMessages(request, channelId) {
  const all = [];
  const seen = new Set();
  let before;
  let pages = 0;

  while (true) {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", before);

    const batch = await request(`/channels/${channelId}/messages?${params}`);
    if (!Array.isArray(batch)) {
      throw new SafeError("Discord returned an unexpected messages payload.");
    }
    pages++;
    if (batch.length === 0) break;

    for (const message of batch) {
      if (seen.has(message.id)) continue; // paranoia against pagination overlap
      seen.add(message.id);
      all.push(message);
    }

    const oldest = batch[batch.length - 1].id;
    if (oldest === before) break; // no forward progress; stop rather than loop
    before = oldest;

    log(`  page ${pages}: ${all.length} messages scanned so far...`);
    if (batch.length < 100) break;
  }

  return { messages: all, pages };
}

function messageUrl(config, messageId) {
  return `https://discord.com/channels/${config.guildId}/${config.channelId}/${messageId}`;
}

/** Optional, non-authoritative diagnostic label. Never used to decide deletion. */
function describe(message) {
  const embedTitle = message.embeds?.[0]?.title;
  if (typeof embedTitle === "string" && embedTitle.trim()) {
    return embedTitle.trim().replace(/\s+/g, " ").slice(0, 60);
  }
  return "";
}

/**
 * Resolve the deletion strategy. Returns a predicate plus a human description.
 * Fails closed on anything unexpected.
 */
function resolveStrategy(config, raidHelperMessages) {
  if (config.deleteAllMatches) {
    return {
      name: "delete-all",
      description: "DELETE_ALL_MATCHES=true — every Raid-Helper message is eligible.",
      isEligible: () => true,
    };
  }

  if (config.keepFromMessageId) {
    const boundary = raidHelperMessages.find((m) => m.id === config.keepFromMessageId);
    if (!boundary) {
      throw new SafeError(
        `KEEP_FROM_MESSAGE_ID ${config.keepFromMessageId} was not found among the ` +
          `Raid-Helper messages in channel ${config.channelId}. It must be an existing ` +
          `message in this channel authored by RAID_HELPER_USER_ID. Refusing to continue.`
      );
    }
    if (boundary.author?.id !== config.raidHelperUserId) {
      throw new SafeError(
        `KEEP_FROM_MESSAGE_ID ${config.keepFromMessageId} is not authored by ` +
          `RAID_HELPER_USER_ID. Refusing to continue.`
      );
    }
    if (boundary.channel_id && boundary.channel_id !== config.channelId) {
      throw new SafeError(
        `KEEP_FROM_MESSAGE_ID ${config.keepFromMessageId} is not in the configured channel. ` +
          `Refusing to continue.`
      );
    }
    const cutoff = BigInt(config.keepFromMessageId);
    return {
      name: "keep-from",
      description:
        `KEEP_FROM_MESSAGE_ID=${config.keepFromMessageId} — that message ` +
        `(${boundary.timestamp}) and everything newer is kept.`,
      isEligible: (message) => BigInt(message.id) < cutoff,
    };
  }

  return {
    name: "none",
    description:
      "No deletion strategy configured (set KEEP_FROM_MESSAGE_ID or DELETE_ALL_MATCHES=true).",
    isEligible: () => false,
  };
}

/** Final per-message gate, re-checked immediately before each delete call. */
function assertDeletable(message, config) {
  if (message.author?.id !== config.raidHelperUserId) {
    throw new SafeError(`Message ${message.id} is not authored by Raid-Helper.`);
  }
  if (message.channel_id && message.channel_id !== config.channelId) {
    throw new SafeError(`Message ${message.id} is not in the configured channel.`);
  }
  if (!isSnowflake(message.id)) {
    throw new SafeError(`Message ID ${message.id} is not a valid snowflake.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const config = loadConfig();
  const request = makeClient(config.token);

  log("");
  log("Raid-Helper signup cleanup");
  log("==========================");
  log(`Guild:        ${config.guildId}`);
  log(`Channel:      ${config.channelId}`);
  log(`Raid-Helper:  ${config.raidHelperUserId}`);
  log(`Dry run:      ${config.dryRun}`);
  log(`Delete all:   ${config.deleteAllMatches}`);
  log(`Keep from:    ${config.keepFromMessageId || "(unset)"}`);
  log(`Max delete:   ${config.maxDelete}${config.maxDeleteIsDefault ? " (default)" : ""}`);
  log("");

  await verifyToken(request);
  await verifyChannel(request, config);

  log("");
  log("Fetching channel history...");
  const { messages, pages } = await fetchAllMessages(request, config.channelId);
  log(`Done: ${messages.length} messages across ${pages} page(s).`);

  const raidHelperMessages = messages
    .filter((message) => message.author?.id === config.raidHelperUserId)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));

  log("");
  log(`Raid-Helper messages found: ${raidHelperMessages.length}`);

  if (raidHelperMessages.length === 0) {
    log("");
    log("No messages authored by Raid-Helper were found in this channel.");
    log("Nothing to do. Exiting.");
    return 0;
  }

  const strategy = resolveStrategy(config, raidHelperMessages);
  log(`Strategy:  ${strategy.description}`);
  log("");

  const eligible = [];
  const kept = [];
  for (const message of raidHelperMessages) {
    (strategy.isEligible(message) ? eligible : kept).push(message);
  }

  for (const message of raidHelperMessages) {
    const willDelete = strategy.isEligible(message);
    const note = describe(message);
    log(
      `${willDelete ? "[DELETE]" : "[KEEP]  "} ${message.timestamp} ${message.id}` +
        (note ? `  — ${note}` : "")
    );
    log(`         ${messageUrl(config, message.id)}`);
  }

  log("");
  log(`Messages scanned:              ${messages.length}`);
  log(`Raid-Helper messages found:    ${raidHelperMessages.length}`);
  log(`Messages that will be kept:    ${kept.length}`);
  log(`Messages eligible for delete:  ${eligible.length}`);

  const overCap = eligible.length > config.maxDelete;
  if (overCap) {
    log("");
    log(
      `WARNING: ${eligible.length} eligible messages exceeds MAX_DELETE=${config.maxDelete}` +
        `${config.maxDeleteIsDefault ? " (built-in default)" : ""}. ` +
        `A real run would refuse. Raise MAX_DELETE in .env deliberately if this is correct.`
    );
  }

  /* ---------------------------- Dry run ---------------------------------- */

  if (config.dryRun) {
    log("");
    log("DRY RUN — nothing was deleted.");
    log("");
    log("Open several of the jump links above and confirm they really are the old");
    log("Raid-Helper signup posts before enabling deletion.");
    if (strategy.name === "none") {
      log("");
      log("Note: no deletion strategy is configured, so everything shows as [KEEP].");
      log("Set KEEP_FROM_MESSAGE_ID (recommended) or DELETE_ALL_MATCHES=true, then re-run.");
    }
    return 0;
  }

  /* --------------------------- Destructive ------------------------------- */

  if (strategy.name === "none") {
    throw new SafeError(
      "Refusing to delete: no deletion strategy. Set KEEP_FROM_MESSAGE_ID to the oldest " +
        "Raid-Helper message you want to preserve, or set DELETE_ALL_MATCHES=true."
    );
  }

  if (config.confirmDelete !== CONFIRM_PHRASE) {
    throw new SafeError(
      `Refusing to delete: set CONFIRM_DELETE=${CONFIRM_PHRASE} in .env to authorise this run.`
    );
  }

  if (eligible.length === 0) {
    log("");
    log("Nothing is eligible for deletion under the current strategy. Exiting.");
    return 0;
  }

  if (overCap) {
    throw new SafeError(
      `Refusing to delete ${eligible.length} messages: MAX_DELETE is ${config.maxDelete}. ` +
        `If this is genuinely intended, set MAX_DELETE=${eligible.length} (or higher) in .env.`
    );
  }

  log("");
  log("DESTRUCTIVE MODE ENABLED");
  log(`Deleting ${eligible.length} Raid-Helper messages individually (no bulk delete).`);
  log("");

  let deleted = 0;
  let failed = 0;
  const failures = [];

  for (const [index, message] of eligible.entries()) {
    const position = `[${index + 1}/${eligible.length}]`;
    try {
      assertDeletable(message, config); // final gate, right before the call
      await request(`/channels/${config.channelId}/messages/${message.id}`, {
        method: "DELETE",
        headers: { "X-Audit-Log-Reason": encodeURIComponent(AUDIT_REASON) },
      });
      deleted++;
      log(`${position} deleted ${message.id} (${message.timestamp})`);
    } catch (error) {
      failed++;
      failures.push({ id: message.id, reason: error.message });
      logErr(`${position} FAILED  ${message.id}: ${error.message}`);
      // A permission problem will fail for every message; stop early rather
      // than spamming Discord with hundreds of doomed requests.
      if (/Discord API error 40[13]/.test(error.message)) {
        logErr("");
        logErr(
          "Aborting: Discord rejected the delete as unauthorised. The cleanup bot most " +
            'likely lacks "Manage Messages" in this channel.'
        );
        break;
      }
    }
    await sleep(350); // gentle, sequential pacing
  }

  log("");
  log("Summary");
  log("-------");
  log(`Messages scanned:      ${messages.length}`);
  log(`Raid-Helper matches:   ${raidHelperMessages.length}`);
  log(`Eligible:              ${eligible.length}`);
  log(`Deleted:               ${deleted}`);
  log(`Failed:                ${failed}`);
  log(`Kept:                  ${kept.length}`);

  if (failures.length) {
    log("");
    log("Failures:");
    for (const failure of failures) log(`  ${failure.id}: ${failure.reason}`);
    log("");
    log("Completed WITH FAILURES — not all eligible messages were deleted.");
    return 1;
  }

  log("");
  log("Completed successfully.");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    logErr("");
    if (error instanceof SafeError) {
      logErr(`ERROR: ${error.message}`);
    } else {
      // Message only — never dump objects/headers that could carry the token.
      logErr(`UNEXPECTED ERROR: ${error?.message ?? error}`);
    }
    logErr("");
    process.exitCode = 1;
  });
