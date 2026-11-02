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
 *   game/tl/<Language>/*.rpy      `old "…"` / `new "…"` pairs → names & hints in the
 *                                 launcher's other languages (folder names below)
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

// --- translations from Ren'Py's tl/ folder ---
// Ren'Py translation folders → launcher language codes (src/i18n.js).
const TL_LANGS = { German: "de", Spanish: "es", BrazilianPortuguese: "pt-br", Russian: "ru", Japanese: "ja", TraditionalChinese: "zh-tw", SimplifiedChinese: "zh-cn" };
const unq = (str) => str.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\s+/g, " ").trim();
const tl = {}; // code → Map(english → translated)
for (const [folder, code] of Object.entries(TL_LANGS)) {
  const dir = path.join(gameDir, "tl", folder);
  let files;
  try { files = (await fs.readdir(dir)).filter((f) => f.endsWith(".rpy")); } catch { continue; }
  // sys_achievements.rpy first (where Ren'Py puts these), then the rest in case they moved.
  files.sort((a, b) => (a === "sys_achievements.rpy" ? -1 : b === "sys_achievements.rpy" ? 1 : a.localeCompare(b)));
  const map = new Map();
  for (const f of files) {
    const src = await fs.readFile(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/^\s*old\s+"((?:[^"\\]|\\.)*)"\s*\n\s*new\s+"((?:[^"\\]|\\.)*)"/gm)) {
      const en = unq(m[1]), tr = unq(m[2]);
      if (tr && !map.has(en)) map.set(en, tr);
    }
  }
  if (map.size) tl[code] = map;
}
const translate = (code, en) => (en && tl[code]?.get(en)) || null;

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
  // Per-language name/hint; English stays in `name`/`hint` (it's also the key the game writes to launcher_achievements.json).
  const i18n = {};
  for (const code of Object.keys(tl)) {
    const n = translate(code, name), h = translate(code, entry.hint);
    if (n || h) i18n[code] = { ...(n ? { name: n } : {}), ...(h ? { hint: h } : {}) };
  }
  if (Object.keys(i18n).length) entry.i18n = i18n;
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
for (const code of Object.keys(tl)) {
  const n = list.filter((a) => a.i18n?.[code]?.name).length, h = list.filter((a) => a.i18n?.[code]?.hint).length;
  console.log(`  ${code.padEnd(6)} names ${n}/${list.length}, hints ${h}/${list.filter((a) => a.hint).length}`);
}
console.log(`  save directory: ${saveDirectory || "NOT FOUND — set games[].saveDirectory in catalog.json by hand"}`);
console.log(`  → cdn/games/${gameId}/achievements.json + ach/ icons${game ? " · catalog.json updated" : " · (game not in catalog.json yet)"}`);
console.log(`  Next: copy game-integration/launcher_sync.rpy into the game's game/ folder, then npm run sync`);
