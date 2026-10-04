#!/usr/bin/env node
/**
 * Prints the bonk log in a readable form.
 *
 *   npm run bonks                the last 20 DMs
 *   npm run bonks -- --all       everything
 *   npm run bonks -- --full      include the full message body of each DM
 *   npm run bonks -- --runs      one line per /bonk invocation instead
 *
 * Not to be confused with `npm run logs`, which tails the bot's own output
 * from the container. This one is the record of what was sent to people.
 *
 * Read-only. It never contacts Discord.
 */

import "dotenv/config";

import { readFile } from "node:fs/promises";

import { SafeError, log, logErr } from "../src/lib/safe.mjs";
import { bonkLogFile } from "../src/lib/audit.mjs";
import { parseBonkLog } from "../src/lib/stats.mjs";

const DEFAULT_LIMIT = 20;

function parseArgs(argv) {
  const out = { all: false, full: false, runs: false };
  for (const arg of argv) {
    if (arg === "--all") out.all = true;
    else if (arg === "--full") out.full = true;
    else if (arg === "--runs") out.runs = true;
    else throw new SafeError(`Unknown argument ${JSON.stringify(arg)}.`);
  }
  return out;
}

const ICON = { sent: "OK  ", failed: "FAIL", skipped: "skip" };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const BONK_LOG_FILE = bonkLogFile();

  let text;
  try {
    text = await readFile(BONK_LOG_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      log(`No bonk log yet at ${BONK_LOG_FILE}.`);
      log("It is written the first time /bonk actually sends something.");
      return 0;
    }
    throw new SafeError(`Could not read ${BONK_LOG_FILE}: ${error.message}`);
  }

  // A torn final line from a hard kill is counted as malformed, not fatal.
  const { entries, malformed } = parseBonkLog(text);

  if (entries.length === 0) {
    log(`${BONK_LOG_FILE} is empty.`);
    return 0;
  }

  log(`${BONK_LOG_FILE}`);
  log(`${entries.length} record(s)${malformed ? `, ${malformed} unreadable line(s)` : ""}\n`);

  if (args.runs) {
    const runs = new Map();
    for (const entry of entries) {
      const run = runs.get(entry.runId) ?? {
        at: entry.at,
        event: entry.eventTitle,
        by: entry.invokedBy?.tag ?? "?",
        sent: 0,
        failed: 0,
        skipped: 0,
      };
      run[entry.status] = (run[entry.status] ?? 0) + 1;
      runs.set(entry.runId, run);
    }
    for (const [runId, run] of runs) {
      log(
        `${run.at.slice(0, 16).replace("T", " ")}  ${run.sent} sent, ${run.failed} failed, ` +
          `${run.skipped} skipped  —  "${run.event}"  by ${run.by}  [${runId}]`
      );
    }
    return 0;
  }

  const shown = args.all ? entries : entries.slice(-DEFAULT_LIMIT);
  if (!args.all && entries.length > shown.length) {
    log(`(showing the last ${shown.length}; --all for everything)\n`);
  }

  for (const entry of shown) {
    const when = entry.at.slice(0, 16).replace("T", " ");
    const who = entry.recipient?.displayName ?? entry.recipient?.id ?? "?";
    log(
      `${ICON[entry.status] ?? entry.status}  ${when}  ${who.padEnd(20)} ` +
        `"${entry.eventTitle}"${entry.reason ? `  — ${entry.reason}` : ""}`
    );
    if (args.full && entry.message) {
      for (const line of entry.message.split("\n")) log(`        | ${line}`);
      log("");
    }
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
