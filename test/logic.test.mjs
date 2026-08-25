/**
 * Tests for the parts of /bonk that can be checked without Discord.
 *
 * The cases that matter most are the ones where a bug would DM real people:
 * a missing signup list must throw rather than read as "nobody signed up", and
 * the bonk history must survive a restart or everyone gets reminded twice.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";

import { normaliseEvent } from "../src/lib/raidhelper.mjs";
import { renderMessage, loadTemplate, eventLink } from "../src/lib/bonk.mjs";
import { diffRoster } from "../src/lib/roster.mjs";
import { BonkState } from "../src/lib/state.mjs";
import { envSnowflakeList, envInt, SafeError } from "../src/lib/safe.mjs";

const STATE = new URL("../state/bonked.json", import.meta.url).pathname;

const fakeMember = (id, name) => ({
  id,
  displayName: name,
  toString: () => `<@${id}>`,
});

test("normaliseEvent accepts camelCase field names", () => {
  const event = normaliseEvent({
    id: "111", title: "Naxxramas", serverId: "999", channelId: "888",
    startTime: 1800000000,
    signUps: [{ userId: "11111111111111111", name: "A", className: "Mage" }],
  });
  assert.equal(event.id, "111");
  assert.equal(event.title, "Naxxramas");
  assert.equal(event.serverId, "999");
  assert.equal(event.startTime, 1800000000);
  assert.ok(event.signedUserIds.has("11111111111111111"));
});

test("normaliseEvent accepts lowercase field names", () => {
  const event = normaliseEvent({
    id: "1", signups: [{ userid: "22222222222222222", name: "B" }],
    starttime: "1800000000", serverid: "9", channelid: "8",
  });
  assert.ok(event.signedUserIds.has("22222222222222222"));
  assert.equal(event.startTime, 1800000000);
});

test("normaliseEvent tolerates millisecond timestamps", () => {
  assert.equal(normaliseEvent({ id: "1", signUps: [], startTime: 1800000000000 }).startTime, 1800000000);
});

test("absence, bench and tentative all count as signed up", () => {
  // The whole point: these people answered. Chasing them would be the bug.
  const event = normaliseEvent({
    id: "1",
    signUps: [
      { userId: "33333333333333333", className: "Absence" },
      { userId: "44444444444444444", className: "Bench" },
      { userId: "55555555555555555", className: "Tentative" },
    ],
  });
  assert.equal(event.signedUserIds.size, 3);
});

test("signups without a valid user id are dropped", () => {
  const event = normaliseEvent({
    id: "1", signUps: [{ userId: "notanid" }, { userId: "66666666666666666" }],
  });
  assert.equal(event.signedUserIds.size, 1);
});

test("a missing signup list throws instead of DMing the whole roster", () => {
  assert.throws(() => normaliseEvent({ id: "1", title: "x" }), /Could not find a signup list/);
});

test("renderMessage substitutes every placeholder", () => {
  const out = renderMessage(
    "Hey {user} ({name})! {event} starts {time_relative} ({time_absolute}). {link}",
    {
      member: fakeMember("77777777777777777", "Bagge"),
      event: { id: "111", title: "Naxx", channelId: "888", startTime: 1800000000 },
      guildId: "240837008212230144",
    }
  );
  assert.equal(out.match(/{[a-z_]+}/g), null, `unsubstituted placeholder: ${out}`);
  assert.ok(out.includes("<@77777777777777777>"));
  assert.ok(out.includes("<t:1800000000:R>"), "relative timestamp missing");
  assert.ok(out.includes("https://discord.com/channels/240837008212230144/888/111"));
});

test("renderMessage degrades when the event has no start time", () => {
  const out = renderMessage("{time_absolute} {time_relative} {link}", {
    member: fakeMember("1".repeat(17), "X"),
    event: { id: "1", title: "x", channelId: "", startTime: undefined },
    guildId: "1",
  });
  assert.ok(out.includes("(time TBD)"));
  assert.equal(out.match(/{[a-z_]+}/g), null);
});

test("eventLink returns empty rather than a broken URL", () => {
  assert.equal(eventLink("1", "", "3"), "");
  assert.equal(eventLink("1", "2", "3"), "https://discord.com/channels/1/2/3");
});

test("the real bonk-message.txt renders cleanly and fits in a DM", async () => {
  const out = renderMessage(await loadTemplate(), {
    member: fakeMember("7".repeat(17), "Bagge"),
    event: { id: "111", title: "Naxxramas", channelId: "888", startTime: 1800000000 },
    guildId: "240837008212230144",
  });
  assert.equal(out.match(/{[a-z_]+}/g), null, "template has an unknown placeholder");
  assert.ok(out.length < 2000, "DM exceeds Discord's 2000 character limit");
});

test("diffRoster splits signed, unsigned and already-bonked", () => {
  const members = [fakeMember("1", "A"), fakeMember("2", "B"), fakeMember("3", "C"), fakeMember("4", "D")];
  const diff = diffRoster({
    members, signedUserIds: new Set(["1"]), alreadyBonked: new Set(["2"]),
  });
  assert.deepEqual(diff.unsigned.map((m) => m.id), ["3", "4"]);
  assert.deepEqual(diff.skipped.map((m) => m.id), ["2"]);
  assert.equal(diff.signedCount, 1);
  assert.equal(diff.rosterSize, 4);
});

test("diffRoster reports nothing to do when everyone answered", () => {
  const diff = diffRoster({
    members: [fakeMember("1", "A")], signedUserIds: new Set(["1"]), alreadyBonked: new Set(),
  });
  assert.equal(diff.unsigned.length, 0);
});

test("envSnowflakeList parses, dedupes and rejects junk", () => {
  process.env.TEST_ROLES = " 111111111111111111 , 222222222222222222 ,111111111111111111 ";
  assert.deepEqual(envSnowflakeList("TEST_ROLES"), ["111111111111111111", "222222222222222222"]);
  process.env.TEST_ROLES = "";
  assert.deepEqual(envSnowflakeList("TEST_ROLES"), []);
  process.env.TEST_ROLES = "111111111111111111,nope";
  assert.throws(() => envSnowflakeList("TEST_ROLES"), SafeError);
  delete process.env.TEST_ROLES;
});

test("envInt rejects zero and non-numbers", () => {
  process.env.TEST_INT = "0";
  assert.throws(() => envInt("TEST_INT", 5), SafeError);
  process.env.TEST_INT = "abc";
  assert.throws(() => envInt("TEST_INT", 5), SafeError);
  process.env.TEST_INT = "";
  assert.equal(envInt("TEST_INT", 5), 5);
  delete process.env.TEST_INT;
});

test("bonk history survives a restart and scopes per event", async (t) => {
  t.after(() => rm(STATE, { force: true }));
  await rm(STATE, { force: true });

  const first = await BonkState.load();
  assert.equal(first.wasBonked("e1", "u1"), false, "fresh start should be empty");

  await first.record("e1", "u1", new Date().toISOString());
  const onDisk = JSON.parse(await readFile(STATE, "utf8"));
  assert.ok(onDisk.e1?.u1, "must be written before the next DM, not at the end of the run");

  // The case that matters: the process dies mid-send and comes back.
  const reloaded = await BonkState.load();
  assert.equal(reloaded.wasBonked("e1", "u1"), true, "would re-bonk someone after a crash");
  assert.equal(reloaded.wasBonked("e2", "u1"), false, "history must not leak across events");
});

test("prune drops stale events but keeps recent ones", async (t) => {
  t.after(() => rm(STATE, { force: true }));
  await rm(STATE, { force: true });

  const state = await BonkState.load();
  await state.record("ancient", "u9", new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString());
  await state.record("fresh", "u9", new Date().toISOString());

  assert.ok((await state.prune(Date.now())) >= 1, "did not prune a 60-day-old event");

  const after = await BonkState.load();
  assert.equal(after.wasBonked("ancient", "u9"), false);
  assert.equal(after.wasBonked("fresh", "u9"), true, "pruned an event that is still relevant");
});

test("a corrupt state file warns but does not take the bot down", async (t) => {
  t.after(() => rm(STATE, { force: true }));
  await writeFile(STATE, "{ this is not json", "utf8");
  const state = await BonkState.load();
  assert.equal(state.wasBonked("e1", "u1"), false);
});

test("login failures explain which switch to flip", async () => {
  const { explainLoginError } = await import("../src/lib/discord-errors.mjs");

  const intents = explainLoginError(new Error("Used disallowed intents"));
  assert.ok(intents instanceof SafeError);
  assert.match(intents.message, /Server Members Intent/);

  const token = explainLoginError(new Error("An invalid token was provided."));
  assert.ok(token instanceof SafeError);
  assert.match(token.message, /DISCORD_BOT_TOKEN/);

  // Anything unrecognised must pass through untouched rather than be dressed up
  // as an explanation we do not actually have.
  const unknown = new Error("something else entirely");
  assert.equal(explainLoginError(unknown), unknown);
});

test("findNextEvent only considers configured raid channels", async () => {
  const { makeRaidHelper } = await import("../src/lib/raidhelper.mjs");
  const RAID = "1279867299066675321";
  const OTHER = "1255092003109081120";
  const now = 1_000_000;

  // Stand in for the API: one page, a non-raid event scheduled sooner than the
  // real raid. Without the filter the sooner one wins and the wrong people get DMed.
  const page = {
    pages: 1, eventsOverall: 2,
    postedEvents: [
      { id: "a", title: "Roster thing", channelId: OTHER, startTime: now + 100 },
      { id: "b", title: "Thursday Raid", channelId: RAID, startTime: now + 200 },
    ],
  };
  const events = {
    a: { id: "a", title: "Roster thing", channelId: OTHER, startTime: now + 100, signUps: [] },
    b: { id: "b", title: "Thursday Raid", channelId: RAID, startTime: now + 200, signUps: [] },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const single = String(url).match(/\/events\/(\w+)$/);
    const body = single ? events[single[1]] : page;
    return new Response(JSON.stringify(body), { status: 200 });
  };

  try {
    const rh = makeRaidHelper("test-key");
    const filtered = await rh.findNextEvent("guild", now, [RAID]);
    assert.equal(filtered.id, "b", "picked an event outside the raid channel");

    const unfiltered = await rh.findNextEvent("guild", now, []);
    assert.equal(unfiltered.id, "a", "no filter should mean no filtering");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listEvents refuses a partial calendar rather than guessing", async () => {
  const { makeRaidHelper } = await import("../src/lib/raidhelper.mjs");
  const originalFetch = globalThis.fetch;
  // Claims 9 events overall but hands back 1 and says there is only one page.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ pages: 1, eventsOverall: 9, postedEvents: [{ id: "a" }] }),
      { status: 200 }
    );
  try {
    await assert.rejects(
      () => makeRaidHelper("k").listEvents("guild"),
      /only 1 could be read/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listEvents follows pagination and deduplicates", async () => {
  const { makeRaidHelper } = await import("../src/lib/raidhelper.mjs");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const page = Number(String(url).match(/page=(\d+)/)?.[1] ?? 1);
    const body = page === 1
      ? { pages: 2, eventsOverall: 3, postedEvents: [{ id: "a" }, { id: "b" }] }
      // "b" repeated across pages must not be counted twice.
      : { pages: 2, eventsOverall: 3, postedEvents: [{ id: "b" }, { id: "c" }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const events = await makeRaidHelper("k").listEvents("guild");
    assert.deepEqual(events.map((e) => e.id), ["a", "b", "c"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("emoji shortcodes resolve without mangling timestamp markup", async () => {
  const { makeEmojiResolver, renderMessage } = await import("../src/lib/bonk.mjs");

  // Stand-in for a Guild: only BONK exists here.
  const guild = {
    emojis: {
      cache: new Map([
        ["1", { name: "BONK", id: "1470388292447895730", available: true, animated: false }],
        ["2", { name: "spin", id: "222", available: true, animated: true }],
        ["3", { name: "gone", id: "333", available: false, animated: false }],
      ]).values
        ? { values: () => [
            { name: "BONK", id: "1470388292447895730", available: true, animated: false },
            { name: "spin", id: "222", available: true, animated: true },
            { name: "gone", id: "333", available: false, animated: false },
          ] }
        : null,
    },
  };
  const resolveEmoji = makeEmojiResolver(guild);

  assert.equal(resolveEmoji("hi :BONK:"), "hi <:BONK:1470388292447895730>");
  assert.equal(resolveEmoji("case :bonk: insensitive"), "case <:BONK:1470388292447895730> insensitive");
  assert.equal(resolveEmoji(":spin:"), "<a:spin:222>", "animated emoji need the a: prefix");

  // The important one: Discord's own markup must survive untouched.
  assert.equal(resolveEmoji("<t:1787855400:R>"), "<t:1787855400:R>");
  assert.equal(resolveEmoji("<t:1787855400:F> and :BONK:"), "<t:1787855400:F> and <:BONK:1470388292447895730>");

  // Unknown names, unavailable emoji and unicode are left alone.
  assert.equal(resolveEmoji(":notanemoji:"), ":notanemoji:");
  assert.equal(resolveEmoji(":gone:"), ":gone:");
  assert.equal(resolveEmoji("👍"), "👍");

  // And it composes with placeholder substitution in the real path.
  const out = renderMessage("{event} :BONK: starts {time_relative}", {
    member: { id: "1".repeat(17), displayName: "X", toString: () => "<@1>" },
    event: { id: "1", title: "Raid", channelId: "2", startTime: 1787855400 },
    guildId: "3",
    resolveEmoji,
  });
  assert.ok(out.includes("<:BONK:1470388292447895730>"));
  assert.ok(out.includes("<t:1787855400:R>"), "timestamp survived emoji resolution");
});

test("no guild means shortcodes pass through untouched", async () => {
  const { makeEmojiResolver } = await import("../src/lib/bonk.mjs");
  assert.equal(makeEmojiResolver(null)(":BONK:"), ":BONK:");
});
