#!/usr/bin/env node
/**
 * Dumps the raw Raid-Helper payload for one event.
 *
 * This exists because Raid-Helper's v4 response shape is not publicly
 * documented, and lib/raidhelper.mjs therefore reads every field through a
 * list of candidate spellings. Run this once against a real event to confirm
 * the field names, and to see exactly what the signup list looks like.
 *
 *   npm run inspect -- 1234567890123456789
 *
 * Read-only. It sends one GET and prints the result.
 */

import "dotenv/config";

import { SafeError, env, log, logErr } from "../src/lib/safe.mjs";
import { makeRaidHelper, normaliseEvent } from "../src/lib/raidhelper.mjs";

async function main() {
  const eventId = (process.argv[2] ?? "").trim();
  if (!eventId) {
    throw new SafeError(
      "Usage: npm run inspect -- <eventId>\n" +
        "  The event ID is the Discord message ID of the Raid-Helper post: " +
        "right-click it and choose Copy Message ID."
    );
  }

  const raidHelper = makeRaidHelper(env("RAID_HELPER_TOKEN") || env("RAID_HELPER_API_KEY"));
  const raw = await raidHelper.getEventRaw(eventId);

  log("");
  log("Top-level keys");
  log("--------------");
  log(Object.keys(raw).sort().join(", "));

  log("");
  log("Raw payload");
  log("-----------");
  log(JSON.stringify(raw, null, 2).slice(0, 8000));

  log("");
  log("Parsed by lib/raidhelper.mjs");
  log("----------------------------");
  try {
    const event = normaliseEvent(raw);
    log(`id:         ${event.id}`);
    log(`title:      ${event.title}`);
    log(`serverId:   ${event.serverId || "(not found)"}`);
    log(`channelId:  ${event.channelId || "(not found)"}`);
    log(
      `startTime:  ${event.startTime ?? "(not found)"}` +
        (event.startTime ? ` -> ${new Date(event.startTime * 1000).toISOString()}` : "")
    );
    log(`signups:    ${event.signUps.length}`);
    for (const signUp of event.signUps.slice(0, 20)) {
      log(`  ${signUp.userId}  ${signUp.name} (${signUp.status})`);
    }
    if (event.signUps.length > 20) log(`  ...and ${event.signUps.length - 20} more`);
  } catch (error) {
    logErr(`Parsing failed: ${error.message}`);
    logErr("");
    logErr("Compare the raw payload above with the pick() calls in lib/raidhelper.mjs.");
    return 1;
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    logErr("");
    logErr(
      error instanceof SafeError
        ? `ERROR: ${error.message}`
        : `UNEXPECTED ERROR: ${error?.message ?? error}`
    );
    logErr("");
    process.exitCode = 1;
  });
