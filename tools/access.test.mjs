import { test } from "node:test";
import assert from "node:assert/strict";
import { withAccess, delayDaysFor, versionAccess, availableVersion, DAY_MS } from "./access-lib.mjs";
import { resolveCode } from "./codes-lib.mjs";

const tiers = {
  levels: {
    "0": { name: "No game access" },
    "1": { name: "Supporter", delayDays: 7 },
    "2": { name: "Law Student", delayDays: 3 },
    "3": { name: "Day One", delayDays: 0 },
    "4": { name: "Creator" },
  },
  codes: { "WPG-AAAA-BBBB-CCCC": { name: "Friend", level: 3 } },
};

const T0 = Date.parse("2026-11-08T18:00:00Z");
const game = {
  id: "g", requiredTier: 1,
  versions: [
    { version: "0.23.0", releasedAt: new Date(T0).toISOString() },
    { version: "0.22.3", releasedAt: "2026-10-24T00:00:00Z" },
    { version: "0.22.0", date: "2026-09-01" }, // old entry without releasedAt
  ],
};

test("delayDays come from levels; missing/garbage → 0", () => {
  assert.equal(delayDaysFor(tiers, 1), 7);
  assert.equal(delayDaysFor(tiers, 3), 0);
  assert.equal(delayDaysFor(tiers, 4), 0);
  assert.equal(delayDaysFor({}, 1), 0);
  assert.equal(withAccess({ tier: 2 }, tiers).delayDays, 3);
  assert.equal(withAccess(null, tiers), null);
});

test("Day-1 tier downloads a new version immediately", () => {
  assert.deepEqual(versionAccess(game, "0.23.0", 3, 0, T0), { ok: true });
  assert.deepEqual(versionAccess(game, "0.23.0", 4, 0, T0 - 1).ok, false); // one ms before release: nobody
});

test("Supporter waits 7 days, Law Student 3 — to the minute", () => {
  const sup = versionAccess(game, "0.23.0", 1, 7, T0 + 7 * DAY_MS - 60_000);
  assert.equal(sup.ok, false);
  assert.equal(sup.reason, "window");
  assert.equal(sup.availableAt, T0 + 7 * DAY_MS);
  assert.equal(versionAccess(game, "0.23.0", 1, 7, T0 + 7 * DAY_MS).ok, true);
  assert.equal(versionAccess(game, "0.23.0", 2, 3, T0 + 3 * DAY_MS - 1).ok, false);
  assert.equal(versionAccess(game, "0.23.0", 2, 3, T0 + 3 * DAY_MS).ok, true);
});

test("below requiredTier is a tier refusal regardless of dates", () => {
  assert.deepEqual(versionAccess(game, "0.22.0", 0, 0, T0 + 999 * DAY_MS), { ok: false, reason: "tier" });
});

test("older versions stay available; unknown version is tier-gated only", () => {
  assert.equal(versionAccess(game, "0.22.3", 1, 7, T0).ok, true);
  assert.equal(versionAccess(game, "0.22.0", 1, 7, T0).ok, true); // date fallback, long past
  assert.equal(versionAccess(game, "0.1.0", 1, 7, T0).ok, true);
});

test("availableVersion picks the newest unlocked build for the tier", () => {
  assert.equal(availableVersion(game, 3, 0, T0), "0.23.0");
  assert.equal(availableVersion(game, 1, 7, T0 + DAY_MS), "0.22.3");
  assert.equal(availableVersion(game, 1, 7, T0 + 8 * DAY_MS), "0.23.0");
  assert.equal(availableVersion(game, 0, 0, T0), null);
});

test("code tier names come from the levels map", () => {
  const acc = withAccess(resolveCode("wpg-aaaa-bbbb-cccc", tiers), tiers);
  assert.equal(acc.tier, 3);
  assert.equal(acc.tierName, "Day One (code)");
  assert.equal(acc.delayDays, 0);
});
