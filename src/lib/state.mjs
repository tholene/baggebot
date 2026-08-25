/**
 * Remembers who has already been bonked for which event, so that re-running
 * /bonk as stragglers trickle in never DMs the same person twice.
 *
 * Written to disk after every single successful DM rather than at the end of
 * the run: if the process dies mid-send, the people already reminded must stay
 * recorded. Losing the file means re-bonking real people, so writes are atomic
 * (write to a temp file, then rename, which is atomic on the same filesystem).
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SafeError, logErr } from "./safe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Overridable so the container can mount a volume somewhere else. Defaults to
 * <repo>/state, which is where a local checkout expects it.
 */
const STATE_DIR = process.env.STATE_DIR?.trim() || join(HERE, "..", "..", "state");
const STATE_FILE = join(STATE_DIR, "bonked.json");

/** Events older than this are dropped, so the file cannot grow without bound. */
const RETENTION_DAYS = 30;

export class BonkState {
  #data = {};

  /** { "<eventId>": { "<userId>": "<ISO timestamp>" } } */
  static async load() {
    const state = new BonkState();
    let text;
    try {
      text = await readFile(STATE_FILE, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return state; // first run
      throw new SafeError(`Could not read ${STATE_FILE}: ${error.message}`);
    }

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        state.#data = parsed;
      }
    } catch {
      // A corrupt state file must not take the bot down, but it also must not
      // be silently trusted - starting empty risks a double-bonk, so say so
      // loudly and keep the broken file for inspection.
      logErr(
        `WARNING: ${STATE_FILE} is not valid JSON. Starting with empty bonk history - ` +
          `people may be reminded twice. Inspect or delete the file.`
      );
    }
    return state;
  }

  /** Has this user already been reminded about this event? */
  wasBonked(eventId, userId) {
    return Boolean(this.#data[eventId]?.[userId]);
  }

  /** All user ids already reminded for this event. */
  bonkedFor(eventId) {
    return new Set(Object.keys(this.#data[eventId] ?? {}));
  }

  /** Record and persist immediately. Callers must await this before the next DM. */
  async record(eventId, userId, isoTimestamp) {
    this.#data[eventId] ??= {};
    this.#data[eventId][userId] = isoTimestamp;
    await this.#save();
  }

  /** Drop events whose newest entry is older than RETENTION_DAYS. */
  async prune(nowMs) {
    const cutoff = nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const [eventId, users] of Object.entries(this.#data)) {
      const newest = Object.values(users)
        .map((iso) => Date.parse(iso))
        .filter(Number.isFinite)
        .reduce((a, b) => Math.max(a, b), 0);
      if (newest && newest < cutoff) {
        delete this.#data[eventId];
        removed++;
      }
    }

    if (removed > 0) await this.#save();
    return removed;
  }

  async #save() {
    await mkdir(STATE_DIR, { recursive: true });
    const temporary = `${STATE_FILE}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.#data, null, 2), "utf8");
    await rename(temporary, STATE_FILE); // atomic on the same filesystem
  }
}
