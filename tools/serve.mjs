#!/usr/bin/env node
/**
 * serve.mjs — local stand-in for production, on http://127.0.0.1:8787
 *
 * In production these two jobs are split:
 *   • Cloudflare R2 (+ CDN) serves the files under /games/** and /catalog.json
 *   • A Cloudflare Worker does /auth/** (real Patreon/SubscribeStar OAuth) and
 *     checks the player's tier before handing out download URLs.
 *
 * Here one tiny Node server does both, with a MOCK login page so the whole
 * launcher flow can be tried without registering OAuth apps yet.
 *
 *   node tools/serve.mjs            (or: npm run serve)
 */
import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as patreon from "./patreon.mjs";
import { resolveCode } from "./codes-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Secrets live in .env (gitignored) — see .env.example
try { process.loadEnvFile(path.join(here, "..", ".env")); } catch {}
const PATREON_CLIENT_ID = process.env.PATREON_CLIENT_ID || "";
const PATREON_CLIENT_SECRET = process.env.PATREON_CLIENT_SECRET || "";
const REAL_PATREON = !!(PATREON_CLIENT_ID && PATREON_CLIENT_SECRET);
let TIERS_CONFIG = {};
try { TIERS_CONFIG = JSON.parse(await fs.readFile(path.join(here, "tiers.json"), "utf8")); } catch {}
const CDN = path.resolve(process.env.CDN_DIR || path.join(here, "..", "cdn"));
// Test-only content (Midnight Manor etc.) lives outside cdn/ so it never ships; the
// local server merges it in so demos and `cargo test` keep working.
const SAMPLE = path.resolve(path.join(here, "..", "sample-game", "cdn"));
const UI = path.resolve(path.join(here, "..", "src"));
const PORT = Number(process.env.PORT || 8787);

// ----- mock accounts: token -> account -----
// Tiers are numeric so the launcher can compare them against a game's
// requiredTier. Give them whatever names match your Patreon tiers.
const TIERS = [
  { tier: 0, tierName: "Free" },
  { tier: 1, tierName: "Just Following (£1)" },
  { tier: 2, tierName: "Supporter (£5)" },
  { tier: 3, tierName: "Premium Supporter (£10)" },
  { tier: 4, tierName: "Ultimate Supporter (£25)" },
];
const sessions = new Map();
// Pending real-OAuth logins: our nonce -> { redirect, state } from the launcher
const pending = new Map();

const MIME = {
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8",
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".xml": "application/rss+xml; charset=utf-8",
};

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f14;color:#eceef5;font:15px/1.5 system-ui,Segoe UI,sans-serif}
.box{width:380px;max-width:92vw;background:#171923;border:1px solid #262a36;border-radius:14px;padding:26px 28px}
h1{font-size:20px;margin:0 0 4px}p{color:#8b91a3;margin:0 0 18px}label{display:block;margin:8px 0;padding:10px 12px;border:1px solid #262a36;border-radius:10px;cursor:pointer}
label:hover{background:#1f2230}button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;font:inherit;font-weight:600;color:#fff;cursor:pointer}
.ok{background:#7c5cff}.no{background:transparent;color:#8b91a3;margin-top:6px}.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;background:#262a36;color:#aab0c2;margin-bottom:12px}</style></head><body><div class="box">${body}</div></body></html>`;

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*", ...extra });
  res.end(body);
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

async function serveFile(req, res, abs) {
  let st;
  try { st = await fs.stat(abs); } catch { return send(res, 404, "not found"); }
  if (!st.isFile()) return send(res, 404, "not found");
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
    "Content-Length": st.size,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": abs.includes(`${path.sep}objects${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(abs).pipe(res);
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}
async function catalog() {
  const prod = (await readJson(path.join(CDN, "catalog.json"))) || { games: [] };
  const sample = (await readJson(path.join(SAMPLE, "catalog.json"))) || { games: [] };
  return { ...prod, games: [...prod.games, ...sample.games] };
}
/** First existing path among CDN and SAMPLE for a relative key. */
async function locate(rel) {
  for (const root of [CDN, SAMPLE]) {
    const abs = path.join(root, ...rel.split("/"));
    if (!abs.startsWith(root)) continue;
    try { if ((await fs.stat(abs)).isFile()) return abs; } catch {}
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const log = (extra = "") => console.log(`${new Date().toLocaleTimeString()}  ${req.method} ${p} ${extra}`);

  try {
    // ---------- REAL Patreon OAuth (when .env has the client id/secret) ----------
    // Launcher → /auth/patreon/start → Patreon login → /auth/patreon/callback → launcher
    const patreonRedirect = `http://localhost:${PORT}/auth/patreon/callback`; // must match the Patreon client's Redirect URIs
    if (REAL_PATREON && p === "/auth/patreon/start") {
      log("(real Patreon)");
      const redirect = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirect)) return send(res, 400, "bad redirect_uri");
      const nonce = randomBytes(16).toString("hex");
      pending.set(nonce, { redirect, state, at: Date.now() });
      return send(res, 302, "", "text/plain", { Location: patreon.authorizeUrl({ clientId: PATREON_CLIENT_ID, redirectUri: patreonRedirect, state: nonce }) });
    }
    if (REAL_PATREON && p === "/auth/patreon/callback") {
      const nonce = url.searchParams.get("state");
      const pend = pending.get(nonce);
      pending.delete(nonce);
      if (!pend || Date.now() - pend.at > 10 * 60_000) return send(res, 400, page("Login expired", "<h1>Login expired</h1><p>Please start again from the launcher.</p>"), "text/html; charset=utf-8");
      if (url.searchParams.get("error")) { log(`(patreon denied: ${url.searchParams.get("error")})`); return send(res, 302, "", "text/plain", { Location: `${pend.redirect}?error=access_denied&state=${pend.state}` }); }
      try {
        const tok = await patreon.exchangeCode({ code: url.searchParams.get("code"), clientId: PATREON_CLIENT_ID, clientSecret: PATREON_CLIENT_SECRET, redirectUri: patreonRedirect });
        const identity = await patreon.fetchIdentity(tok.access_token);
        if (process.env.PATREON_DEBUG) console.log(JSON.stringify(identity, null, 2));
        const acc = patreon.resolveTier(identity, TIERS_CONFIG);
        const token = randomBytes(24).toString("hex");
        sessions.set(token, acc);
        log(`(real Patreon: ${acc.displayName}, ${acc.tierName} = level ${acc.tier}, status ${acc.patronStatus}, patreon user id ${acc.userId})`);
        if (acc.tier === 0) console.log(`           ↳ to grant this account access, add to tools/tiers.json → patreon.overrides: "${acc.userId}": { "level": 4, "name": "Creator" }`);
        return send(res, 302, "", "text/plain", { Location: `${pend.redirect}?token=${token}&state=${pend.state}` });
      } catch (e) {
        console.error(e);
        return send(res, 500, page("Login failed", `<h1>Login failed</h1><p>${String(e.message || e).replace(/</g, "&lt;")}</p>`), "text/html; charset=utf-8");
      }
    }

    // ---------- mock OAuth (SubscribeStar for now, and Patreon until .env is set) ----------
    // Launcher opens: /auth/<provider>/start?redirect_uri=...&state=...
    let m = p.match(/^\/auth\/(patreon|subscribestar|mock)\/start$/);
    if (m) {
      log();
      const provider = m[1];
      const redirect = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirect)) return send(res, 400, "bad redirect_uri");
      const name = provider === "patreon" ? "Patreon" : provider === "subscribestar" ? "SubscribeStar" : "Mock";
      const colour = provider === "patreon" ? "#ff424d" : "#0099ff";
      return send(res, 200, page(`${name} (mock)`, `
        <span class="tag">LOCAL TEST — no real ${name} involved${provider === "patreon" ? " (add PATREON_CLIENT_ID/SECRET to .env for real login)" : ""}</span>
        <h1 style="color:${colour}">Sign in with ${name}</h1>
        <p>White Phantom Games Launcher wants to see your membership tier. Pick the tier to pretend you're on:</p>
        <form method="GET" action="/auth/${provider}/allow">
          <input type="hidden" name="redirect_uri" value="${redirect}"><input type="hidden" name="state" value="${state}">
          <label><input type="text" name="name" value="Test Patron" style="background:transparent;border:0;color:#fff;font:inherit;width:100%"></label>
          ${TIERS.map((t, i) => `<label><input type="radio" name="tier" value="${t.tier}" ${i === 2 ? "checked" : ""}> ${t.tierName}</label>`).join("")}
          <button class="ok" type="submit">Allow</button>
          <button class="no" type="submit" formaction="/auth/${provider}/deny">Cancel</button>
        </form>`), "text/html; charset=utf-8");
    }

    m = p.match(/^\/auth\/(patreon|subscribestar|mock)\/(allow|deny)$/);
    if (m) {
      const [, provider, action] = m;
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (action === "deny") { log("(denied)"); return send(res, 302, "", "text/plain", { Location: `${redirect}?error=access_denied&state=${state}` }); }
      const tierN = Number(url.searchParams.get("tier") || 0);
      const t = TIERS.find((x) => x.tier === tierN) || TIERS[0];
      const token = randomBytes(24).toString("hex");
      sessions.set(token, { provider, displayName: url.searchParams.get("name") || "Test Patron", avatar: "", tier: t.tier, tierName: t.tierName });
      log(`(allowed as ${t.tierName})`);
      return send(res, 302, "", "text/plain", { Location: `${redirect}?token=${token}&state=${state}` });
    }

    if (p === "/auth/code" && req.method === "POST") {
      let raw = ""; for await (const c of req) raw += c;
      let body = {}; try { body = JSON.parse(raw); } catch {}
      const acc = resolveCode(body.code, TIERS_CONFIG) || (body.code && /^TEST/i.test(body.code) ? { provider: "code", userId: "code:test", displayName: "Tester", avatar: "", tier: 2, tierName: "Supporter (code)", patronStatus: "code" } : null);
      log(acc ? `(code → ${acc.displayName})` : "(bad code)");
      if (!acc) return send(res, 401, JSON.stringify({ error: "That code isn't valid." }), "application/json");
      const token = randomBytes(24).toString("hex");
      sessions.set(token, acc);
      return send(res, 200, JSON.stringify({ ...acc, token }), "application/json");
    }

    if (p === "/auth/me") {
      const acc = sessions.get(bearer(req));
      log(acc ? `(${acc.displayName}, tier ${acc.tier})` : "(no session)");
      if (!acc) return send(res, 401, JSON.stringify({ error: "not signed in" }), "application/json");
      return send(res, 200, JSON.stringify(acc), "application/json");
    }

    // ---------- CDN ----------
    if (p === "/" ) return serveFile(req, res, path.join(UI, "index.html")); // browser preview of the UI
    if (p === "/__bundled-catalog/") return serveFile(req, res, path.join(here, "..", "src-tauri", "bundled", "catalog.json")); // preview of first-run offline state (open /#bundled)
    if (p === "/catalog.json") { log(); return send(res, 200, JSON.stringify(await catalog(), null, 2), "application/json"); }
    if (p === "/catalog.json.sig") { log(); return send(res, 404, "catalog is merged locally; launcher skips catalog signature in dev"); }
    if (p === "/rss.xml") { log(); return serveFile(req, res, (await locate("rss.xml")) || path.join(SAMPLE, "rss.xml")); } // sample feed for offline testing

    m = p.match(/^\/games\/([a-z0-9-]+)\/(.+)$/);
    if (m) {
      const [, gameId, rest] = m;
      if (rest.includes("..")) return send(res, 400, "bad path");
      const abs = await locate(`games/${gameId}/${rest}`);
      if (!abs) return send(res, 404, "not found");

      // Artwork is public; versions/** and objects/** are tier-gated.
      const gated = rest.startsWith("versions/") || rest.startsWith("objects/");
      if (gated) {
        const game = (await catalog()).games.find((g) => g.id === gameId);
        const required = game ? game.requiredTier || 0 : 0;
        if (required > 0) {
          const acc = sessions.get(bearer(req));
          if (!acc) { log("401"); return send(res, 401, "sign in required"); }
          if (acc.tier < required) { log(`403 (tier ${acc.tier} < ${required})`); return send(res, 403, "tier too low"); }
        }
      }
      if (rest.startsWith("versions/")) log();
      return serveFile(req, res, abs);
    }

    // UI files for browser preview (http://127.0.0.1:8787/)
    const uiFile = path.join(UI, ...p.split("/"));
    if (uiFile.startsWith(UI)) return serveFile(req, res, uiFile);
    send(res, 404, "not found");
  } catch (e) {
    console.error(e);
    send(res, 500, String(e));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`WPG local server`);
  console.log(`  CDN root : ${CDN}`);
  console.log(`  Launcher : point Settings → Content server at http://127.0.0.1:${PORT}`);
  console.log(`  Preview  : http://127.0.0.1:${PORT}/  (UI in a browser, with fake downloads)`);
  console.log(`  Patreon  : ${REAL_PATREON ? `REAL login via client ${PATREON_CLIENT_ID.slice(0, 8)}… (${Object.keys(TIERS_CONFIG.patreon?.tiers || {}).length} tiers mapped in tools/tiers.json)` : "mock login (no .env)"}`);
  console.log();
});
