#!/usr/bin/env node
/**
 * publish.mjs — turn a game build folder into launcher-ready CDN files.
 *
 *   node tools/publish.mjs <gameId> <version> <buildFolder> [--exe Game.exe] [--notes "text"] [--release-date 2026-11-08T18:00Z] [--cdn ./cdn]
 *
 *   --release-date  when Day-1 tiers get it (default: now). Other tiers unlock
 *                   releasedAt + their delayDays from tools/tiers.json "levels".
 *
 * Example (Ren'Py "Build Distributions" → pc folder):
 *   node tools/publish.mjs midnight-manor 0.4.0 "D:\renpy\MidnightManor-0.4.0-pc" --exe MidnightManor.exe --notes "New chapter 4"
 *
 * Works with any Ren'Py distribution folder, including the "for markets"
 * build that bundles Windows + Mac + Linux. Each file is tagged with the
 * platform it belongs to (from Ren'Py's folder conventions) and the launcher
 * only downloads files for the platform it's running on — so you upload ONE
 * build and every platform is served from it.
 *
 * What it does:
 *   1. Walks the build folder, SHA-256 hashes every file.
 *   2. Copies each file to  cdn/games/<id>/objects/<sha256>  (skips ones already there,
 *      so unchanged files between versions cost nothing to store or upload).
 *      Files of 8 MiB or more (Ren'Py .rpa archives) are split into ~4 MiB
 *      content-defined chunks (tools/cdc.mjs) and stored chunk by chunk, so a
 *      new version of a 5 GB archive only adds the chunks that changed.
 *   3. Writes  cdn/games/<id>/versions/<version>/manifest.json
 *   4. Updates cdn/catalog.json: sets `latest`, prepends to `versions`.
 *
 * The cdn/ folder is exactly what you later sync to Cloudflare R2
 * (e.g. `rclone sync cdn/ r2:wpg-cdn/`), so local testing and production use
 * the same layout.
 */
import { createHash } from "node:crypto";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platformOf } from "./platform.mjs";
import { chunkFile, CHUNK_THRESHOLD } from "./cdc.mjs";
import { loadPrivateKey, signFile, rawPublicKeyB64 } from "./signing.mjs";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const [gameId, version, buildDir] = positional;
if (!gameId || !version || !buildDir) {
  console.error("usage: node tools/publish.mjs <gameId> <version> <buildFolder> [--exe Game.exe] [--notes text] [--release-date ISO] [--cdn ./cdn]");
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const cdn = path.resolve(opt("cdn", path.join(here, "..", "cdn")));
const notes = opt("notes", "");
const releasedAtMs = Date.parse(opt("release-date", new Date().toISOString()));
if (!Number.isFinite(releasedAtMs)) { console.error("--release-date must be an ISO date, e.g. 2026-11-08 or 2026-11-08T18:00Z"); process.exit(1); }
const releasedAt = new Date(releasedAtMs).toISOString();

async function* walk(dir) {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(p);
    else if (d.isFile()) yield p;
  }
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(p).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

const root = path.resolve(buildDir);
if (!(await exists(root))) { console.error(`Build folder not found: ${root}`); process.exit(1); }

const objectsDir = path.join(cdn, "games", gameId, "objects");
const versionDir = path.join(cdn, "games", gameId, "versions", version);
await fs.mkdir(objectsDir, { recursive: true });
await fs.mkdir(versionDir, { recursive: true });

const files = [];
let total = 0, copied = 0, reused = 0, copiedBytes = 0, chunkedFiles = 0;
for await (const abs of walk(root)) {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  // Skip junk that shouldn't ship.
  if (/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(rel)) continue;
  const stat = await fs.stat(abs);
  const platform = platformOf(rel);
  const entry = { path: rel, size: stat.size, sha256: "", ...(platform !== "all" ? { platform } : {}) };

  if (stat.size >= CHUNK_THRESHOLD) {
    // Big file → content-defined chunks, each stored as its own object.
    chunkedFiles++;
    const fh = await fs.open(abs, "r");
    try {
      const res = await chunkFile(fh, stat.size, async ({ sha256, data, offset }) => {
        const dest = path.join(objectsDir, sha256);
        if (await exists(dest)) reused++;
        else { await fs.writeFile(dest, data); copied++; copiedBytes += data.length; }
        process.stdout.write(`\r${files.length + 1} files hashed… ${rel} ${((offset + data.length) / 1048576).toFixed(0)}/${(stat.size / 1048576).toFixed(0)} MB   `);
      });
      entry.sha256 = res.sha256;
      entry.chunks = res.chunks;
    } finally {
      await fh.close();
    }
  } else {
    entry.sha256 = await hashFile(abs);
    const dest = path.join(objectsDir, entry.sha256);
    if (await exists(dest)) reused++;
    else { await fs.copyFile(abs, dest); copied++; copiedBytes += stat.size; }
  }
  files.push(entry);
  total += stat.size;
  process.stdout.write(`\r${files.length} files hashed…                                                        `);
}
files.sort((a, b) => a.path.localeCompare(b.path));

// Executables per platform. --exe overrides the Windows one.
const top = files.filter((f) => !f.path.includes("/"));
const exe = opt("exe", null) || (top.find((f) => /\.exe$/i.test(f.path)) || top.find((f) => /\.bat$/i.test(f.path)) || {}).path;
if (!exe || !files.some((f) => f.path === exe)) {
  console.error(`\nCould not find a Windows executable${exe ? ` "${exe}"` : ""} in the build. Pass --exe <name>.`);
  process.exit(1);
}
const exeLinux = (top.find((f) => /\.sh$/i.test(f.path)) || {}).path;
const appDir = files.map((f) => f.path.match(/^([^/]+\.app)\//i)?.[1]).find(Boolean);
const exeMac = appDir ? files.find((f) => f.path.startsWith(`${appDir}/Contents/MacOS/`))?.path : undefined;

const byPlatform = {};
for (const f of files) { const k = f.platform || "all"; byPlatform[k] = (byPlatform[k] || 0) + f.size; }

const manifest = { gameId, version, exe, ...(exeLinux ? { exeLinux } : {}), ...(exeMac ? { exeMac } : {}), totalSize: total, files };
const manifestPath = path.join(versionDir, "manifest.json");
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
// Sign: the launcher refuses manifests that don't verify against src-tauri/signing.pub.
const signingKey = await loadPrivateKey();
{
  const pubFile = path.join(here, "..", "src-tauri", "signing.pub");
  const embedded = (await fs.readFile(pubFile, "utf8").catch(() => "")).trim();
  if (embedded !== rawPublicKeyB64(signingKey)) {
    console.error(`\nYour signing key doesn't match src-tauri/signing.pub (the key compiled into the launcher).\nRun \`npm run keygen\` to write the matching public key, then rebuild the launcher.`);
    process.exit(1);
  }
}
await signFile(signingKey, manifestPath);

// Update catalog
const catalogPath = path.join(cdn, "catalog.json");
const catalog = (await exists(catalogPath)) ? JSON.parse(await fs.readFile(catalogPath, "utf8")) : { games: [] };
let game = catalog.games.find((g) => g.id === gameId);
if (!game) {
  game = { id: gameId, title: gameId, tagline: "", description: "", cover: `games/${gameId}/cover.png`, hero: `games/${gameId}/hero.jpg`, requiredTier: 1, requiredTierName: "Supporter", latest: version, versions: [] };
  catalog.games.push(game);
  console.log(`\nAdded new game "${gameId}" to catalog.json — edit its title/description/tier there.`);
}
game.latest = version;
game.versions = game.versions.filter((v) => v.version !== version);
game.versions.unshift({ version, date: releasedAt.slice(0, 10), releasedAt, notes });
await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
await signFile(signingKey, catalogPath);

console.log(`\n\nPublished ${gameId} v${version}  (Day-1 release ${releasedAt}; other tiers per tools/tiers.json levels.delayDays)`);
console.log(`  ${files.length} files, ${(total / 1048576).toFixed(1)} MB total`);
const mb = (n) => `${((n || 0) / 1048576).toFixed(1)} MB`;
if (Object.keys(byPlatform).length > 1) {
  console.log(`  shared ${mb(byPlatform.all)} · windows +${mb(byPlatform.windows)} · linux +${mb(byPlatform.linux)} · mac +${mb(byPlatform.mac)}`);
  console.log(`  a Windows player downloads ${mb((byPlatform.all || 0) + (byPlatform.windows || 0))}`);
}
console.log(`  ${copied} new objects (${(copiedBytes / 1048576).toFixed(1)} MB), ${reused} unchanged — players only download the new ones${chunkedFiles ? ` · ${chunkedFiles} large file(s) stored as chunks` : ""}`);
console.log(`  exe: ${exe}${exeLinux ? `  linux: ${exeLinux}` : ""}${exeMac ? `  mac: ${exeMac}` : ""}`);
console.log(`  manifest: ${path.relative(process.cwd(), manifestPath)} (signed)`);
