/**
 * Tests for /stats: counting bonks from logs/bonks.jsonl.
 *
 *   npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseBonkLog, computeStats, renderLeaderboard } from "../src/lib/stats.mjs";
import { buildStatsEmbed } from "../src/commands/stats.mjs";

let clock = Date.parse("2026-09-01T12:00:00Z");
const bonk = (id, name, { status = "sent", eventId = "e1", eventTitle = "Thursday Raid", runId = "r1", at } = {}) => ({
  at: at ?? new Date((clock += 60_000)).toISOString(),
  runId,
  eventId,
  eventTitle,
  invokedBy: { id: "1", tag: "officer" },
  recipient: { id, displayName: name },
  status,
});

test("parseBonkLog skips blank and torn lines instead of failing", () => {
  const text = `${JSON.stringify(bonk("10", "A"))}\n\n${JSON.stringify(bonk("11", "B"))}\n{"at":"2026-`;
  const { entries, malformed } = parseBonkLog(text);
  assert.equal(entries.length, 2);
  assert.equal(malformed, 1);
});

test("only delivered bonks count; failures are reported separately", () => {
  const stats = computeStats([
    bonk("10", "A"),
    bonk("10", "A", { status: "failed" }),
    bonk("11", "B", { status: "skipped" }),
  ]);
  assert.equal(stats.totals.sent, 1);
  assert.equal(stats.totals.failed, 1);
  assert.deepEqual(stats.leaderboard.map((row) => [row.name, row.count]), [["A", 1]]);
});

test("ties share a rank and the next rank skips (1, 2, 2, 4)", () => {
  const stats = computeStats([
    bonk("1", "Top"), bonk("1", "Top"), bonk("1", "Top"),
    bonk("2", "Bee"), bonk("2", "Bee"),
    bonk("3", "Ace"), bonk("3", "Ace"),
    bonk("4", "Low"),
  ]);
  assert.deepEqual(
    stats.leaderboard.map((row) => [row.name, row.rank, row.tied]),
    [["Top", 1, false], ["Ace", 2, true], ["Bee", 2, true], ["Low", 4, false]]
  );
});

test("a renamed person is one person, shown by their newest name", () => {
  const stats = computeStats([bonk("7", "OldName"), bonk("7", "NewName")]);
  assert.equal(stats.leaderboard.length, 1);
  assert.equal(stats.leaderboard[0].name, "NewName");
  assert.equal(stats.leaderboard[0].count, 2);
});

test("raids are counted per event, and the busiest raid comes first", () => {
  const stats = computeStats([
    bonk("1", "A", { eventId: "e1", eventTitle: "Thursday Raid" }),
    bonk("2", "B", { eventId: "e1", eventTitle: "Thursday Raid" }),
    bonk("1", "A", { eventId: "e2", eventTitle: "Tuesdays Raid" }),
  ]);
  assert.equal(stats.totals.raids, 2);
  assert.equal(stats.leaderboard[0].raids, 2);
  assert.deepEqual(stats.byRaid[0], { title: "Thursday Raid", count: 2 });
});

test("a period filter drops older bonks", () => {
  const stats = computeStats(
    [
      bonk("1", "Old", { at: "2026-08-01T00:00:00Z" }),
      bonk("2", "New", { at: "2026-10-01T00:00:00Z" }),
    ],
    { sinceMs: Date.parse("2026-09-15T00:00:00Z") }
  );
  assert.deepEqual(stats.leaderboard.map((row) => row.name), ["New"]);
  assert.equal(stats.firstAt, "2026-10-01T00:00:00Z");
});

test("renderLeaderboard aligns columns, marks ties and truncates long names", () => {
  const stats = computeStats([
    bonk("1", "Stuart"), bonk("1", "Stuart"),
    bonk("2", "A very very long display name"),
    bonk("3", "Fettbigg"),
  ]);
  const lines = renderLeaderboard(stats.leaderboard, { nameWidth: 10, barWidth: 4 }).split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ {2}1 {2}Stuart {4} {2}▰▰▰▰ {2}2$/);
  assert.match(lines[1], /^ =2 {2}A very ve… {2}▰▰ {4}1$/);
  assert.equal(new Set(lines.map((line) => line.length)).size, 1);
});

test("the embed stays inside Discord's field limits with a long board", () => {
  const entries = [];
  for (let i = 0; i < 60; i++) {
    for (let n = 0; n <= i % 9; n++) entries.push(bonk(String(i), `Raider number ${i} with a long name`));
  }
  const embed = buildStatsEmbed(computeStats(entries), { periodLabel: "all time" }).toJSON();
  for (const field of embed.fields) assert.ok(field.value.length <= 1024, field.name);
  assert.ok(embed.fields.some((field) => field.name.startsWith("Also bonked")));
});

test("an empty period says so instead of rendering an empty board", () => {
  const embed = buildStatsEmbed(computeStats([]), { periodLabel: "the last 7 days" }).toJSON();
  assert.match(embed.description, /No bonks delivered in the last 7 days/);
  assert.equal(embed.fields, undefined);
});
