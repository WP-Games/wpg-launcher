/**
 * Launcher backend — Cloudflare Worker. Studio settings: launcher.config.json.
 *
 * Replaces tools/serve.mjs in production. Speaks exactly the protocol the
 * launcher already uses:
 *
 *   GET /catalog.json                               public
 *   GET /games/<id>/cover.png | hero.jpg            public (anything not under versions/ or objects/)
 *   GET /auth/<provider>/start?redirect_uri&state   → provider login → /auth/<provider>/callback → launcher
 *   GET /auth/me                 Bearer <token>     → account (re-checked live with the provider) + fresh token
 *   GET /games/<id>/versions/<v>/manifest.json      Bearer → 401 anon / 403 tier too low or
 *                                                   not yet in this tier's release window (X-Available-At)
 *   GET /games/<id>/objects/<sha256>                Bearer → file bytes (Range supported)
 *
 * Files come from the R2 bucket bound as CDN (uploaded by tools/sync-r2.mjs).
 * Tier rules come from tools/tiers.json, bundled at deploy time.
 */
import * as patreon from "../../tools/patreon.mjs";
import * as substar from "../../tools/subscribestar.mjs";
import tiers from "../../tools/tiers.json";
import cfg from "../../launcher.config.json";
import { resolveCode } from "../../tools/codes-lib.mjs";
import { withAccess, versionAccess, delayDaysFor } from "../../tools/access-lib.mjs";
import { seal, open, randomHex } from "./crypto.mjs";

const PROVIDERS = {
  patreon: {
    authorizeUrl: (env, redirectUri, state) => patreon.authorizeUrl({ clientId: env.PATREON_CLIENT_ID, redirectUri, state }),
    exchange: (env, code, redirectUri) => patreon.exchangeCode({ code, clientId: env.PATREON_CLIENT_ID, clientSecret: env.PATREON_CLIENT_SECRET, redirectUri }),
    lookup: async (accessToken) => withAccess(patreon.resolveTier(await patreon.fetchIdentity(accessToken), tiers), tiers),
    configured: (env) => !!(env.PATREON_CLIENT_ID && env.PATREON_CLIENT_SECRET),
  },
  subscribestar: {
    authorizeUrl: (env, redirectUri, state) => substar.authorizeUrl({ clientId: env.SUBSCRIBESTAR_CLIENT_ID, redirectUri, state }),
    exchange: (env, code, redirectUri) => substar.exchangeCode({ code, clientId: env.SUBSCRIBESTAR_CLIENT_ID, clientSecret: env.SUBSCRIBESTAR_CLIENT_SECRET, redirectUri }),
    lookup: async (accessToken) => withAccess(substar.resolveTier(await substar.fetchSubscriber(accessToken, substar.HOST, (line) => console.log(line)), tiers), tiers),
    configured: (env) => !!(env.SUBSCRIBESTAR_CLIENT_ID && env.SUBSCRIBESTAR_CLIENT_SECRET),
  },
};

const LAUNCHER_REDIRECT = /^http:\/\/127\.0\.0\.1:\d{2,5}\/callback$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (request.method === "POST" && p === "/auth/code") {
        if (env.AUTH_LIMITER) {
          const ip = request.headers.get("cf-connecting-ip") || "unknown";
          const { success } = await env.AUTH_LIMITER.limit({ key: ip });
          if (!success) return text(429, "too many requests — please wait a moment");
        }
        return authCode(request, env);
      }
      if (request.method !== "GET" && request.method !== "HEAD") return text(405, "method not allowed");

      let m;
      if (p === "/" || p === "/health") return text(200, `${cfg.server.workerName} ok`);
      if (p === "/catalog.json") return serveR2(env, request, "catalog.json", { public: true, cache: "no-cache" });
      if (p === "/catalog.json.sig") return serveR2(env, request, "catalog.json.sig", { public: true, cache: "no-cache" });
      if (p.startsWith("/auth/") && env.AUTH_LIMITER) {
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const { success } = await env.AUTH_LIMITER.limit({ key: ip });
        if (!success) return text(429, "too many requests — please wait a moment");
      }
      if (p === "/auth/me") return authMe(request, env);
      // Launcher installers + updater feed (public). /launcher/download → newest installer.
      if (p === "/launcher/download") return launcherDownload(env, request, url);
      if (p === "/launcher/latest.json") return serveR2(env, request, "launcher/latest.json", { public: true, cache: "public, max-age=300" });
      if ((m = p.match(/^\/launcher\/([0-9][\w.-]*)\/([^/]+)$/))) return serveR2(env, request, `launcher/${m[1]}/${decodeURIComponent(m[2])}`, { public: true, cache: "public, max-age=31536000, immutable" });
      if (p === "/.well-known/security.txt") return text(200, SECURITY_TXT);
      if ((m = p.match(/^\/auth\/(patreon|subscribestar)\/start$/))) return authStart(m[1], url, env);
      if ((m = p.match(/^\/auth\/(patreon|subscribestar)\/callback$/))) return authCallback(m[1], url, env);
      if ((m = p.match(/^\/games\/([a-z0-9-]+)\/(.+)$/))) return serveGameFile(m[1], m[2], request, env, ctx);
      return text(404, "not found");
    } catch (e) {
      console.error(e);
      return text(500, "server error");
    }
  },
};

// ---------- auth ----------

async function authStart(provider, url, env) {
  const prov = PROVIDERS[provider];
  const redirect = url.searchParams.get("redirect_uri") || "";
  const state = url.searchParams.get("state") || "";
  if (!LAUNCHER_REDIRECT.test(redirect)) return text(400, "bad redirect_uri");
  if (!prov.configured(env)) return page(503, "Not available yet", `${provider} sign-in isn't configured on the server.`);
  // Everything we need to finish the login rides along in the provider's
  // `state` param, encrypted, so there's nothing to store server-side.
  const nonce = await seal(env.SESSION_SECRET, { redirect, state, exp: Date.now() + 10 * 60_000, n: randomHex(8) });
  return Response.redirect(prov.authorizeUrl(env, callbackUrl(env, provider), nonce), 302);
}

async function authCallback(provider, url, env) {
  const prov = PROVIDERS[provider];
  const pend = await open(env.SESSION_SECRET, url.searchParams.get("state"));
  if (!pend) return page(400, "Login expired", "Please start again from the launcher.");
  const back = (q) => Response.redirect(`${pend.redirect}?${q}&state=${encodeURIComponent(pend.state)}`, 302);
  if (url.searchParams.get("error")) return back("error=access_denied");
  try {
    const tok = await prov.exchange(env, url.searchParams.get("code"), callbackUrl(env, provider));
    const account = await prov.lookup(tok.access_token);
    const token = await issueToken(env, provider, account, tok);
    console.log(`login ${provider} id=${account.userId} tier=${account.tier} (${account.tierName}) status=${account.patronStatus}`); // no name: the launcher shows it, we don't need to keep it
    return back(`token=${encodeURIComponent(token)}`);
  } catch (e) {
    console.error("login failed", provider, e);
    return page(500, "Login failed", "Something went wrong talking to " + (provider === "patreon" ? "Patreon" : "SubscribeStar") + ". Please close this tab and try again from the launcher.");
  }
}

/// Access codes (testers/friends): POST {code} → token, no provider involved.
async function authCode(request, env) {
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "bad request" }); }
  const account = withAccess(resolveCode(body?.code, tiers), tiers);
  if (!account) return json(401, { error: "That code isn't valid." });
  const token = await seal(env.SESSION_SECRET, {
    v: 1,
    provider: "code",
    acc: account,
    code: body.code,
    checked: Date.now(),
    exp: Date.now() + Number(env.TOKEN_DAYS || 7) * 86_400_000,
  });
  console.log(`login code ${account.displayName} tier=${account.tier}`);
  return json(200, { ...account, token });
}

function callbackUrl(env, provider) {
  return `${env.PUBLIC_URL}/auth/${provider}/callback`;
}

async function issueToken(env, provider, account, providerTokens) {
  const days = Number(env.TOKEN_DAYS || 30);
  return seal(env.SESSION_SECRET, {
    v: 1,
    provider,
    acc: account,
    pt: { at: providerTokens.access_token, rt: providerTokens.refresh_token || null },
    checked: Date.now(),
    exp: Date.now() + days * 86_400_000,
  });
}

async function session(request, env) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  return open(env.SESSION_SECRET, h.slice(7));
}

/** /auth/me — re-check the tier with the provider and hand back a refreshed token. */
async function authMe(request, env) {
  const s = await session(request, env);
  if (!s) return json(401, { error: "not signed in" });
  if (s.provider === "code") {
    // Re-check the code still exists (revocation) and refresh the level.
    const account = withAccess(resolveCode(s.code, tiers), tiers);
    if (!account) return json(401, { error: "code revoked" });
    const token = await seal(env.SESSION_SECRET, { ...s, acc: account, checked: Date.now() });
    return json(200, { ...account, token });
  }
  const prov = PROVIDERS[s.provider];
  let account = s.acc;
  let token = null;
  // Live re-check at most once a minute (the launcher calls this at startup,
  // before installs, and when the player clicks "Re-check").
  if (prov && s.pt?.at && Date.now() - (s.checked || 0) > 60_000) {
    try {
      account = await prov.lookup(s.pt.at);
      token = await seal(env.SESSION_SECRET, { ...s, acc: account, checked: Date.now() });
    } catch (e) {
      console.warn("live re-check failed; provider token probably expired", s.provider, String(e));
      // Provider token expired → make the player sign in again.
      return json(401, { error: "session expired" });
    }
  }
  return json(200, token ? { ...account, token } : account);
}

/// /launcher/download[?platform=windows|mac] → newest installer for that platform.
/// Without ?platform= we guess from the browser's User-Agent (Mac → .dmg) and
/// fall back to Windows. download.json: { version, windows: {url,file}, mac: {url,file}, url, file }.
async function launcherDownload(env, request, url) {
  const obj = await env.CDN.get("launcher/download.json");
  if (!obj) return text(404, "no launcher release yet");
  const d = await obj.json();
  const ua = request.headers.get("user-agent") || "";
  const wanted = url.searchParams.get("platform") || (/Macintosh|Mac OS X/i.test(ua) && !/Windows/i.test(ua) ? "mac" : "windows");
  const pick = (wanted === "mac" ? d.mac : d.windows) || d.windows || d.mac || (d.url ? { url: d.url } : null);
  if (!pick) return text(404, "no launcher release yet");
  return Response.redirect(pick.url, 302);
}

const SECURITY_TXT = `Contact: mailto:${cfg.studio.contactEmail}
Preferred-Languages: en
Policy: ${cfg.studio.privacyUrl || cfg.studio.website}
Expires: 2027-12-31T00:00:00.000Z
`;

// ---------- files ----------

async function serveGameFile(gameId, rest, request, env, ctx) {
  const gated = rest.startsWith("versions/") || rest.startsWith("objects/");
  if (gated) {
    const game = await gameFromCatalog(env, gameId);
    if (!game) return text(404, "unknown game");
    const required = game.requiredTier || 0;
    const vm = rest.match(/^versions\/([^/]+)\/manifest\.json$/);
    if (required > 0 || vm) {
      const s = await session(request, env);
      if (!s) return text(401, "sign in required");
      const tier = s.acc?.tier || 0;
      if (tier < required) return text(403, "tier too low");
      if (vm) {
        // Release windows: Day-1 tiers get a new version immediately, others
        // after their delay (tiers.json "levels"). Objects are only tier-gated —
        // they're useless without the manifest that names them.
        // Delay comes from tiers.json at request time (not the token) so edits apply on deploy.
        const access = versionAccess(game, decodeURIComponent(vm[1]), tier, delayDaysFor(tiers, tier));
        if (!access.ok && access.reason === "window") {
          return new Response("not yet available for your tier", { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "x-available-at": new Date(access.availableAt).toISOString() } });
        }
      }
    }
    // Objects are content-addressed → immutable; manifests change per version → short cache.
    const cache = rest.startsWith("objects/") ? "private, max-age=31536000, immutable" : "private, max-age=60";
    return serveR2(env, request, `games/${gameId}/${rest}`, { public: false, cache });
  }
  // Artwork: public and cacheable at the edge.
  return serveR2(env, request, `games/${gameId}/${rest}`, { public: true, cache: "public, max-age=3600" }, ctx);
}

let catalogCache = { at: 0, data: null };
async function gameFromCatalog(env, gameId) {
  if (Date.now() - catalogCache.at > 30_000) {
    const obj = await env.CDN.get("catalog.json");
    catalogCache = { at: Date.now(), data: obj ? await obj.json() : { games: [] } };
  }
  return catalogCache.data.games.find((g) => g.id === gameId) || null;
}

async function serveR2(env, request, key, opts, ctx) {
  if (key.includes("..")) return text(400, "bad path");
  const obj = await env.CDN.get(key, { range: request.headers, onlyIf: request.headers });
  if (obj === null) return text(404, "not found");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", opts.cache || "no-cache");
  if (opts.public) headers.set("access-control-allow-origin", "*");
  if (!headers.get("content-type")) headers.set("content-type", guessType(key));
  if (request.headers.has("range") && obj.range) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("content-length", String(length));
    return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers });
  }
  if (!("body" in obj)) return new Response(null, { status: 304, headers }); // onlyIf matched
  headers.set("content-length", String(obj.size));
  return new Response(request.method === "HEAD" ? null : obj.body, { status: 200, headers });
}

function guessType(key) {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

// ---------- helpers ----------

const text = (status, body) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (status, title, msg) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f14;color:#eceef5;font:16px/1.5 system-ui,Segoe UI,sans-serif}div{text-align:center;padding:2rem;max-width:420px}h1{font-weight:600;margin:0 0 .5rem}p{opacity:.7;margin:0}</style></head><body><div><h1>${title}</h1><p>${msg}</p></div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
