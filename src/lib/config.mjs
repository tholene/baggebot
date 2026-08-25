/**
 * Loads and validates everything /bonk needs, once, at startup.
 *
 * The bot refuses to boot on a malformed config rather than discovering the
 * problem halfway through a send. Same principle as the one-shot scripts:
 * ambiguity fails closed.
 */

import {
  SafeError,
  env,
  envBotToken,
  envInt,
  envSnowflake,
  envSnowflakeList,
} from "./safe.mjs";

const DEFAULT_MAX_DM = 40;
const DEFAULT_DM_DELAY_MS = 2500;

/** Below this, pacing stops being pacing. */
const MIN_DM_DELAY_MS = 1000;

/**
 * @param requireBonkConfig  false when the caller only needs to identify the
 *   application and guild - register-commands.mjs has no use for the role IDs,
 *   and demanding them there would force a fully populated .env before the
 *   command can even be registered.
 */
export function loadConfig({ requireBonkConfig = true } = {}) {
  const token = envBotToken();
  const appId = envSnowflake("APP_ID");
  const guildId = envSnowflake("GUILD_ID");
  const raiderRoleId = envSnowflake("RAIDER_ROLE_ID", { required: requireBonkConfig });
  const officerRoleId = envSnowflake("OFFICER_ROLE_ID", { required: requireBonkConfig });
  const excludeRoleIds = envSnowflakeList("EXCLUDE_ROLE_IDS");
  // Accept either name: RAID_HELPER_TOKEN is what /apikey calls it, and
  // RAID_HELPER_API_KEY is what earlier versions of .env.example documented.
  const raidHelperApiKey = env("RAID_HELPER_TOKEN") || env("RAID_HELPER_API_KEY");

  const maxDm = envInt("MAX_DM", DEFAULT_MAX_DM);
  const dmDelayMs = envInt("DM_DELAY_MS", DEFAULT_DM_DELAY_MS);

  if (dmDelayMs < MIN_DM_DELAY_MS) {
    throw new SafeError(
      `DM_DELAY_MS is ${dmDelayMs}ms. Sending bulk DMs faster than one per ` +
        `${MIN_DM_DELAY_MS}ms is what gets bots flagged for spam. Raise it.`
    );
  }

  if (raiderRoleId && excludeRoleIds.includes(raiderRoleId)) {
    throw new SafeError(
      "RAIDER_ROLE_ID also appears in EXCLUDE_ROLE_IDS, which would exclude the " +
        "entire roster. Refusing to start."
    );
  }

  return {
    token,
    appId,
    guildId,
    raiderRoleId,
    officerRoleId,
    excludeRoleIds,
    raidHelperApiKey,
    maxDm,
    dmDelayMs,
  };
}
