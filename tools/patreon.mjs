/**
 * patreon.mjs — real Patreon OAuth2 + tier resolution.
 *
 * Pure functions on top of the standard `fetch` API, so the exact same code
 * runs in the local Node test server (tools/serve.mjs) today and in the
 * Cloudflare Worker in production.
 *
 * Flow:
 *   authorizeUrl()  → send the player to Patreon to log in and click Allow
 *   exchangeCode()  → Patreon sends back a one-time code; swap it for an access token
 *   fetchIdentity() → ask Patreon who this is and which tiers they're entitled to
 *   resolveTier()   → map that to the launcher's numeric tier level using tiers.json
 */

const PATREON = "https://www.patreon.com";
export const SCOPES = "identity identity.memberships";

export function authorizeUrl({ clientId, redirectUri, state }) {
  const u = new URL(`${PATREON}/oauth2/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  const r = await fetch(`${PATREON}/api/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Patreon token exchange failed: ${r.status} ${await r.text()}`);
  return r.json(); // { access_token, refresh_token, expires_in, scope, token_type }
}

/** Identity + memberships for the logged-in patron (v2 API). */
export async function fetchIdentity(accessToken) {
  const u = new URL(`${PATREON}/api/oauth2/v2/identity`);
  u.searchParams.set("include", "memberships,memberships.currently_entitled_tiers,memberships.campaign");
  u.searchParams.set("fields[user]", "full_name,image_url"); // no email: we don't need it, so we don't ask
  u.searchParams.set("fields[member]", "patron_status,currently_entitled_amount_cents,last_charge_status");
  u.searchParams.set("fields[tier]", "title,amount_cents");
  const r = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Patreon identity failed: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Campaign tiers, using the *creator's* access token (shown on the API client page). */
export async function fetchCampaignTiers(creatorToken) {
  const u = new URL(`${PATREON}/api/oauth2/v2/campaigns`);
  u.searchParams.set("include", "tiers");
  u.searchParams.set("fields[campaign]", "creation_name,url");
  u.searchParams.set("fields[tier]", "title,amount_cents,published");
  const r = await fetch(u, { headers: { Authorization: `Bearer ${creatorToken}` } });
  if (!r.ok) throw new Error(`Patreon campaigns failed: ${r.status} ${await r.text()}`);
  return r.json();
}

/**
 * Turn an identity response into the launcher's Account shape.
 *
 * tiersConfig (tools/tiers.json):
 * {
 *   "patreon": {
 *     "campaignId": "1234567",
 *     "tiers": { "<patreonTierId>": { "level": 1, "name": "Supporter" }, ... },
 *     "byAmountCents": [ { "minCents": 500, "level": 1, "name": "Supporter" }, ... ],  // optional fallback
 *     "overrides": { "<patreonUserId>": { "level": 4, "name": "Creator" } }             // you, testers, friends
 *   }
 * }
 *
 * Returns { provider, displayName, avatar, tier, tierName, patronStatus }.
 * A non-patron (or lapsed/declined) gets tier 0.
 */
export function resolveTier(identity, tiersConfig) {
  const cfg = tiersConfig?.patreon || {};
  const user = identity.data?.attributes || {};
  const included = identity.included || [];
  const members = included.filter((x) => x.type === "member");
  const tiersById = Object.fromEntries(included.filter((x) => x.type === "tier").map((t) => [t.id, t]));

  // Pick the membership for OUR campaign (a patron may support many creators).
  const member = members.find((m) => !cfg.campaignId || m.relationships?.campaign?.data?.id === String(cfg.campaignId));

  let level = 0, name = "Not a patron", status = "none";
  if (member) {
    status = member.attributes?.patron_status || "none";
    const active = status === "active_patron" && member.attributes?.last_charge_status !== "Declined";
    if (active) {
      const entitled = (member.relationships?.currently_entitled_tiers?.data || []).map((d) => d.id);
      for (const id of entitled) {
        const m = cfg.tiers?.[id];
        if (m && m.level > level) { level = m.level; name = m.name || tiersById[id]?.attributes?.title || `Tier ${level}`; }
      }
      // Fallback: price-based mapping, for tiers not listed in tiers.json
      if (level === 0 && Array.isArray(cfg.byAmountCents)) {
        const cents = member.attributes?.currently_entitled_amount_cents || 0;
        for (const rule of cfg.byAmountCents) {
          if (cents >= rule.minCents && rule.level > level) { level = rule.level; name = rule.name; }
        }
      }
      if (level === 0) name = "Patron (tier not mapped)";
    } else if (status === "former_patron") {
      name = "Former patron";
    } else if (status === "declined_patron") {
      name = "Payment declined";
    }
  }

  // Per-user overrides (creator account, testers, comped friends) — highest wins.
  const ov = cfg.overrides?.[String(identity.data?.id)];
  if (ov && ov.level > level) { level = ov.level; name = ov.name || `Tier ${level}`; status = "override"; }

  return {
    provider: "patreon",
    userId: String(identity.data?.id || ""),
    displayName: user.full_name || "Patron",
    avatar: user.image_url || "",
    tier: level,
    tierName: name,
    patronStatus: status,
  };
}
