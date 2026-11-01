#!/usr/bin/env node
/**
 * release-launcher.mjs — put a freshly built launcher installer on the CDN so
 * existing launchers update themselves and the website can link to it.
 *
 *   1. Bump "version" in src-tauri/tauri.conf.json (e.g. 0.1.0 → 0.1.1)
 *   2. npm run build        (with TAURI_SIGNING_PRIVATE_KEY[_PASSWORD] set — see README)
 *   3. node tools/release-launcher.mjs --notes "What changed"
 *   4. npm run sync
 *
 * Copies the NSIS installer + its .sig from src-tauri/target/release/bundle/nsis
 * into cdn/launcher/<version>/ and writes cdn/launcher/latest.json in the
 * format Tauri's updater expects. Also keeps cdn/launcher/download.json so the
 * Worker can redirect /launcher/download to the newest installer.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const notesIdx = process.argv.indexOf("--notes");
const notes = notesIdx >= 0 ? process.argv[notesIdx + 1] : "";

const conf = JSON.parse(await fs.readFile(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const nsisDir = path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");

let entries;
try { entries = await fs.readdir(nsisDir); } catch { console.error(`No build found at ${nsisDir}. Run \`npm run build\` first.`); process.exit(1); }
const exe = entries.find((f) => f.endsWith("-setup.exe") && f.includes(`_${version}_`));
if (!exe) { console.error(`No *_${version}_*-setup.exe in ${nsisDir}. Did you bump the version in tauri.conf.json and rebuild?`); process.exit(1); }
const sigName = `${exe}.sig`;
let signature;
try { signature = (await fs.readFile(path.join(nsisDir, sigName), "utf8")).trim(); }
catch { console.error(`Missing ${sigName}. Build with TAURI_SIGNING_PRIVATE_KEY set so the updater signature is produced (see README → Launcher releases).`); process.exit(1); }

const outDir = path.join(ROOT, "cdn", "launcher", version);
await fs.mkdir(outDir, { recursive: true });
await fs.copyFile(path.join(nsisDir, exe), path.join(outDir, exe));
await fs.copyFile(path.join(nsisDir, sigName), path.join(outDir, sigName));

const base = "https://api.whitephantomgames.co.uk";
const url = `${base}/launcher/${version}/${encodeURIComponent(exe)}`;
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { "windows-x86_64": { signature, url } },
};
await fs.writeFile(path.join(ROOT, "cdn", "launcher", "latest.json"), JSON.stringify(latest, null, 2));
await fs.writeFile(path.join(ROOT, "cdn", "launcher", "download.json"), JSON.stringify({ version, url, file: exe }, null, 2));

const size = (await fs.stat(path.join(nsisDir, exe))).size;
console.log(`Launcher ${version} staged (${(size / 1048576).toFixed(1)} MB): cdn/launcher/${version}/${exe}`);
console.log(`  updater feed:  ${base}/launcher/latest.json`);
console.log(`  website link:  ${base}/launcher/download   (redirects to the newest installer)`);
console.log(`Now run: npm run sync`);
