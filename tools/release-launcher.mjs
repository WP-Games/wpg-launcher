#!/usr/bin/env node
/**
 * release-launcher.mjs — put a freshly built launcher on the CDN so existing
 * launchers update themselves and the website can link to it.
 *
 *   1. Bump "version" in src-tauri/tauri.conf.json (e.g. 0.1.0 → 0.1.1)
 *   2. npm run build        (with TAURI_SIGNING_PRIVATE_KEY[_PASSWORD] set — see README)
 *      Mac: build on the Mac (see README → "Mac build") and copy its three output
 *      files into incoming/mac/ on this PC.
 *   3. node tools/release-launcher.mjs --notes "What changed"
 *   4. npm run sync
 *
 * Picks up whatever builds exist for the current version:
 *   Windows  src-tauri/target/release/bundle/nsis/*_<version>_x64-setup.exe (+ .sig)
 *   Mac      incoming/mac/*.dmg, *.app.tar.gz, *.app.tar.gz.sig
 *   Linux    incoming/linux/*.AppImage, *.AppImage.sig
 * Published copies are renamed to "<installerName>-v.<version>_<arch>.<ext>" and
 * written to cdn/launcher/<version>/. cdn/launcher/latest.json (Tauri updater
 * feed) and cdn/launcher/download.json (what /launcher/download redirects to)
 * are MERGED: releasing the Mac build later keeps the Windows entry, and vice
 * versa, as long as the version matches. A new version starts a fresh file.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const notesIdx = process.argv.indexOf("--notes");
const notes = notesIdx >= 0 ? process.argv[notesIdx + 1] : "";

const conf = JSON.parse(await fs.readFile(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const name = config.launcher.installerName || "launcher";
const base = config.server.apiUrl;
const outDir = path.join(ROOT, "cdn", "launcher", version);
const latestPath = path.join(ROOT, "cdn", "launcher", "latest.json");
const downloadPath = path.join(ROOT, "cdn", "launcher", "download.json");

const readJson = async (p) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } };
const listDir = async (d) => { try { return await fs.readdir(d); } catch { return []; } };
const readSig = async (p) => {
  try { return (await fs.readFile(p, "utf8")).trim(); }
  catch { console.error(`Missing ${path.basename(p)}. Build with TAURI_SIGNING_PRIVATE_KEY set so the updater signature is produced (see README → Launcher releases).`); process.exit(1); }
};
const publish = async (src, publishedName) => {
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(src, path.join(outDir, publishedName));
  const size = (await fs.stat(src)).size;
  console.log(`  ${(size / 1048576).toFixed(1).padStart(6)} MB  cdn/launcher/${version}/${publishedName}`);
  return `${base}/launcher/${version}/${encodeURIComponent(publishedName)}`;
};

// Start from the existing feed if it's for this same version (so a Mac release
// after a Windows one keeps both), otherwise start fresh.
const prevLatest = await readJson(latestPath);
const prevDownload = await readJson(downloadPath);
const sameVersion = prevLatest?.version === version;
const platforms = sameVersion ? { ...(prevLatest.platforms || {}) } : {};
const download = sameVersion && prevDownload ? { ...prevDownload } : {};
let found = 0;

// ---- Windows (built on this PC) ----
const nsisDir = path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
const exe = (await listDir(nsisDir)).find((f) => f.endsWith("-setup.exe") && f.includes(`_${version}_`));
if (exe) {
  const arch = (exe.match(/_(x64|x86|arm64)-setup\.exe$/) || [])[1] || "x64";
  const published = `${name}-v.${version}_${arch}.exe`;
  const signature = await readSig(path.join(nsisDir, `${exe}.sig`));
  console.log("Windows:");
  const url = await publish(path.join(nsisDir, exe), published);
  await fs.copyFile(path.join(nsisDir, `${exe}.sig`), path.join(outDir, `${published}.sig`));
  platforms["windows-x86_64"] = { signature, url };
  download.windows = { url, file: published };
  found++;
}

// ---- Mac (built on the Mac, files copied into incoming/mac/) ----
const macDir = path.join(ROOT, "incoming", "mac");
const macFiles = await listDir(macDir);
const dmg = macFiles.find((f) => f.endsWith(".dmg") && f.includes(`_${version}_`));
const tgz = macFiles.find((f) => f.endsWith(".app.tar.gz"));
if (dmg || tgz) {
  if (!dmg || !tgz) { console.error(`incoming/mac/ needs all three Mac files for ${version}: the .dmg, the .app.tar.gz and its .sig (found: ${macFiles.join(", ") || "nothing"}).`); process.exit(1); }
  const arch = (dmg.match(/_(universal|aarch64|x64)\.dmg$/) || [])[1] || "universal";
  const signature = await readSig(path.join(macDir, `${tgz}.sig`));
  console.log("Mac:");
  const dmgUrl = await publish(path.join(macDir, dmg), `${name}-v.${version}_${arch}.dmg`);
  const tgzName = `${name}-v.${version}_${arch}.app.tar.gz`;
  const tgzUrl = await publish(path.join(macDir, tgz), tgzName);
  await fs.copyFile(path.join(macDir, `${tgz}.sig`), path.join(outDir, `${tgzName}.sig`));
  // A universal build serves both Mac architectures; the updater asks by the arch it runs on.
  const targets = arch === "universal" ? ["darwin-aarch64", "darwin-x86_64"] : arch === "aarch64" ? ["darwin-aarch64"] : ["darwin-x86_64"];
  for (const t of targets) platforms[t] = { signature, url: tgzUrl };
  download.mac = { url: dmgUrl, file: path.basename(decodeURIComponent(dmgUrl)) };
  found++;
}

// ---- Linux (built on the Linux Mint box, files copied into incoming/linux/) ----
const linuxDir = path.join(ROOT, "incoming", "linux");
const linuxFiles = await listDir(linuxDir);
const appimage = linuxFiles.find((f) => f.endsWith(".AppImage") && f.includes(`_${version}_`));
if (appimage) {
  const arch = (appimage.match(/_(amd64|x86_64|aarch64|arm64)\.AppImage$/) || [])[1] || "amd64";
  const signature = await readSig(path.join(linuxDir, `${appimage}.sig`));
  console.log("Linux:");
  const published = `${name}-v.${version}_${arch}.AppImage`;
  const url = await publish(path.join(linuxDir, appimage), published);
  await fs.copyFile(path.join(linuxDir, `${appimage}.sig`), path.join(outDir, `${published}.sig`));
  platforms[arch === "aarch64" || arch === "arm64" ? "linux-aarch64" : "linux-x86_64"] = { signature, url };
  download.linux = { url, file: published };
  found++;
}

if (!found) {
  console.error(`Nothing to release for ${version}.\n  Windows: expected *_${version}_*-setup.exe in ${nsisDir} (run \`npm run build\`).\n  Mac:     expected the .dmg / .app.tar.gz / .sig for ${version} in ${macDir}.\n  Linux:   expected the .AppImage / .sig for ${version} in ${linuxDir}.\nDid you bump the version in tauri.conf.json and rebuild?`);
  process.exit(1);
}

const latest = {
  version,
  notes: notes || (sameVersion ? prevLatest.notes : "") || "",
  pub_date: new Date().toISOString(),
  platforms,
};
// Back-compat: the top-level url/file are the Windows installer (what the Worker used before).
if (download.windows) { download.url = download.windows.url; download.file = download.windows.file; }
download.version = version;
await fs.writeFile(latestPath, JSON.stringify(latest, null, 2));
await fs.writeFile(downloadPath, JSON.stringify(download, null, 2));

console.log(`Launcher ${version} staged for: ${Object.keys(platforms).join(", ")}`);
console.log(`  updater feed:  ${base}/launcher/latest.json`);
console.log(`  website link:  ${base}/launcher/download   (?platform=windows · ?platform=mac · ?platform=linux)`);
console.log(`Now run: npm run sync`);
