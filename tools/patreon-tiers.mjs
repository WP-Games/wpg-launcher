#!/usr/bin/env node
/**
 * patreon-tiers.mjs — one-off helper: list your campaign's tiers and write
 * tools/tiers.json, which maps Patreon tier IDs to the launcher's numeric
 * levels.
 *
 *   node tools/patreon-tiers.mjs <creator access token>
 *
 * The creator access token is shown on your API client page at
 * https://www.patreon.com/portal/registration/register-clients (click the
 * client → "Creator's Access Token"). It's only used here, once, to read your
 * own campaign; it's not stored.
 *
 * Levels are assigned cheapest → most expensive (1, 2, 3 …). Edit tiers.json
 * afterwards if two tiers should unlock the same content, or to rename.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchCampaignTiers } from "./patreon.mjs";

const token = process.argv[2];
if (!token) {
  console.error("usage: node tools/patreon-tiers.mjs <creator access token>");
  process.exit(1);
}

const res = await fetchCampaignTiers(token);
const campaign = res.data?.[0];
if (!campaign) { console.error("No campaign found for this token."); process.exit(1); }

// Include unpublished ("grandfathered") tiers too — patrons still on them are
// reported with those tier ids and need a level like everyone else.
const tiers = (res.included || [])
  .filter((x) => x.type === "tier")
  .sort((a, b) => (a.attributes.amount_cents || 0) - (b.attributes.amount_cents || 0));

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, "tiers.json");
let existing = {};
try { existing = JSON.parse(await fs.readFile(outPath, "utf8")); } catch {}

// Levels: keep anything already in tiers.json; new tiers get a level by price
// using the existing byAmountCents rules if present, else by rank.
const rules = existing.patreon?.byAmountCents || [];
const levelByPrice = (cents) => rules.filter((r) => cents >= r.minCents).reduce((m, r) => Math.max(m, r.level), 0);
const mapping = {};
tiers.forEach((t, i) => {
  const prev = existing.patreon?.tiers?.[t.id];
  const legacy = t.attributes.published === false;
  const level = prev?.level ?? (rules.length ? levelByPrice(t.attributes.amount_cents || 0) : i + 1);
  mapping[t.id] = { level, name: prev?.name ?? t.attributes.title, amountCents: t.attributes.amount_cents, ...(legacy ? { legacy: true } : {}) };
});

const out = {
  ...existing,
  patreon: { campaignId: campaign.id, campaignName: campaign.attributes?.creation_name || "", tiers: mapping, byAmountCents: existing.patreon?.byAmountCents || [] },
};
await fs.writeFile(outPath, JSON.stringify(out, null, 2));

console.log(`Campaign: ${out.patreon.campaignName || campaign.id} (id ${campaign.id})\n`);
console.log("  level  price    tier id        name");
for (const [id, t] of Object.entries(mapping)) {
  console.log(`  ${String(t.level).padStart(5)}  ${("£" + (t.amountCents / 100).toFixed(2)).padEnd(8)} ${id.padEnd(14)} ${t.name}${t.legacy ? "   (legacy / unpublished)" : ""}`);
}
if (Object.values(mapping).some((t) => t.legacy)) {
  console.log("\nLegacy tiers were given a level by price. Edit tools/tiers.json if a legacy tier should unlock more, then `npm run worker:deploy`.");
}
console.log(`\nWritten to ${path.relative(process.cwd(), outPath)}.`);
console.log("Games in cdn/catalog.json use requiredTier = one of the levels above.");
