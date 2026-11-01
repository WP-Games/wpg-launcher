/**
 * access-lib.mjs — tier release windows ("Day 1 / Day 4 / Day 8" access).
 *
 * Pure functions, shared by the Worker, tools/serve.mjs and the tests (no
 * Node built-ins so it bundles into Cloudflare Workers).
 *
 * tiers.json describes the launcher's numeric access levels once, centrally:
 *
 *   "levels": {
 *     "0": { "name": "No game access" },
 *     "1": { "name": "Supporter",   "delayDays": 7 },   // Day 8 release
 *     "2": { "name": "Law Student", "delayDays": 3 },   // Day 4 release
 *     "3": { "name": "Day One",     "delayDays": 0 },
 *     "4": { "name": "Creator",     "delayDays": 0 }
 *   }
 *
 * Every Patreon tier / SubscribeStar price / code maps to one of those levels.
 * A game version carries `releasedAt` (ISO date-time, set by publish.mjs).
 * A player on level L may download version V from  releasedAt(V) + delayDays(L).
 * A game's `requiredTier` is still the floor: below it nothing downloads at all.
 */
export const DAY_MS = 86_400_000;

export function levelInfo(tiers, level) {
  return tiers?.levels?.[String(level)] || {};
}

export function delayDaysFor(tiers, level) {
  const d = Number(levelInfo(tiers, level).delayDays);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Decorate an account (from patreon/subscribestar/code resolution) with its release delay. */
export function withAccess(account, tiers) {
  if (!account) return account;
  return { ...account, delayDays: delayDaysFor(tiers, account.tier) };
}

/** Epoch ms a version was released to Day-1 tiers. Falls back to `date`; 0 if unknown. */
export function versionReleasedAt(v) {
  const t = Date.parse(v?.releasedAt || v?.date || "");
  return Number.isFinite(t) ? t : 0;
}

export function versionAvailableAt(v, delayDays) {
  return versionReleasedAt(v) + (Number(delayDays) || 0) * DAY_MS;
}

/**
 * May a player (tier, delayDays) download `version` of `game` right now?
 * → { ok: true } | { ok: false, reason: "tier" } | { ok: false, reason: "window", availableAt }
 * A version missing from the catalog list is gated by tier only (older builds).
 */
export function versionAccess(game, version, tier, delayDays, now = Date.now()) {
  const required = game?.requiredTier || 0;
  if (required > 0 && (Number(tier) || 0) < required) return { ok: false, reason: "tier" };
  const v = (game?.versions || []).find((x) => x.version === version);
  if (!v) return { ok: true };
  const availableAt = versionAvailableAt(v, delayDays);
  return now >= availableAt ? { ok: true } : { ok: false, reason: "window", availableAt };
}

/** Newest version of `game` the player can download now (null if none). */
export function availableVersion(game, tier, delayDays, now = Date.now()) {
  const list = (game?.versions || []).filter((v) => versionAccess(game, v.version, tier, delayDays, now).ok);
  return list[0]?.version || null; // publish.mjs keeps `versions` newest-first
}
