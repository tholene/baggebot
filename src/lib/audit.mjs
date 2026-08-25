/**
 * An append-only record of every DM /bonk attempts.
 *
 * This is NOT the bonk history that used to live in state.mjs. Nothing reads
 * this file back to decide who gets a DM - /bonk deliberately has no memory
 * between runs. This exists so a human can answer "what did we actually send,
 * to whom, and when", which is a question you want answered after the fact
 * rather than reconstructed from Discord.
 *
 * One JSON object per line (JSONL), so it appends cheaply, survives a partial
 * write at the end of the file, and can be read with `npm run log`, grep or jq.
 *
 * Writing here must never break a send that is otherwise working: an audit
 * failure is reported and swallowed.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logErr, scrub } from "./safe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolved per call rather than at import, so the location can be changed by
 * the environment (a mounted volume in the container) and so tests can point it
 * somewhere disposable.
 */
export function bonkLogFile() {
  return process.env.BONK_LOG_FILE?.trim() || join(HERE, "..", "..", "logs", "bonks.jsonl");
}

let warnedAboutFailure = false;

/**
 * @param record {{
 *   runId: string, eventId: string, eventTitle: string, eventStart: number|undefined,
 *   invokedBy: {id: string, tag: string},
 *   recipient: {id: string, displayName: string},
 *   status: "sent" | "failed" | "skipped",
 *   reason?: string, code?: number, message?: string
 * }}
 */
export async function recordBonk(record) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...record });

  const file = bonkLogFile();

  try {
    await mkdir(dirname(file), { recursive: true });
    // scrub() as a backstop - nothing here should contain a token, but this
    // file is the one artefact a human is most likely to paste somewhere.
    await appendFile(file, `${scrub(line)}\n`, "utf8");
  } catch (error) {
    // Say it once per process rather than once per recipient.
    if (!warnedAboutFailure) {
      warnedAboutFailure = true;
      logErr(
        `WARNING: could not write the bonk log at ${file}: ${error.message}. ` +
          `DMs are still being sent; only the record is missing.`
      );
    }
  }
}
