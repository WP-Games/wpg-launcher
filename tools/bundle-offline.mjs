#!/usr/bin/env node
/**
 * bundle-offline.mjs — snapshot the catalog's metadata into the launcher so a
 * fresh install shows the library before it has ever been online.
 *
 * Runs automatically before `npm run dev` / `npm run build` (see package.json).
 *
 *   cdn/catalog.json                         → src-tauri/bundled/catalog.json   (compiled into the exe)
 *   cdn/games/<id>/**  (except objects/, versions/) → src/bundled/games/<id>/** (artwork, achievements.json, ach icons)
 *   list of bundled files                    → src/bundled/index.json
 *
 * Game files themselves are never bundled — only the small stuff needed to
 * draw the library. Once online, the live catalog always wins.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const CDN = path.join(ROOT, "cdn");
const OUT_WEB = path.join(ROOT, "src", "bundled");
const OUT_RS = path.join(ROOT, "src-tauri", "bundled");

const catalogPath = path.join(CDN, "catalog.json");
let catalog;
try { catalog = JSON.parse(await fs.readFile(catalogPath, "utf8")); }
catch {
  // Fresh clone without cdn/ (it's git-ignored): write an empty snapshot so the
  // Rust build still has a file to include. The launcher then shows an empty
  // library until it reaches the server.
  await fs.mkdir(OUT_RS, { recursive: true });
  await fs.mkdir(OUT_WEB, { recursive: true });
  await fs.writeFile(path.join(OUT_RS, "catalog.json"), JSON.stringify({ games: [] }));
  await fs.writeFile(path.join(OUT_WEB, "index.json"), JSON.stringify({ files: [] }));
  console.log("bundle-offline: no cdn/catalog.json — wrote an empty snapshot");
  process.exit(0);
}

await fs.rm(OUT_WEB, { recursive: true, force: true });
await fs.mkdir(path.join(OUT_WEB, "games"), { recursive: true });
await fs.mkdir(OUT_RS, { recursive: true });

const files = [];
async function copyTree(srcDir, rel) {
  let entries;
  try { entries = await fs.readdir(srcDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === "objects" || e.name === "versions") continue;
      await copyTree(path.join(srcDir, e.name), `${rel}/${e.name}`);
    } else if (e.isFile() && !e.name.startsWith(".")) {
      const key = `${rel}/${e.name}`;
      const dest = path.join(OUT_WEB, ...key.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(path.join(srcDir, e.name), dest);
      files.push(key);
    }
  }
}
for (const g of catalog.games) await copyTree(path.join(CDN, "games", g.id), `games/${g.id}`);

await fs.writeFile(path.join(OUT_WEB, "index.json"), JSON.stringify({ generated: new Date().toISOString(), files }));
await fs.writeFile(path.join(OUT_RS, "catalog.json"), JSON.stringify(catalog, null, 2));

let bytes = 0;
for (const f of files) bytes += (await fs.stat(path.join(OUT_WEB, ...f.split("/")))).size;
console.log(`bundle-offline: ${catalog.games.length} game(s), ${files.length} file(s), ${(bytes / 1048576).toFixed(1)} MB snapshotted for first-run/offline use`);
