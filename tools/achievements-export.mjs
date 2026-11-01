#!/usr/bin/env node
/**
 * achievements-export.mjs — pull achievement metadata + icons out of the
 * game's source so the launcher can show a Steam-style grid.
 *
 *   node tools/achievements-export.mjs <gameId> "<path to game/ folder>"
 *
 * Reads:
 *   game/pregame.rpy              define ach1 = "On The First Day" …
 *   game/secretgallery_clean.rpy  achievement_hints, secret_achievements, gallery_pages
 *   game/options.rpy              config.save_directory
 *   game/images/ach/<Name>.jpg and <Name> Locked.jpg (100×100 icons)
 *
 * Writes:
 *   cdn/games/<id>/achievements.json
 *   cdn/games/<id>/ach/<n>.jpg, <n>-locked.jpg
 *   catalog.json → games[id].achievements + saveDirectory
 *
 * Re-run whenever achievements change, then `npm run sync`.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [gameId, gameDir] = process.argv.slice(2);
if (!gameId || !gameDir) {
  console.error('usage: node tools/achievements-export.mjs <gameId> "<path to game/ folder>"');
  process.exit(1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const CDN = path.join(here, "..", "cdn");
const read = (f) => fs.readFile(path.join(gameDir, f), "utf8");

// --- names: define achN = "…" (any .rpy) ---
const names = new Map();
for (const f of await fs.readdir(gameDir)) {
  if (!f.endsWith(".rpy")) continue;
  const src = await read(f);
  for (const m of src.matchAll(/^\s*(?:define|default)\s+ach(\d+)\s*=\s*"((?:[^"\\]|\\.)*)"/gm)) {
    names.set(Number(m[1]), m[2].replace(/\\"/g, '"'));
  }
}
if (!names.size) { console.error("No `define achN = \"…\"` lines found."); process.exit(1); }

// --- hints / secret / pages from the gallery script ---
const gal = await read("secretgallery_clean.rpy");
const hints = new Map();
const hintBlock = gal.match(/achievement_hints\s*=\s*\{([\s\S]*?)\n\s*\}/);
if (hintBlock) {
  for (const m of hintBlock[1].matchAll(/(\d+)\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    hints.set(Number(m[1]), m[2].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\s+/g, " ").trim());
  }
}
const secret = new Set((gal.match(/secret_achievements\s*=\s*\{([^}]*)\}/)?.[1] || "").split(",").map((s) => Number(s.trim())).filter(Boolean));
const pagesBlock = gal.match(/gallery_pages\s*=\s*\[([\s\S]*?)\n\s*\]/);
const order = [];
if (pagesBlock) {
  for (const row of pagesBlock[1].matchAll(/\[([^\]]*)\]/g)) {
    for (const n of row[1].split(",").map((s) => Number(s.trim())).filter(Boolean)) order.push(n);
  }
}
for (const id of [...names.keys()].sort((a, b) => a - b)) if (!order.includes(id)) order.push(id);

// --- save directory ---
const saveDirectory = (await read("options.rpy")).match(/config\.save_directory\s*=\s*"([^"]+)"/)?.[1] || null;

// --- icons ---
const outDir = path.join(CDN, "games", gameId);
const achDir = path.join(outDir, "ach");
await fs.mkdir(achDir, { recursive: true });
const exists = async (p) => !!(await fs.stat(p).catch(() => null));
let missing = 0;
const list = [];
for (const id of order) {
  const name = names.get(id);
  if (!name) continue;
  const icon = path.join(gameDir, "images", "ach", `${name}.jpg`);
  const locked = path.join(gameDir, "images", "ach", `${name} Locked.jpg`);
  const entry = { id, name, hint: hints.get(id) || "", secret: secret.has(id) };
  if (await exists(icon)) { await fs.copyFile(icon, path.join(achDir, `${id}.jpg`)); entry.icon = `games/${gameId}/ach/${id}.jpg`; } else missing++;
  if (await exists(locked)) { await fs.copyFile(locked, path.join(achDir, `${id}-locked.jpg`)); entry.iconLocked = `games/${gameId}/ach/${id}-locked.jpg`; }
  list.push(entry);
}
const secretLocked = path.join(gameDir, "images", "ach", "Secret Locked.jpg");
if (await exists(secretLocked)) await fs.copyFile(secretLocked, path.join(achDir, "secret-locked.jpg"));

const out = { gameId, total: list.length, secretLockedIcon: `games/${gameId}/ach/secret-locked.jpg`, achievements: list };
await fs.writeFile(path.join(outDir, "achievements.json"), JSON.stringify(out, null, 2));

// --- catalog hookup ---
const catalogPath = path.join(CDN, "catalog.json");
const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
const game = catalog.games.find((g) => g.id === gameId);
if (game) {
  game.achievements = `games/${gameId}/achievements.json`;
  if (saveDirectory) game.saveDirectory = saveDirectory;
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
}

console.log(`${list.length} achievements exported for ${gameId} (${secret.size} secret, ${missing} missing icons)`);
console.log(`  save directory: ${saveDirectory || "NOT FOUND — set games[].saveDirectory in catalog.json by hand"}`);
console.log(`  → cdn/games/${gameId}/achievements.json + ach/ icons${game ? " · catalog.json updated" : " · (game not in catalog.json yet)"}`);
console.log(`  Next: copy game-integration/launcher_sync.rpy into the game's game/ folder, then npm run sync`);
