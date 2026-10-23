/**
 * Tests for /missing: reading the post reference and building the report.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseMessageRef, excerpt, buildMissingReport } from "../src/lib/missing.mjs";
import { diffRoster } from "../src/lib/roster.mjs";

const G = "240837008212230144";
const C = "1279867299066675321";
const M = "1501938247050203236";

test("parseMessageRef reads links from every Discord client and bare IDs", () => {
  const full = { guildId: G, channelId: C, messageId: M };
  assert.deepEqual(parseMessageRef(`https://discord.com/channels/${G}/${C}/${M}`), full);
  assert.deepEqual(parseMessageRef(`https://ptb.discord.com/channels/${G}/${C}/${M}`), full);
  assert.deepEqual(parseMessageRef(`https://discordapp.com/channels/${G}/${C}/${M}`), full);
  assert.deepEqual(parseMessageRef(`<https://canary.discord.com/channels/${G}/${C}/${M}>`), full);
  assert.deepEqual(parseMessageRef(M), { guildId: null, channelId: null, messageId: M });
});

test("parseMessageRef rejects anything else", () => {
  assert.equal(parseMessageRef(""), null);
  assert.equal(parseMessageRef("the poll"), null);
  assert.equal(parseMessageRef(`https://discord.com/channels/@me/${C}/${M}`), null);
  assert.equal(parseMessageRef(`https://evil.example/channels/${G}/${C}/${M}`), null);
});

test("excerpt takes the first non-blank line and trims it", () => {
  assert.equal(excerpt("\n  Season plan poll  \nmore"), "Season plan poll");
  assert.equal(excerpt(""), "");
  assert.equal(excerpt("x".repeat(100), 10), `${"x".repeat(9)}…`);
});

const member = (id, displayName) => ({ id, displayName });
const roster = [member("1", "Ann"), member("2", "Bo"), member("3", "Cy")];
const post = { url: `https://discord.com/channels/${G}/${C}/${M}`, channelId: C, content: "Which night?" };

test("the report names who has not responded and counts the rest", () => {
  const diff = diffRoster({ members: roster, signedUserIds: new Set(["2", "99"]) });
  const report = buildMissingReport({
    post,
    roleId: "5",
    diff,
    responses: { reactions: [{ emoji: "✅", count: 2 }], pollVotes: 4 },
    invokedBy: { id: "7" },
    now: new Date("2026-10-23T12:00:00Z"),
  });

  assert.equal(report.title, "Missing: Which night?");
  assert.match(report.description, /\*\*1 of 3\*\* have responded/);
  assert.match(report.description, /4 poll votes · ✅ 2/);
  assert.deepEqual(report.fields, [{ name: "Not responded yet (2)", value: "Ann, Cy" }]);
});

test("an all-clear report has no list, and no poll line for a plain post", () => {
  const diff = diffRoster({ members: roster, signedUserIds: new Set(["1", "2", "3"]) });
  const report = buildMissingReport({
    post: { ...post, content: "" },
    roleId: "5",
    diff,
    responses: { reactions: [], pollVotes: null },
    invokedBy: { id: "7" },
  });

  assert.equal(report.title, "Missing responses");
  assert.deepEqual(report.fields, []);
  assert.match(report.description, /Everyone has responded/);
  assert.doesNotMatch(report.description, /poll/);
});
