/**
 * Minimal client for the Raid-Helper v4 API.
 *
 * Only reads. This module never writes to Raid-Helper: /bonk derives who is
 * unsigned, it does not modify the event.
 *
 * Verified against the live API while planning:
 *   GET /api/v4/events/{id}            -> {"reason":"unknown event"} for a bad id
 *   GET /api/v4/servers/{id}/events    -> 401 {"reason":"invalid token"} without a key
 *
 * The exact casing of the signup fields is not documented publicly, so every
 * field is read through pick(), which accepts the spellings the API has used
 * across versions. If none match we throw rather than quietly reporting that
 * nobody signed up - a silent empty signup list would DM the entire roster.
 */

import { SafeError, sleep, scrub } from "./safe.mjs";

const API = "https://raid-helper.xyz/api/v4";
const MAX_EVENT_PAGES = 20;
const USER_AGENT = "BaggeBot (guild raid signup reminders, v1.0)";

/** First present, non-null value among several candidate key spellings. */
function pick(object, ...keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function makeRaidHelperClient(apiKey) {
  return async function request(path, { retries = 3 } = {}) {
    let attempt = 0;

    while (true) {
      let response;
      try {
        response = await fetch(`${API}${path}`, {
          headers: {
            "User-Agent": USER_AGENT,
            ...(apiKey ? { Authorization: apiKey } : {}),
          },
        });
      } catch (networkError) {
        if (attempt++ >= retries) {
          throw new SafeError(
            `Could not reach Raid-Helper (${path}): ${networkError.message}`
          );
        }
        await sleep(Math.min(15_000, 1000 * 2 ** attempt));
        continue;
      }

      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        const wait =
          Number(body.retry_after) || Number(response.headers.get("retry-after")) || 5;
        if (attempt++ >= retries) {
          throw new SafeError("Raid-Helper is rate limiting us. Try again in a minute.");
        }
        await sleep(Math.ceil(wait * 1000) + 250);
        continue;
      }

      if (response.status >= 500 && attempt < retries) {
        attempt++;
        await sleep(Math.min(15_000, 1000 * 2 ** attempt));
        continue;
      }

      const text = await response.text().catch(() => "");

      if (response.status === 401 || response.status === 403) {
        throw new SafeError(
          `Raid-Helper rejected our API key. Ask a server admin to run /apikey in ` +
            `Discord and put the new key in RAID_HELPER_TOKEN.`
        );
      }

      if (response.status === 404) {
        throw new SafeError(`Raid-Helper has no such event or server (${path}).`);
      }

      if (!response.ok) {
        throw new SafeError(
          `Raid-Helper API error ${response.status} on ${path}: ${scrub(text).slice(0, 300)}`
        );
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new SafeError(`Raid-Helper returned a non-JSON response on ${path}.`);
      }
    }
  };
}

/** Unix seconds, whether the API hands us a number or a numeric string. */
function toUnixSeconds(value) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  // Tolerate milliseconds if the API ever switches units.
  return number > 100_000_000_000 ? Math.floor(number / 1000) : Math.floor(number);
}

/**
 * Reduce a raw Raid-Helper event to the handful of fields /bonk needs.
 * Throws if the signup list is missing entirely - see the note at the top.
 */
export function normaliseEvent(raw) {
  if (!raw || typeof raw !== "object") {
    throw new SafeError("Raid-Helper returned an unexpected event payload.");
  }

  const id = String(pick(raw, "id", "eventId", "event_id") ?? "");
  if (!id) throw new SafeError("Raid-Helper event payload has no id.");

  const rawSignUps = pick(raw, "signUps", "signups", "signUpList");
  if (!Array.isArray(rawSignUps)) {
    throw new SafeError(
      `Could not find a signup list in the Raid-Helper response for event ${id}. ` +
        `The API shape may have changed - run "npm run inspect -- <eventId>" to see ` +
        `the raw payload. Refusing to continue, because treating this as "nobody ` +
        `signed up" would DM the entire roster.`
    );
  }

  const signUps = rawSignUps
    .map((entry) => ({
      userId: String(pick(entry, "userId", "userid", "user_id", "id") ?? ""),
      name: String(pick(entry, "name", "username", "displayName") ?? ""),
      status:
        String(pick(entry, "className", "class", "status", "specName") ?? "") || "unknown",
    }))
    .filter((entry) => /^\d{17,20}$/.test(entry.userId));

  return {
    id,
    title: String(pick(raw, "title", "name") ?? "(untitled event)"),
    description: String(pick(raw, "description") ?? ""),
    serverId: String(pick(raw, "serverId", "serverid", "server_id", "guildId") ?? ""),
    channelId: String(pick(raw, "channelId", "channelid", "channel_id") ?? ""),
    startTime: toUnixSeconds(pick(raw, "startTime", "starttime", "start_time")),
    signUps,
    /** Every user id with any signup at all - absence and bench included. */
    signedUserIds: new Set(signUps.map((entry) => entry.userId)),
  };
}

export function makeRaidHelper(apiKey) {
  const request = makeRaidHelperClient(apiKey);

  return {
    /** Raw payload, for the inspect script. */
    async getEventRaw(eventId) {
      return request(`/events/${encodeURIComponent(eventId)}`);
    },

    async getEvent(eventId) {
      return normaliseEvent(await request(`/events/${encodeURIComponent(eventId)}`));
    },

    /**
     * All events Raid-Helper knows about for this server. Needs an API key.
     *
     * The response is paginated. Reading only the first page would silently
     * truncate the calendar, and this list decides which raid gets bonked, so
     * every page is fetched and the results deduplicated by event id.
     */
    async listEvents(serverId) {
      if (!apiKey) {
        throw new SafeError(
          "Listing a server's events needs RAID_HELPER_TOKEN. Ask a server admin to " +
            "run /apikey in Discord, or pass an explicit event with the `event:` option."
        );
      }

      const path = `/servers/${encodeURIComponent(serverId)}/events`;
      const first = await request(path);
      const collected = [];
      const seen = new Set();

      const absorb = (body) => {
        const events = Array.isArray(body) ? body : pick(body, "postedEvents", "events");
        if (!Array.isArray(events)) {
          throw new SafeError("Raid-Helper returned an unexpected event list payload.");
        }
        for (const event of events) {
          const id = String(pick(event, "id", "eventId", "event_id") ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          collected.push(event);
        }
      };

      absorb(first);

      const pages = Number(pick(first, "pages")) || 1;
      // A bound, so a malformed `pages` cannot turn this into a request storm.
      for (let page = 2; page <= Math.min(pages, MAX_EVENT_PAGES); page++) {
        absorb(await request(`${path}?page=${page}`));
      }

      const overall = Number(pick(first, "eventsOverall"));
      if (Number.isFinite(overall) && collected.length < overall) {
        // Say so rather than quietly working from a partial calendar.
        throw new SafeError(
          `Raid-Helper reports ${overall} events for this server but only ${collected.length} ` +
            `could be read across ${pages} page(s). Refusing to guess which raid is next - ` +
            `pass one explicitly with the \`event:\` option.`
        );
      }

      return collected;
    },

    /**
     * The soonest event that has not started yet. Returns null when the calendar
     * is empty ahead of us, which is a normal state, not an error.
     */
    async findNextEvent(serverId, nowSeconds, channelIds = []) {
      const events = await this.listEvents(serverId);
      const upcoming = events
        .map((event) => ({
          id: String(pick(event, "id", "eventId", "event_id") ?? ""),
          title: String(pick(event, "title", "name") ?? "(untitled event)"),
          channelId: String(pick(event, "channelId", "channelid", "channel_id") ?? ""),
          startTime: toUnixSeconds(pick(event, "startTime", "starttime", "start_time")),
        }))
        .filter((event) => event.id && event.startTime && event.startTime > nowSeconds)
        // Guilds post things other than raids. Only the signup channel counts.
        .filter((event) => channelIds.length === 0 || channelIds.includes(event.channelId))
        .sort((a, b) => a.startTime - b.startTime);

      if (upcoming.length === 0) return null;
      // The list endpoint is a summary; re-fetch the full event for its signups.
      return this.getEvent(upcoming[0].id);
    },
  };
}
