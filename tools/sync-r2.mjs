#!/usr/bin/env node
/**
 * sync-r2.mjs — upload cdn/ to the Cloudflare R2 bucket the Worker serves from.
 *
 *   node tools/sync-r2.mjs            (or: npm run sync)
 *   node tools/sync-r2.mjs --dry-run  (show what would upload)
 *   node tools/sync-r2.mjs --local    (upload into `wrangler dev`'s local bucket instead)
 *
 * Needs a one-time `npx wrangler login` (in the worker/ folder).
 *
 * Objects under games/<id>/objects/ are content-addressed and immutable, so
 * once uploaded they're recorded in cdn/.r2-uploaded.json and never sent
 * again. Everything else (catalog.json, manifests, artwork) is small and is
 * re-uploaded every run. Typical update after `publish.mjs`: a handful of new
 * objects + the manifest + catalog.
 *
 * Two engines:
 *   • rclone (preferred, fast, parallel) — used automatically when an rclone
 *     remote called "r2" exists. One-time setup is in README → "Faster uploads".
 *   • wrangler, one file at a time — fallback, fine for small catalogs.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPrivateKey, signFile, verifyBytes, rawPublicKeyB64 } from "./signing.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const CDN = path.join(ROOT, "cdn");
const WORKER = path.join(ROOT, "worker");
import { config } from "./config.mjs";
const BUCKET = config.server.bucket;
const API = config.server.apiUrl;
const dry = process.argv.includes("--dry-run");
const local = process.argv.includes("--local");
const statePath = path.join(CDN, ".r2-uploaded.json");

// ---- sign before upload: catalog.json always (it's edited by hand), manifests if missing/stale ----
if (!dry) {
  const key = await loadPrivateKey();
  const pub = rawPublicKeyB64(key);
  const signedNow = [];
  const catalogPath = path.join(CDN, "catalog.json");
  await signFile(key, catalogPath); signedNow.push("catalog.json");
  async function* manifests(dir) {
    for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) yield* manifests(p);
      else if (d.name === "manifest.json") yield p;
    }
  }
  for await (const m of manifests(path.join(CDN, "games"))) {
    const bytes = await fs.readFile(m);
    const sig = await fs.readFile(`${m}.sig`, "utf8").catch(() => null);
    if (!sig || !verifyBytes(pub, bytes, sig.trim())) { await signFile(key, m); signedNow.push(path.relative(CDN, m)); }
  }
  console.log(`Signed: ${signedNow.join(", ")}`);
}

const rcloneOk = !local && !process.argv.includes("--wrangler") && hasRcloneRemote();
function hasRcloneRemote() {
  const r = spawnSync("rclone", ["listremotes"], { encoding: "utf8" });
  if (r.error) return false; // rclone not installed / not on PATH in this window
  return r.status === 0 && /^r2:$/m.test(r.stdout || "");
}
// wrangler fallback: run its JS entry point directly with this Node (no shell, no npx).
const WRANGLER_JS = path.join(WORKER, "node_modules", "wrangler", "bin", "wrangler.js");

if (rcloneOk) {
  // rclone does the diffing itself: objects/ are immutable so --ignore-existing
  // skips anything already in the bucket; the rest is small and is re-copied
  // only if size/modtime changed.
  console.log(`Uploading cdn/ to r2:${BUCKET} with rclone${dry ? " — dry run" : ""}…`);
  const common = ["--transfers", "16", "--checkers", "32", "--filter", "- .*", "--filter", "- .*/**", "--stats-one-line", "--stats", "10s"];
  if (dry) common.push("--dry-run");
  const run = (label, args) => {
    console.log(`\n${label}`);
    const r = spawnSync("rclone", args, { stdio: "inherit" });
    if (r.status !== 0) { console.error("rclone failed"); process.exit(1); }
  };
  // 1) game objects: immutable, so anything already in the bucket is skipped by name
  run("Game files (new objects only)…", ["copy", CDN, `r2:${BUCKET}`, ...common, "--filter", "+ games/*/objects/**", "--filter", "- **", "--ignore-existing"]);
  // 2) everything else (catalog, manifests, artwork): small, compared by checksum
  run("Catalog, manifests, artwork…", ["copy", CDN, `r2:${BUCKET}`, ...common, "--filter", "- games/*/objects/**", "--checksum"]);
  console.log(`\nDone. ${API}/catalog.json is up to date.`);
  process.exit(0);
}

let uploaded = new Set();
try { uploaded = new Set(JSON.parse(await fs.readFile(statePath, "utf8"))); } catch {}

async function* walk(dir) {
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(p);
    else if (d.isFile() && !d.name.startsWith(".")) yield p;
  }
}

const todo = [];
for await (const abs of walk(CDN)) {
  const key = path.relative(CDN, abs).split(path.sep).join("/");
  const immutable = /^games\/[^/]+\/objects\//.test(key);
  if (immutable && uploaded.has(key) && !local) continue;
  const { size } = await fs.stat(abs);
  todo.push({ abs, key, size, immutable });
}

const total = todo.reduce((n, f) => n + f.size, 0);
console.log(`${todo.length} file(s) to upload, ${(total / 1048576).toFixed(1)} MB${local ? " (local bucket)" : ""}${dry ? " — dry run" : ""} — via wrangler, one at a time${local ? "" : " (install rclone + an 'r2' remote for parallel uploads; see README)"}`);
if (dry) { for (const f of todo) console.log("  " + f.key); process.exit(0); }

let n = 0;
for (const f of todo) {
  n++;
  process.stdout.write(`[${n}/${todo.length}] ${f.key} (${(f.size / 1024).toFixed(0)} KB) … `);
  const args = [WRANGLER_JS, "r2", "object", "put", `${BUCKET}/${f.key}`, "--file", f.abs, local ? "--local" : "--remote", "--config", path.join(WORKER, "wrangler.jsonc")];
  const r = spawnSync(process.execPath, args, { cwd: WORKER, encoding: "utf8" });
  if (r.status !== 0) {
    console.log("FAILED");
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  console.log("ok");
  if (f.immutable && !local) {
    uploaded.add(f.key);
    await fs.writeFile(statePath, JSON.stringify([...uploaded], null, 0));
  }
}
console.log(`\nDone. ${local ? "Local bucket" : `${API}/catalog.json`} is up to date.`);
