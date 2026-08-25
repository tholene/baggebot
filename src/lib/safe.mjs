/**
 * Helpers shared by every script in this repo.
 *
 * These were previously copy-pasted into cleanup.mjs, purge-channel.mjs and
 * react.mjs. They are consolidated here so that the token-scrubbing rule in
 * particular has exactly one implementation: nothing in this project prints
 * anything that has not been through scrub().
 */

/** An error whose message is safe to show the user verbatim. */
export class SafeError extends Error {}

/** Never let the token appear in any output, even accidentally. */
export function scrub(text) {
  const token = process.env.DISCORD_BOT_TOKEN;
  let out = String(text ?? "");
  if (token && token.length > 4) out = out.split(token).join("<redacted-token>");
  // Both spellings, so a secret is never printed just because it was set under
  // the name this scrubber did not happen to know about.
  for (const name of ["RAID_HELPER_TOKEN", "RAID_HELPER_API_KEY"]) {
    const key = process.env[name];
    if (key && key.length > 4) out = out.split(key).join("<redacted-api-key>");
  }
  return out;
}

export const log = (...parts) => console.log(parts.map(scrub).join(" "));
export const logErr = (...parts) => console.error(parts.map(scrub).join(" "));

export const isSnowflake = (value) => /^\d{17,20}$/.test(String(value ?? "").trim());

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function env(name, fallback = "") {
  const raw = process.env[name];
  return (raw === undefined || raw === null ? fallback : String(raw)).trim();
}

/** Strictly boolean-ish: only the literal "true"/"false" are accepted. */
export function envBool(name, fallback) {
  const raw = env(name);
  if (raw === "") return fallback;
  const lowered = raw.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  throw new SafeError(
    `${name} must be exactly "true" or "false" (got ${JSON.stringify(raw)}).`
  );
}

/** A positive integer from the environment, or `fallback` when unset. */
export function envInt(name, fallback) {
  const raw = env(name);
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new SafeError(
      `${name} must be a positive integer or empty (got ${JSON.stringify(raw)}).`
    );
  }
  return Number(raw);
}

/** A required snowflake from the environment. Throws with a usable message. */
export function envSnowflake(name, { required = true } = {}) {
  const raw = env(name);
  if (!raw) {
    if (!required) return "";
    throw new SafeError(`${name} is required. Set it in .env (see .env.example).`);
  }
  if (!isSnowflake(raw)) {
    throw new SafeError(
      `${name} must be a numeric Discord snowflake ID (got ${JSON.stringify(raw)}). ` +
        `Enable Developer Mode in Discord, then right-click to copy the ID.`
    );
  }
  return raw;
}

/** A comma-separated snowflake list, e.g. EXCLUDE_ROLE_IDS. Empty is allowed. */
export function envSnowflakeList(name) {
  const raw = env(name);
  if (!raw) return [];
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (!isSnowflake(part)) {
      throw new SafeError(
        `${name} must be a comma-separated list of snowflake IDs ` +
          `(got ${JSON.stringify(part)}).`
      );
    }
  }
  return [...new Set(parts)];
}

/** The bot token, with the classic "I pasted the public key" mistake caught early. */
export function envBotToken(name = "DISCORD_BOT_TOKEN") {
  const token = env(name);
  if (!token) throw new SafeError(`Missing ${name}.`);
  if (token.length < 50 || /\s/.test(token)) {
    throw new SafeError(
      `${name} does not look like a Discord bot token. ` +
        `Use the token from the application's Bot page (not APP_ID/PUBLIC_KEY).`
    );
  }
  return token;
}
