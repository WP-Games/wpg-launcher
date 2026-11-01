/**
 * codes-lib.mjs — access-code lookup shared by the Worker and the local server.
 * Pure functions only (no Node built-ins) so it bundles into Cloudflare Workers.
 * The CLI that creates/revokes codes is tools/codes.mjs.
 */
export function normalizeCode(s) {
  return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Look a code up in tiers.json → Account-shaped object, or null. */
export function resolveCode(code, tiersConfig) {
  const want = normalizeCode(code);
  if (!want) return null;
  for (const [k, v] of Object.entries(tiersConfig?.codes || {})) {
    if (normalizeCode(k) === want) {
      return {
        provider: "code",
        userId: `code:${k}`,
        displayName: v.name || "Tester",
        avatar: "",
        tier: Number(v.level) || 0,
        tierName: v.tierName || (tiersConfig?.levels?.[String(v.level)]?.name ? `${tiersConfig.levels[String(v.level)].name} (code)` : `Level ${v.level} (code)`),
        patronStatus: "code",
      };
    }
  }
  return null;
}

