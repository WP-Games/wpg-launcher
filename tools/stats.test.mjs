import { test } from "node:test";
import assert from "node:assert/strict";
import {
  platformFromUserAgent, bucketFor, isFirstRequest, firstSeen, summarize, rowLabel, compareVersions, toCsv, statsPage, record, recordGameDownload,
} from "../worker/src/stats.mjs";

test("platform comes from the launcher's User-Agent; old launchers → unknown", () => {
  assert.equal(platformFromUserAgent("WhitePhantomGames-Launcher/0.1.3 (windows)"), "windows");
  assert.equal(platformFromUserAgent("WhitePhantomGames-Launcher/0.1.3 (macos)"), "mac");
  assert.equal(platformFromUserAgent("WhitePhantomGames-Launcher/0.1.3 (linux)"), "linux");
  assert.equal(platformFromUserAgent("WhitePhantomGames-Launcher/0.1.2"), "unknown");
  assert.equal(platformFromUserAgent(""), "unknown");
  assert.equal(platformFromUserAgent(null), "unknown");
});

test("accounts land in the right bucket; Creator and codes carry no tier name", () => {
  assert.deepEqual(bucketFor({ provider: "patreon", tier: 3, tierName: "Premium Supporter" }), { provider: "patreon", tier: "Premium Supporter" });
  assert.deepEqual(bucketFor({ provider: "subscribestar", tier: 1, tierName: "Supporter" }), { provider: "subscribestar", tier: "Supporter" });
  assert.deepEqual(bucketFor({ provider: "code", tier: 3, tierName: "Day One (code)", displayName: "Dev friend" }), { provider: "alpha", tier: "" });
  assert.deepEqual(bucketFor({ provider: "patreon", tier: 4, tierName: "Creator" }), { provider: "creator", tier: "" });
  assert.deepEqual(bucketFor({ provider: "subscribestar", tier: 4, tierName: "Creator" }), { provider: "creator", tier: "" });
  assert.deepEqual(bucketFor(null), { provider: "unknown", tier: "" });
});

test("only the first request of an Android download counts", () => {
  assert.equal(isFirstRequest(null), true);
  assert.equal(isFirstRequest("bytes=0-"), true);
  assert.equal(isFirstRequest("bytes=0-1048575"), true);
  assert.equal(isFirstRequest("bytes=1048576-"), false);
});

test("dedupe: the install dialog's size preview + the install itself count once", () => {
  const store = new Map();
  const t = 1_000_000;
  assert.equal(firstSeen("patreon:1:dlc:0.23.0", t, store), true);
  assert.equal(firstSeen("patreon:1:dlc:0.23.0", t + 5_000, store), false);
  assert.equal(firstSeen("patreon:2:dlc:0.23.0", t + 5_000, store), true); // someone else
  assert.equal(firstSeen("patreon:1:dlc:0.23.0", t + 11 * 60_000, store), true); // later again → a new download
});

test("record() is a no-op without the D1 binding, and never throws", async () => {
  assert.equal(record({}, null, { kind: "launcher" }), undefined);
  assert.equal(await recordGameDownload({}, null, { session: { provider: "patreon", acc: { userId: "9", tier: 3, tierName: "x", provider: "patreon" } }, gameId: "g", version: "1", userAgent: "" }), undefined);
});

test("record() writes one upsert row with the expected shape", async () => {
  const calls = [];
  const db = { prepare: (sql) => ({ bind: (...a) => ({ run: async () => { calls.push({ sql, a }); return {}; } }), run: async () => { calls.push({ sql }); return {}; } }) };
  const waits = [];
  await record({ STATS: db }, { waitUntil: (p) => waits.push(p) }, { kind: "game", game: "dlc", version: "0.23.0", platform: "windows", provider: "patreon", tier: "Premium Supporter" });
  assert.equal(waits.length, 1);
  const upsert = calls.find((c) => c.a);
  assert.match(upsert.sql, /ON CONFLICT/);
  assert.deepEqual(upsert.a.slice(1), ["game", "dlc", "0.23.0", "windows", "patreon", "Premium Supporter"]);
  assert.match(upsert.a[0], /^\d{4}-\d{2}-\d{2}$/);
});

const rows = [
  { kind: "launcher", game: "", version: "0.1.2", platform: "windows", provider: "", tier: "", n: 100 },
  { kind: "launcher", game: "", version: "0.1.2", platform: "mac", provider: "", tier: "", n: 10 },
  { kind: "launcher", game: "", version: "0.1.2", platform: "linux", provider: "", tier: "", n: 4 },
  { kind: "game", game: "dlc", version: "0.23.0", platform: "windows", provider: "subscribestar", tier: "Premium Supporter", n: 20 },
  { kind: "game", game: "dlc", version: "0.23.0", platform: "mac", provider: "subscribestar", tier: "Premium Supporter", n: 5 },
  { kind: "game", game: "dlc", version: "0.23.0", platform: "windows", provider: "patreon", tier: "Supporter", n: 9 },
  { kind: "android", game: "dlc", version: "0.23.0", platform: "android", provider: "patreon", tier: "Supporter", n: 2 },
  { kind: "game", game: "dlc", version: "0.23.0", platform: "unknown", provider: "alpha", tier: "", n: 3 },
  { kind: "game", game: "dlc", version: "0.23.0", platform: "windows", provider: "creator", tier: "", n: 7 },
  { kind: "game", game: "dlc", version: "0.22.3", platform: "windows", provider: "patreon", tier: "Supporter", n: 1 },
];

test("summarize: launcher totals, per-tier rows, Creator kept apart from totals, versions newest-first", () => {
  const s = summarize(rows);
  assert.deepEqual([s.launcher.counts.windows, s.launcher.counts.mac, s.launcher.counts.linux, s.launcher.counts.total], [100, 10, 4, 114]);
  assert.deepEqual(s.launcher.versions.map((v) => v.version), ["0.1.2"]);
  const dlc = s.games.dlc;
  assert.deepEqual(dlc.versions.map((v) => v.version), ["0.23.0", "0.22.3"]);
  const v = dlc.versions[0];
  const labels = v.rows.map((r) => r.label);
  assert.deepEqual(labels, ["Patreon · Supporter", "SubscribeStar · Premium Supporter", "Alpha Testers"]);
  const ss = v.rows.find((r) => r.label.startsWith("SubscribeStar"));
  assert.deepEqual([ss.counts.windows, ss.counts.mac, ss.counts.total], [20, 5, 25]);
  const pat = v.rows.find((r) => r.label.startsWith("Patreon"));
  assert.deepEqual([pat.counts.windows, pat.counts.android, pat.counts.total], [9, 2, 11]); // desktop + Android merge into one tier row
  assert.equal(v.total.total, 25 + 11 + 3); // Creator's 7 excluded
  assert.equal(v.creator.windows, 7);
  assert.equal(dlc.versions[1].creator, null);
});

test("labels and version ordering", () => {
  assert.equal(rowLabel("patreon", "Barrister Tier"), "Patreon · Barrister Tier");
  assert.equal(rowLabel("alpha", "whatever"), "Alpha Testers");
  assert.equal(rowLabel("creator", ""), "Creator (you)");
  assert.ok(compareVersions("0.23.0", "0.22.3") > 0);
  assert.ok(compareVersions("0.9.0", "0.10.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("CSV escapes commas/quotes; page renders the numbers and the exclusions", () => {
  const csv = toCsv([{ day: "2026-11-03", kind: "game", game: "dlc", version: "0.23.0", platform: "windows", provider: "patreon", tier: 'Tier "A", plus', n: 3 }]);
  assert.equal(csv.split("\n")[1], '2026-11-03,game,dlc,0.23.0,windows,patreon,"Tier ""A"", plus",3');
  const html = statsPage({ studio: "White Phantom Games", range: "all", summary: summarize(rows), titles: { dlc: "Defending Lydia Collier" }, generatedAt: "2026-11-03T20:00:00.000Z" });
  assert.match(html, /Defending Lydia Collier/);
  assert.match(html, /SubscribeStar · Premium Supporter<\/td><td>20<\/td><td>5<\/td>/); // Windows 20 · Mac 5
  assert.match(html, /Launcher 0\.1\.2<\/td><td>100<\/td><td>10<\/td><td>4<\/td>/);
  assert.match(html, /Creator \(you\) — not in totals/);
  assert.match(html, /Alpha Testers/);
  assert.doesNotMatch(html, /Dev friend/);
  assert.match(html, /name="robots" content="noindex/);
});
