/**
 * Sends the reminder DMs.
 *
 * Everything here is deliberately slow and sequential. Opening many DM channels
 * in quick succession is the exact pattern Discord's anti-spam systems flag, and
 * the consequence lands on the bot account, so this never parallelises and never
 * runs uncapped.
 *
 * A failed DM is usually not an error: plenty of people have DMs from server
 * members turned off, which surfaces as 50007. Those are collected and handed
 * back so an officer can chase them by hand.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SafeError, sleep, log } from "./safe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Overridable so the template can be mounted into the container separately. */
const TEMPLATE_FILE =
  process.env.BONK_MESSAGE_FILE?.trim() || join(HERE, "..", "..", "bonk-message.txt");

/** Discord API error codes we care about telling apart. */
const CANNOT_SEND_DM = 50007;

/**
 * Read the DM template from disk on every invocation, so officers can reword it
 * without restarting the bot.
 */
export async function loadTemplate() {
  let text;
  try {
    text = await readFile(TEMPLATE_FILE, "utf8");
  } catch (error) {
    throw new SafeError(
      `Could not read the DM template at ${TEMPLATE_FILE}: ${error.message}`
    );
  }
  if (!text.trim()) {
    throw new SafeError(`The DM template ${TEMPLATE_FILE} is empty. Refusing to send.`);
  }
  return text.trim();
}

export function eventLink(guildId, channelId, eventId) {
  if (!channelId) return "";
  return `https://discord.com/channels/${guildId}/${channelId}/${eventId}`;
}

/**
 * Fill the template. Timestamps use Discord's <t:unix:F> / <t:unix:R> markup so
 * each recipient sees the raid time in their own timezone rather than ours.
 */
export function renderMessage(template, { member, event, guildId }) {
  const link = eventLink(guildId, event.channelId, event.id);
  const replacements = {
    "{user}": member.toString(),
    "{name}": member.displayName,
    "{event}": event.title,
    "{time_absolute}": event.startTime ? `<t:${event.startTime}:F>` : "(time TBD)",
    "{time_relative}": event.startTime ? `<t:${event.startTime}:R>` : "soon",
    "{link}": link || "(see the raid signup channel)",
  };

  let out = template;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * Final per-recipient gate, re-checked immediately before the DM goes out. The
 * preview the officer approved may be minutes old by the time we reach the end
 * of the list; someone may have signed up or left in the meantime.
 */
function assertBonkable(member, { event, config, state }) {
  if (member.user.bot) {
    throw new SafeError(`${member.displayName} is a bot.`);
  }
  if (!member.roles.cache.has(config.raiderRoleId)) {
    throw new SafeError(`${member.displayName} no longer has the raider role.`);
  }
  if (config.excludeRoleIds.some((id) => member.roles.cache.has(id))) {
    throw new SafeError(`${member.displayName} holds an excluded role.`);
  }
  if (event.signedUserIds.has(member.id)) {
    throw new SafeError(`${member.displayName} has signed up since the preview.`);
  }
  if (state.wasBonked(event.id, member.id)) {
    throw new SafeError(`${member.displayName} was already reminded for this event.`);
  }
}

/**
 * @param onProgress called as (doneCount, total) every few sends, for the
 *                   officer's progress display. Failures here are ignored.
 * @returns { sent, failed, skipped, failures }
 */
export async function sendBonks({
  members,
  event,
  guildId,
  template,
  config,
  state,
  onProgress,
}) {
  const sent = [];
  const skipped = [];
  const failures = [];

  for (const [index, member] of members.entries()) {
    try {
      assertBonkable(member, { event, config, state });
    } catch (error) {
      // Not a failure - the world changed since the preview. Note it and move on.
      skipped.push({ member, reason: error.message });
      continue;
    }

    try {
      await member.send(renderMessage(template, { member, event, guildId }));
      // Persist before the next send: a crash here must not cause a re-bonk.
      await state.record(event.id, member.id, new Date().toISOString());
      sent.push(member);
      log(`[${index + 1}/${members.length}] bonked ${member.displayName} (${member.id})`);
    } catch (error) {
      const code = error?.code;
      const reason =
        code === CANNOT_SEND_DM
          ? "has DMs closed"
          : `DM failed (${error?.message ?? "unknown error"})`;
      failures.push({ member, reason, code });
      log(`[${index + 1}/${members.length}] FAILED ${member.displayName}: ${reason}`);

      // A missing-access or unauthorised response will repeat for everyone;
      // stop rather than grinding through the whole list against Discord.
      if (code === 40001 || code === 40002) {
        failures.push({
          member: null,
          reason: "Aborted: Discord rejected the bot's credentials.",
          code,
        });
        break;
      }
    }

    if (onProgress && (index + 1) % 5 === 0) {
      try {
        await onProgress(index + 1, members.length);
      } catch {
        // A failed progress edit must never abort a send that is working.
      }
    }

    // Pace every send except the last one.
    if (index < members.length - 1) await sleep(config.dmDelayMs);
  }

  return { sent, skipped, failures };
}
