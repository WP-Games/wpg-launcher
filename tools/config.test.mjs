import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "./config.mjs";

test("launcher.config.json loads and has well-formed values", () => {
  const c = loadConfig();
  assert.match(c.server.apiUrl, /^https:\/\/[^/]+$/, "apiUrl: https, no path, no trailing slash");
  assert.equal(new URL(c.server.apiUrl).host, c.server.customDomain, "customDomain must match apiUrl");
  assert.match(c.launcher.codePrefix, /^[A-Z0-9]{2,6}$/, "codePrefix: 2-6 upper-case letters/digits");
  assert.match(c.launcher.identifier, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "identifier: reverse-DNS");
  assert.ok(!/[\\/:*?"<>|]/.test(c.launcher.installFolder), "installFolder must be a plain folder name");
  assert.match(c.launcher.keyDir, /^\.[\w-]+$/, "keyDir: a dot-folder name like .wpg");
  assert.match(c.links.newsFeed, /^https?:\/\//);
});

test("configure output matches the config (run `npm run configure` if this fails)", async () => {
  const c = loadConfig();
  const ui = await fs.readFile(path.join(ROOT, "src", "config.js"), "utf8");
  assert.ok(ui.includes(JSON.stringify(c.server.apiUrl)), "src/config.js is stale");
  const tauri = JSON.parse(await fs.readFile(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  assert.equal(tauri.productName, c.launcher.productName);
  assert.equal(tauri.identifier, c.launcher.identifier);
  assert.deepEqual(tauri.plugins.updater.endpoints, [`${c.server.apiUrl}/launcher/latest.json`]);
  assert.notEqual(tauri.plugins.updater.pubkey, "", "updater pubkey must be set");
  const wrangler = await fs.readFile(path.join(ROOT, "worker", "wrangler.jsonc"), "utf8");
  assert.ok(wrangler.includes(JSON.stringify(c.server.bucket)) && wrangler.includes(JSON.stringify(c.server.workerName)), "worker/wrangler.jsonc is stale");
});
