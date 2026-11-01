#!/usr/bin/env node
/**
 * codes.mjs — access codes for testers and friends who aren't patrons.
 *
 *   npm run code -- new "Dev friend" 2        → prints a code like WPG-7K3Q-M8ZD-4HRT
 *   npm run code -- list
 *   npm run code -- revoke WPG-7K3Q-M8ZD-4HRT
 *
 * Codes are stored in tools/tiers.json under "codes" and compiled into the
 * Worker, so after any change run:  npm run worker:deploy
 *
 * In the launcher: Sign in → "Have a code?" → paste → they get the level you
 * chose (2 = Supporter view). The code is the whole credential, so only hand
 * them to people you trust; revoking takes effect within the token lifetime
 * (7 days) or at their next launcher start.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { normalizeCode } from "./codes-lib.mjs";
import { config } from "./config.mjs";
export { normalizeCode, resolveCode } from "./codes-lib.mjs";

function generateCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `${config.launcher.codePrefix}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

// ---- CLI ----
if (process.argv[1] && path.basename(process.argv[1]) === "codes.mjs") {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tiersPath = path.join(here, "tiers.json");
  const tiers = JSON.parse(await fs.readFile(tiersPath, "utf8"));
  tiers.codes ||= {};
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "new") {
    const [name, levelStr] = rest;
    if (!name) { console.error('usage: npm run code -- new "<who it\'s for>" <level 1-4>'); process.exit(1); }
    const level = Number(levelStr || 2);
    const code = generateCode();
    tiers.codes[code] = { name, level, created: new Date().toISOString().slice(0, 10) };
    await fs.writeFile(tiersPath, JSON.stringify(tiers, null, 2));
    console.log(`\n  ${code}   → ${name}, level ${level}\n\nAdded to tools/tiers.json. Run: npm run worker:deploy`);
  } else if (cmd === "list") {
    const entries = Object.entries(tiers.codes);
    if (!entries.length) console.log("No codes.");
    for (const [c, v] of entries) console.log(`  ${c}   level ${v.level}   ${v.name}${v.created ? `   (${v.created})` : ""}`);
  } else if (cmd === "revoke") {
    const want = normalizeCode(rest[0]);
    const key = Object.keys(tiers.codes).find((k) => normalizeCode(k) === want);
    if (!key) { console.error("No such code."); process.exit(1); }
    delete tiers.codes[key];
    await fs.writeFile(tiersPath, JSON.stringify(tiers, null, 2));
    console.log(`Revoked ${key}. Run: npm run worker:deploy`);
  } else {
    console.log('usage: npm run code -- new "<name>" <level> | list | revoke <code>');
  }
}
