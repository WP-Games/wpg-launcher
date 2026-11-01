/**
 * subscribestar.mjs — SubscribeStar OAuth2 + subscription lookup.
 *
 * Same shape as patreon.mjs, built on the standard `fetch` API so it runs in
 * both the local Node server and the Cloudflare Worker.
 *
 * SubscribeStar tiers are price-based, so tiers.json maps subscription price
 * (in cents) to launcher levels:
 *
 *   "subscribestar": {
 *     "byPriceCents": [ { "minCents": 500, "level": 2, "name": "Supporter" }, ... ],
 *     "overrides":    { "<subscriberId>": { "level": 4, "name": "Creator" } }
 *   }
 */

// Your profile lives on subscribestar.art, so that's the OAuth host.
export const HOST = "https://subscribestar.art";
// Must match exactly the scopes ticked on the integration.
export const SCOPES = "subscriber.read+subscriber.payments.read+user.read";

export function authorizeUrl({ clientId, redirectUri, state, host = HOST }) {
  // Scopes are '+'-joined; URLSearchParams would encode '+' so build by hand.
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", state });
  return `${host}/oauth2/authorize?${q.toString()}&scope=${SCOPES}`;
}

export async function exchangeCode({ code, clientId, clientSecret, redirectUri, host = HOST }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
    grant_type: "authorization_code",
  });
  const r = await fetch(`${host}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!r.ok) throw new Error(`SubscribeStar token exchange failed: ${r.status} ${await r.text()}`);
  return r.json(); // { access_token, refresh_token, expires_in, scope, token_type }
}

export async function refreshToken({ refreshToken, clientId, clientSecret, host = HOST }) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  const r = await fetch(`${host}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  if (!r.ok) throw new Error(`SubscribeStar refresh failed: ${r.status}`);
  return r.json();
}

// Confirmed against the live API (2026-11-01) via introspection:
//   query { user: User, subscriber: Subscriber, content_provider_profile }
//   User       { id, name, avatar_url, subscriptions, payments, … }   — anyone who logs in
//   Subscriber { id, name, avatar_url, subscription: BasicSubscription, payments, … } — null unless they subscribe to US
export const FULL_QUERY = `{
  user { id name avatar_url }
  subscriber {
    id
    name
    avatar_url
    subscription {
      price
      active
      billing_failed
      cancelled
      last_time_charged_at
    }
  }
}`;

// Confirmed valid against the live API (2026-11-01): returns subscriber: null for non-subscribers.
export const SUBSCRIBER_QUERY = `{
  subscriber {
    id
    name
    avatar_url
    subscription {
      price
      active
      billing_failed
      cancelled
      last_time_charged_at
    }
  }
}`;

// Fallback if a field name is rejected by their schema (the public docs are thin).
const MINIMAL_QUERY = `{ subscriber { name subscription { price active } } }`;

export async function graphql(accessToken, query, host = HOST) {
  const r = await fetch(`${host}/api/graphql/v1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SubscribeStar API failed: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Ask the API to describe its own types — used to pin down field names. */
export async function introspect(accessToken, host = HOST) {
  const q = `{
    __schema { queryType { fields { name type { name kind ofType { name } } } } }
    subscriber: __type(name: "Subscriber") { fields { name type { name kind ofType { name kind } } } }
    subscription: __type(name: "Subscription") { fields { name type { name kind ofType { name kind } } } }
    user: __type(name: "User") { fields { name type { name kind ofType { name kind } } } }
  }`;
  return graphql(accessToken, q, host);
}

/**
 * Who is this, and do they subscribe to us?
 * `log` (optional) receives diagnostic lines — the raw responses and, if the
 * main query is rejected, the API's own description of its types.
 */
export async function fetchSubscriber(accessToken, host = HOST, log = () => {}) {
  let res = await graphql(accessToken, FULL_QUERY, host);
  if (res.errors?.length) {
    // Only log when something is off — includes the API's own schema description to debug against.
    log(`subscribestar full query → ${JSON.stringify(res).slice(0, 1500)}`);
    try { log(`subscribestar schema → ${JSON.stringify(await introspect(accessToken, host)).slice(0, 6000)}`); } catch (e) { log(`introspection failed: ${e}`); }
    res = await graphql(accessToken, SUBSCRIBER_QUERY, host);
  }
  if (res.errors?.length && !res.data?.subscriber) {
    res = await graphql(accessToken, MINIMAL_QUERY, host);
    log(`subscribestar minimal query → ${JSON.stringify(res).slice(0, 1500)}`);
  }
  if (res.errors?.length && !res.data?.subscriber) {
    throw new Error(`SubscribeStar API error: ${res.errors.map((e) => e.message).join("; ")}`);
  }
  return res.data;
}

/** Map the GraphQL response to the launcher's Account shape. */
export function resolveTier(data, tiersConfig) {
  const cfg = tiersConfig?.subscribestar || {};
  const sub = data?.subscriber || {};
  const who = { ...(data?.user || {}), ...sub }; // subscriber fields win when present
  const s = sub.subscription || sub.subscriptions?.[0] || null;

  let level = 0, name = "Not a subscriber", status = "none";
  if (s) {
    const active = s.active === true && !s.billing_failed && !s.cancelled;
    const cents = Number(s.price || 0);
    if (active) {
      status = "active";
      for (const rule of cfg.byPriceCents || []) {
        if (cents >= rule.minCents && rule.level > level) { level = rule.level; name = rule.name; }
      }
      if (level === 0) name = "Subscriber (tier not mapped)";
    } else if (s.billing_failed) { status = "billing_failed"; name = "Payment failed"; }
    else if (s.cancelled) { status = "cancelled"; name = "Subscription cancelled"; }
    else { status = "inactive"; name = "Subscription inactive"; }
  }

  const ov = cfg.overrides?.[String(who.id)];
  if (ov && ov.level > level) { level = ov.level; name = ov.name || `Tier ${level}`; status = "override"; }

  return {
    provider: "subscribestar",
    userId: String(who.id || ""),
    displayName: who.name || who.nickname || who.username || "SubscribeStar member",
    avatar: who.avatar_url || who.avatarUrl || who.avatar || "",
    tier: level,
    tierName: name,
    patronStatus: status,
  };
}
