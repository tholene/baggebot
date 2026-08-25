/**
 * Works out who was supposed to sign up and did not.
 *
 * This reimplements what Raid-Helper's /unsigned reports, because that command
 * answers ephemerally and its output is therefore unreadable by any bot. The
 * upside of recomputing it is that we end up with real user IDs instead of
 * display names, which is what actually sending a DM requires.
 *
 *   unsigned = raider role - excluded roles - bots - anyone with any signup
 */

import { SafeError } from "./safe.mjs";

/**
 * @param guild        a discord.js Guild
 * @param config       { raiderRoleId, excludeRoleIds }
 * @returns Collection-backed array of GuildMember, sorted by display name
 */
export async function fetchRoster(guild, config) {
  // Populates the member cache from the gateway. Needs the Server Members
  // privileged intent; without it this resolves to a near-empty collection
  // rather than throwing, which would look like "everyone signed up".
  await guild.members.fetch();

  const role = await guild.roles.fetch(config.raiderRoleId).catch(() => null);
  if (!role) {
    throw new SafeError(
      `No role ${config.raiderRoleId} in this server. Check RAIDER_ROLE_ID in .env.`
    );
  }

  if (role.members.size === 0) {
    throw new SafeError(
      `The role ${role.name} has no members. If it genuinely should, the bot is ` +
        `probably missing the Server Members privileged intent - enable it in the ` +
        `Discord Developer Portal under Bot -> Privileged Gateway Intents.`
    );
  }

  const members = [...role.members.values()]
    .filter((member) => !member.user.bot)
    .filter((member) => !config.excludeRoleIds.some((id) => member.roles.cache.has(id)));

  members.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { role, members };
}

/**
 * Split the roster against an event's signups.
 *
 * `signedUserIds` counts every signup status - absence, tentative and bench
 * included. Those people answered; chasing them would be the bug.
 */
export function diffRoster({ members, signedUserIds }) {
  const unsigned = members.filter((member) => !signedUserIds.has(member.id));

  return {
    unsigned,
    signedCount: members.length - unsigned.length,
    rosterSize: members.length,
  };
}
