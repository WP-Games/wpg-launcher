#!/usr/bin/env node
/**
 * publish-android.mjs — put an Android build (.apk) on the CDN for the phone
 * download portal (https://api.<studio>/android).
 *
 *   node tools/publish-android.mjs <gameId> <version> "<path\to\Game.apk>" [--notes "text"] [--release-date ISO]
 *
 *   --release-date  when Day-1 tiers get it (default: now). Other tiers unlock
 *                   releasedAt + their delayDays from tools/tiers.json "levels" —
 *                   exactly the same rules as the desktop versions.
 *
 * Example:
 *   node tools/publish-android.mjs defending-lydia-collier 0.22.4 "D:\builds\DefendingLydiaCollier-0.22.4-android.apk" --notes "New chapter"
 *
 * Copies the APK to cdn/games/<id>/android/<version>/<file>, records version,
 * size, sha256, date, releasedAt and notes in catalog.json → games[id].android
 * (newest first), then `npm run sync` uploads it. The APK name is kept as-is
 * (players see it in their Downloads folder), with spaces → dashes.
 */
import { createHash } from "node:crypto";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const [gameId, version, apkPath] = positional;
if (!gameId || !version || !apkPath) {
  console.error('usage: node tools/publish-android.mjs <gameId> <version> "<path to .apk>" [--notes "text"] [--release-date ISO]');
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const CDN = path.join(ROOT, "cdn");
const notes = opt("notes", "");
const releasedAtMs = Date.parse(opt("release-date", new Date().toISOString()));
if (!Number.isFinite(releasedAtMs)) { console.error("--release-date must be an ISO date, e.g. 2026-11-08 or 2026-11-08T18:00Z"); process.exit(1); }
const releasedAt = new Date(releasedAtMs).toISOString();

const st = await fs.stat(apkPath).catch(() => null);
if (!st?.isFile()) { console.error(`Not a file: ${apkPath}`); process.exit(1); }
if (!/\.apk$/i.test(apkPath)) { console.error("Expected a .apk file."); process.exit(1); }
if (st.size > 2 * 1024 ** 3) console.warn("Warning: over 2 GB — some older Android browsers struggle with downloads this size.");

const file = path.basename(apkPath).replace(/\s+/g, "-");
const outDir = path.join(CDN, "games", gameId, "android", version);
await fs.mkdir(outDir, { recursive: true });

// sha256 while copying (streamed; APKs are big)
process.stdout.write(`Copying ${file} (${(st.size / 1048576).toFixed(0)} MB)… `);
const hash = createHash("sha256");
await new Promise((res, rej) => {
  const rs = createReadStream(apkPath);
  rs.on("data", (c) => hash.update(c));
  rs.on("error", rej);
  rs.on("end", res);
});
await fs.copyFile(apkPath, path.join(outDir, file));
console.log("done");
const sha256 = hash.digest("hex");

// catalog
const catalogPath = path.join(CDN, "catalog.json");
const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
const game = catalog.games.find((g) => g.id === gameId);
if (!game) { console.error(`Game "${gameId}" isn't in catalog.json yet — publish the desktop build first (tools/publish.mjs).`); process.exit(1); }
game.android ||= { versions: [] };
game.android.versions = game.android.versions.filter((v) => v.version !== version);
game.android.versions.unshift({ version, file, size: st.size, sha256, date: releasedAt.slice(0, 10), releasedAt, notes });
game.android.latest = version;
await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");

// the portal's header logo lives at launcher/logo.png on the CDN
const logoSrc = path.join(ROOT, "src", config.launcher.logo || "logo.png");
const logoDst = path.join(CDN, "launcher", "logo.png");
if (!(await fs.stat(logoDst).catch(() => null)) && (await fs.stat(logoSrc).catch(() => null))) {
  await fs.mkdir(path.dirname(logoDst), { recursive: true });
  await fs.copyFile(logoSrc, logoDst);
}

console.log(`Android ${version} of ${gameId} staged: cdn/games/${gameId}/android/${version}/${file}`);
console.log(`  sha256 ${sha256}`);
console.log(`  Day-1 tiers from ${releasedAt}; others after their delay.`);
console.log(`  portal: ${config.server.apiUrl}/android`);
console.log(`Now run: npm run sync`);
