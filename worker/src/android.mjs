/**
 * android.mjs — the Android download portal (phone-friendly web page).
 *
 *   GET  /android                         the page (language from ?lang, cookie, or Accept-Language)
 *   GET  /android/login/<provider>        → provider OAuth → /auth/<provider>/callback → /android/session
 *   GET  /android/session?token=…         sets the session cookie, redirects to /android
 *   POST /android/code      {code}        access code → session cookie
 *   POST /android/logout                  clears the cookie
 *   GET  /android/api/state               { account, games:[{…, android:{versions:[{…, access}]}}], … }
 *   GET  /android/download/<game>/<ver>   tier + release-window check → APK bytes (Range supported)
 *
 * The session is the same sealed token the desktop launcher uses, carried in
 * an HttpOnly cookie instead of a Bearer header. Tier rules, release windows
 * and access codes are shared with the launcher (tools/access-lib.mjs etc.).
 * APKs live at games/<id>/android/<version>/<file> in R2, listed in the
 * catalog's games[].android block (tools/publish-android.mjs).
 */
import { androidPage, pickLang } from "./android-page.mjs";

const COOKIE = "wpg_session";
const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Path=/android; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export async function handleAndroid(request, env, url, d, ctx) {
  const p = url.pathname;
  const base = env.PUBLIC_URL;
  let m;

  if (p === "/android" || p === "/android/") {
    if (request.method !== "GET") return d.text(405, "method not allowed");
    const lang = pickLang(request.headers.get("cookie"), request.headers.get("accept-language"), url.searchParams.get("lang"));
    const html = androidPage({
      lang,
      studio: { name: d.cfg.studio.name, website: d.cfg.studio.website, logo: `${base}/android/logo.png` },
      links: { eula: d.cfg.legal?.eulaUrl, privacy: d.cfg.legal?.privacyUrl, launcher: `${base}/launcher/download`, patreon: d.cfg.links?.patreonUpgrade || d.cfg.links?.patreon, subscribestar: d.cfg.links?.subscribestar },
    });
    const h = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };
    if (url.searchParams.get("lang")) h["set-cookie"] = `lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`;
    return new Response(html, { status: 200, headers: h });
  }

  if (p === "/android/logo.png") return d.serveR2(env, request, "launcher/logo.png", { public: true, cache: "public, max-age=86400" });

  if ((m = p.match(/^\/android\/login\/(patreon|subscribestar)$/))) {
    const prov = d.PROVIDERS[m[1]];
    if (!prov.configured(env)) return d.page(503, "Not available yet", `${m[1]} sign-in isn't configured on the server.`);
    const nonce = await d.seal(env.SESSION_SECRET, { redirect: `${base}/android/session`, state: "", exp: Date.now() + 10 * 60_000, n: d.randomHex(8) });
    return Response.redirect(prov.authorizeUrl(env, `${base}/auth/${m[1]}/callback`, nonce), 302);
  }

  if (p === "/android/session") {
    // Arrives from /auth/<provider>/callback with ?token=… (or ?error=…).
    const token = url.searchParams.get("token");
    if (!token) return Response.redirect(`${base}/android?error=1`, 302);
    const s = await d.open(env.SESSION_SECRET, token);
    if (!s) return Response.redirect(`${base}/android?error=1`, 302);
    const maxAge = Math.max(60, Math.floor(((s.exp || Date.now()) - Date.now()) / 1000));
    return new Response(null, { status: 302, headers: { location: `${base}/android`, "set-cookie": cookieHeader(token, maxAge) } });
  }

  if (p === "/android/code" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return d.json(400, { error: "bad request" }); }
    const account = d.withAccess(d.resolveCode(body?.code, d.tiers), d.tiers);
    if (!account) return d.json(401, { error: "That code isn't valid." });
    const days = Number(env.TOKEN_DAYS || 7);
    const token = await d.seal(env.SESSION_SECRET, { v: 1, provider: "code", acc: account, code: body.code, checked: Date.now(), exp: Date.now() + days * 86_400_000 });
    console.log(`android login code ${account.displayName} tier=${account.tier}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "set-cookie": cookieHeader(token, days * 86_400) } });
  }

  if (p === "/android/logout" && request.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "set-cookie": cookieHeader("", 0) } });
  }

  if (p === "/android/api/state") {
    const { session: s, refreshed } = await sessionFromCookie(request, env, d);
    const catalog = await d.catalog(env);
    const tier = s?.acc?.tier || 0;
    const delay = s ? d.delayDaysFor(d.tiers, tier) : 0;
    const games = (catalog.games || []).map((g) => {
      const vers = (g.android?.versions || []).map((v) => ({
        version: v.version, date: v.date || "", releasedAt: v.releasedAt || "", notes: v.notes || "", size: v.size || 0,
        access: s ? d.versionAccess({ requiredTier: g.requiredTier, versions: g.android.versions }, v.version, tier, delay) : { ok: false, reason: "tier" },
      }));
      return { id: g.id, title: g.title, tagline: g.tagline || "", cover: g.cover ? `${base}/${g.cover}` : "", hero: (g.android?.hero || g.hero) ? `${base}/${g.android?.hero || g.hero}` : "", requiredTier: g.requiredTier || 0, requiredTierName: g.requiredTierName || "", android: { versions: vers } };
    });
    const sup = catalog.support || {};
    const a = s?.acc || null;
    const upgradeUrl = !a || a.provider === "code" ? null : a.provider === "subscribestar" ? (sup.subscribestar || d.cfg.links?.subscribestar || null) : (sup.patreon || d.cfg.links?.patreonUpgrade || d.cfg.links?.patreon || null);
    const body = { account: a, games, upgradeUrl, dayOneTierName: sup.dayOneTierName || null, codePlaceholder: d.cfg.launcher?.codePrefix ? `${d.cfg.launcher.codePrefix}-XXXX-XXXX-XXXX` : "XXXX-XXXX-XXXX" };
    const h = { "content-type": "application/json", "cache-control": "no-store" };
    if (refreshed) h["set-cookie"] = cookieHeader(refreshed, Math.max(60, Math.floor(((s.exp || Date.now()) - Date.now()) / 1000)));
    else if (s === null && hasCookie(request)) h["set-cookie"] = cookieHeader("", 0); // expired/invalid → clear
    return new Response(JSON.stringify(body), { status: 200, headers: h });
  }

  if ((m = p.match(/^\/android\/download\/([a-z0-9-]+)\/([^/]+)$/))) {
    if (request.method !== "GET" && request.method !== "HEAD") return d.text(405, "method not allowed");
    const { session: s } = await sessionFromCookie(request, env, d);
    if (!s) return Response.redirect(`${base}/android`, 302);
    const gameId = m[1], version = decodeURIComponent(m[2]);
    const game = await d.gameFromCatalog(env, gameId);
    const v = game?.android?.versions?.find((x) => x.version === version);
    if (!game || !v) return d.text(404, "unknown version");
    const tier = s.acc?.tier || 0;
    const access = d.versionAccess({ requiredTier: game.requiredTier, versions: game.android.versions }, version, tier, d.delayDaysFor(d.tiers, tier));
    if (!access.ok) return d.text(403, access.reason === "window" ? "not yet available for your tier" : "tier too low");
    const key = `games/${gameId}/android/${version}/${v.file}`;
    const res = await d.serveR2(env, request, key, { public: false, cache: "private, max-age=0" });
    if ((res.status === 200 || res.status === 206) && request.method === "GET") {
      // One APK download = one count (resume/Range continuations skipped). No personal data — see stats.mjs.
      d.recordAndroidDownload?.(env, ctx, { session: s, gameId, version, rangeHeader: request.headers.get("range") });
    }
    if (res.status === 200 || res.status === 206) {
      const h = new Headers(res.headers);
      h.set("content-type", "application/vnd.android.package-archive");
      h.set("content-disposition", `attachment; filename="${v.file.replace(/[^\w.-]/g, "_")}"`);
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  }

  return d.text(404, "not found");
}

function hasCookie(request) {
  return new RegExp(`(?:^|;\\s*)${COOKIE}=`).test(request.headers.get("cookie") || "");
}

/** Session from the cookie, re-checked live with the provider at most once a minute (like /auth/me). */
async function sessionFromCookie(request, env, d) {
  const raw = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1];
  if (!raw) return { session: null, refreshed: null };
  const s = await d.open(env.SESSION_SECRET, raw);
  if (!s) return { session: null, refreshed: null };
  if (s.provider === "code") {
    const account = d.withAccess(d.resolveCode(s.code, d.tiers), d.tiers);
    if (!account) return { session: null, refreshed: null };
    return { session: { ...s, acc: account }, refreshed: null };
  }
  const prov = d.PROVIDERS[s.provider];
  if (prov && s.pt?.at && Date.now() - (s.checked || 0) > 60_000) {
    try {
      const account = await prov.lookup(s.pt.at);
      const next = { ...s, acc: account, checked: Date.now() };
      return { session: next, refreshed: await d.seal(env.SESSION_SECRET, next) };
    } catch (e) {
      console.warn("android: live re-check failed", s.provider, String(e));
      return { session: null, refreshed: null };
    }
  }
  return { session: s, refreshed: null };
}
