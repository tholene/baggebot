/**
 * Bonk statistics, computed from the append-only log that /bonk writes
 * (logs/bonks.jsonl, see audit.mjs).
 *
 * Pure functions only: parsing and counting take text and return plain
 * objects, so they can be tested without Discord or the file system.
 */

import { readFile } from "node:fs/promises";

import { SafeError } from "./safe.mjs";
import { bonkLogFile } from "./audit.mjs";

/**
 * One JSON object per line. A torn last line (a hard kill mid-write) is
 * counted and skipped rather than failing the whole read.
 */
export function parseBonkLog(text) {
  const entries = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

/** Reads the log; a missing file just means nothing has been sent yet. */
export async function readBonkLog(file = bonkLogFile()) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { entries: [], malformed: 0 };
    throw new SafeError(`Could not read the bonk log: ${error.message}`);
  }
  return parseBonkLog(text);
}

/**
 * @param entries   records from the log
 * @param sinceMs   only count records at or after this time (ms since epoch)
 * @returns leaderboard of delivered bonks per person, with shared ranks for ties,
 *          plus totals. Only status "sent" counts as a bonk; failures are
 *          reported separately and skips are ignored.
 */
export function computeStats(entries, { sinceMs = null } = {}) {
  const inRange = entries.filter((entry) => {
    if (!entry?.at || !entry?.recipient?.id) return false;
    if (sinceMs === null) return true;
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && at >= sinceMs;
  });

  const sent = inRange.filter((entry) => entry.status === "sent");
  const failed = inRange.filter((entry) => entry.status === "failed");

  // Group by user id, not name: people rename themselves. The newest name wins.
  const people = new Map();
  for (const entry of sent) {
    const id = entry.recipient.id;
    const person = people.get(id) ?? { id, name: id, count: 0, events: new Set(), lastAt: "" };
    person.count++;
    if (entry.eventId) person.events.add(entry.eventId);
    if (entry.at >= person.lastAt) {
      person.lastAt = entry.at;
      person.name = entry.recipient.displayName || id;
    }
    people.set(id, person);
  }

  const sorted = [...people.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name)
  );

  // Standard competition ranking: 1, 2, 2, 4 ...
  let rank = 0;
  let previous = null;
  const leaderboard = sorted.map((person, index) => {
    if (person.count !== previous) {
      rank = index + 1;
      previous = person.count;
    }
    return {
      id: person.id,
      name: person.name,
      count: person.count,
      raids: person.events.size,
      lastAt: person.lastAt,
      rank,
      tied: sorted.filter((other) => other.count === person.count).length > 1,
    };
  });

  const byRaid = new Map();
  for (const entry of sent) {
    const title = entry.eventTitle || "Unknown raid";
    byRaid.set(title, (byRaid.get(title) ?? 0) + 1);
  }

  const times = inRange.map((entry) => entry.at).sort();

  return {
    leaderboard,
    totals: {
      sent: sent.length,
      failed: failed.length,
      people: people.size,
      raids: new Set(sent.map((entry) => entry.eventId).filter(Boolean)).size,
      runs: new Set(sent.map((entry) => entry.runId).filter(Boolean)).size,
    },
    byRaid: [...byRaid.entries()]
      .map(([title, count]) => ({ title, count }))
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)),
    firstAt: times[0] ?? null,
    lastAt: times.at(-1) ?? null,
  };
}

/**
 * The leaderboard as monospace lines for a code block:
 *   " 1  Stuart              ▰▰▰▰▰▰▰▰▰▰  8"
 *   "=2  Nerfadrian          ▰▰▰▰▰▰▰▰    6"
 * Bars are scaled to the top count so the shape survives large numbers.
 */
export function renderLeaderboard(leaderboard, { limit = 15, nameWidth = 18, barWidth = 10 } = {}) {
  const shown = leaderboard.slice(0, limit);
  if (shown.length === 0) return "";
  const max = shown[0].count;
  const countWidth = String(max).length;

  return shown
    .map((row) => {
      const rank = `${row.tied ? "=" : " "}${row.rank}`.padStart(3);
      const name =
        row.name.length > nameWidth ? `${row.name.slice(0, nameWidth - 1)}…` : row.name.padEnd(nameWidth);
      const filled = Math.max(1, Math.round((row.count / max) * barWidth));
      const bar = "▰".repeat(filled).padEnd(barWidth, " ");
      return `${rank}  ${name}  ${bar}  ${String(row.count).padStart(countWidth)}`;
    })
    .join("\n");
}
