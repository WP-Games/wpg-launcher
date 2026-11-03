/**
 * stats.mjs — download counters + the private /stats page.
 *
 * What gets counted (one row per day / kind / game / version / platform / provider / tier):
 *   kind "launcher"  a click on /launcher/download (the website button) — platform only, nobody is signed in yet
 *   kind "game"      a game manifest served to the desktop launcher (≈ one install or update)
 *   kind "android"   an APK served by the phone portal (the first request of a download, not Range continuations)
 *
 * What is NOT stored: account IDs, names, IPs, user agents, timestamps finer than a day.
 * Rows are plain counts. "provider" is one of patreon | subscribestar | alpha (every access
 * code, lumped together) | creator (the studio's own account — shown on its own, left out of totals).
 *
 * De-duplication: a fresh install fetches the manifest twice (install dialog shows the size,
 * then the install itself). To count that once, a key of provider+userId+game+version is
 * kept IN MEMORY for ten minutes (never written anywhere) and repeat fetches are skipped.
 *
 * Storage: Cloudflare D1, binding STATS (launcher.config.json → server.statsDatabaseId).
 * Without the binding nothing is counted and /stats explains why. The table creates itself.
 * /stats needs the STATS_PASSWORD secret (HTTP Basic auth, any username).
 */

export const CREATOR_LEVEL = 4;
const DEDUPE_MS = 10 * 60_000;
const DEDUPE_MAX = 5000;

// ---------- classification (pure) ----------

/** "windows" | "mac" | "linux" | "unknown" from the launcher's User-Agent "<Name>-Launcher/<ver> (<os>)". */
export function platformFromUserAgent(ua) {
  const m = /-Launcher\/[^\s]+\s*\((windows|macos|darwin|linux)\)/i.exec(ua || "");
  if (!m) return "unknown";
  const os = m[1].toLowerCase();
  return os === "macos" || os === "darwin" ? "mac" : os;
}

/** Which row an account's downloads land in. */
export function bucketFor(account) {
  if (!account) return { provider: "unknown", tier: "" };
  if ((Number(account.tier) || 0) >= CREATOR_LEVEL) return { provider: "creator", tier: "" };
  if (account.provider === "code") return { provider: "alpha", tier: "" };
  if (account.provider === "patreon" || account.provider === "subscribestar") {
    return { provider: account.provider, tier: String(account.tierName || "").slice(0, 80) };
  }
  return { provider: "unknown", tier: "" };
}

/** Only the first request of an Android download: no Range, or a Range starting at byte 0. */
export function isFirstRequest(rangeHeader) {
  if (!rangeHeader) return true;
  return /^bytes=0-/i.test(rangeHeader.trim());
}

export function utcDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------- de-duplication (memory only) ----------

const recent = new Map(); // key → expiry ms

/** true the first time a key is seen within DEDUPE_MS; false on repeats. */
export function firstSeen(key, now = Date.now(), store = recent) {
  const exp = store.get(key);
  if (exp && exp > now) return false;
  if (store.size >= DEDUPE_MAX) for (const [k, e] of store) { if (e <= now) store.delete(k); if (store.size < DEDUPE_MAX) break; }
  if (store.size >= DEDUPE_MAX) store.delete(store.keys().next().value);
  store.set(key, now + DEDUPE_MS);
  return true;
}

// ---------- recording ----------

const SCHEMA = `CREATE TABLE IF NOT EXISTS downloads (
  day TEXT NOT NULL, kind TEXT NOT NULL, game TEXT NOT NULL, version TEXT NOT NULL,
  platform TEXT NOT NULL, provider TEXT NOT NULL, tier TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, game, version, platform, provider, tier))`;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(SCHEMA).run();
  schemaReady = true;
}

/** Add one to a counter. Never throws; runs in the background via ctx.waitUntil when given. */
export function record(env, ctx, row) {
  const db = env?.STATS;
  if (!db) return;
  const r = {
    day: utcDay(), kind: row.kind, game: row.game || "", version: row.version || "",
    platform: row.platform || "unknown", provider: row.provider || "", tier: row.tier || "",
  };
  const work = (async () => {
    try {
      await ensureSchema(db);
      await db.prepare(
        `INSERT INTO downloads (day, kind, game, version, platform, provider, tier, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
         ON CONFLICT(day, kind, game, version, platform, provider, tier) DO UPDATE SET n = n + 1`,
      ).bind(r.day, r.kind, r.game, r.version, r.platform, r.provider, r.tier).run();
    } catch (e) {
      console.warn("stats: count failed", String(e));
    }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(work);
  return work;
}

/** Game manifest served to the launcher. Dedupes the dialog+install double fetch. */
export function recordGameDownload(env, ctx, { session, gameId, version, userAgent }) {
  const acc = session?.acc || {};
  const key = `${session?.provider || acc.provider}:${acc.userId}:${gameId}:${version}`;
  if (!firstSeen(key)) return;
  const { provider, tier } = bucketFor(acc);
  return record(env, ctx, { kind: "game", game: gameId, version, platform: platformFromUserAgent(userAgent), provider, tier });
}

export function recordAndroidDownload(env, ctx, { session, gameId, version, rangeHeader }) {
  if (!isFirstRequest(rangeHeader)) return;
  const { provider, tier } = bucketFor(session?.acc);
  return record(env, ctx, { kind: "android", game: gameId, version, platform: "android", provider, tier });
}

export function recordLauncherDownload(env, ctx, { platform, version }) {
  const p = ["windows", "mac", "linux"].includes(platform) ? platform : "unknown";
  return record(env, ctx, { kind: "launcher", game: "", version: version || "", platform: p, provider: "", tier: "" });
}

// ---------- summarising (pure) ----------

export const PLATFORMS = ["windows", "mac", "linux", "android", "unknown"];

export function providerLabel(provider) {
  return { patreon: "Patreon", subscribestar: "SubscribeStar", alpha: "Alpha Testers", creator: "Creator (you)", unknown: "Unknown" }[provider] || provider;
}

/** Row label: "Patreon · Premium Supporter", "Alpha Testers", "Creator (you)". */
export function rowLabel(provider, tier) {
  const p = providerLabel(provider);
  return tier && provider !== "alpha" && provider !== "creator" ? `${p} · ${tier}` : p;
}

function emptyCounts() {
  return Object.fromEntries(PLATFORMS.map((p) => [p, 0]).concat([["total", 0]]));
}

/**
 * rows: [{kind, game, version, platform, provider, tier, n}] (already summed over days)
 * → { launcher: {versions:[{version, counts}], counts},
 *     games: { <gameId>: { versions: [ { version, rows:[{provider, tier, label, counts}], total: counts, creator: counts|null } ] } } }
 * Creator is excluded from every total. Versions newest-first by simple semver-ish sort.
 */
export function summarize(rows) {
  const launcher = { versions: new Map(), counts: emptyCounts() };
  const games = {};
  for (const r of rows) {
    const n = Number(r.n) || 0;
    const plat = PLATFORMS.includes(r.platform) ? r.platform : "unknown";
    if (r.kind === "launcher") {
      const v = launcher.versions.get(r.version) || emptyCounts();
      v[plat] += n; v.total += n; launcher.versions.set(r.version, v);
      launcher.counts[plat] += n; launcher.counts.total += n;
      continue;
    }
    if (r.kind !== "game" && r.kind !== "android") continue;
    const g = (games[r.game] ||= { versions: new Map() });
    const v = g.versions.get(r.version) || { version: r.version, rows: new Map(), total: emptyCounts(), creator: null };
    g.versions.set(r.version, v);
    if (r.provider === "creator") {
      v.creator ||= emptyCounts();
      v.creator[plat] += n; v.creator.total += n;
      continue;
    }
    const key = `${r.provider}\u0000${r.tier}`;
    const row = v.rows.get(key) || { provider: r.provider, tier: r.tier, label: rowLabel(r.provider, r.tier), counts: emptyCounts() };
    row.counts[plat] += n; row.counts.total += n; v.rows.set(key, row);
    v.total[plat] += n; v.total.total += n;
  }
  const byVersionDesc = (a, b) => compareVersions(b.version, a.version);
  const providerOrder = { patreon: 0, subscribestar: 1, alpha: 2, unknown: 3 };
  const out = {
    launcher: {
      counts: launcher.counts,
      versions: [...launcher.versions].map(([version, counts]) => ({ version, counts })).sort(byVersionDesc),
    },
    games: {},
  };
  for (const [id, g] of Object.entries(games)) {
    out.games[id] = {
      versions: [...g.versions.values()].sort(byVersionDesc).map((v) => ({
        ...v,
        rows: [...v.rows.values()].sort((a, b) => (providerOrder[a.provider] ?? 9) - (providerOrder[b.provider] ?? 9) || b.counts.total - a.counts.total || a.label.localeCompare(b.label)),
      })),
    };
  }
  return out;
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

// ---------- the page ----------

const RANGES = { "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days", all: "All time" };

/** GET /stats[?days=7|30|90|all]  ·  GET /stats.csv — HTTP Basic auth against STATS_PASSWORD. */
export async function handleStats(request, env, url, d) {
  if (!env.STATS_PASSWORD) return d.text(404, "not found");
  if (request.method !== "GET") return d.text(405, "method not allowed");
  if (!(await authorized(request, env.STATS_PASSWORD))) {
    return new Response("Sign in to see download stats.", { status: 401, headers: { "www-authenticate": 'Basic realm="Download stats", charset="UTF-8"', "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  const range = RANGES[url.searchParams.get("days")] ? url.searchParams.get("days") : "all";
  const csv = url.pathname.endsWith(".csv");
  if (!env.STATS) {
    return d.page(503, "Stats not set up", "Add server.statsDatabaseId to launcher.config.json and run npm run worker:deploy — see README \"Download stats\".");
  }
  await ensureSchema(env.STATS);
  const since = range === "all" ? "0000-00-00" : utcDay(Date.now() - Number(range) * 86_400_000);
  const res = await env.STATS.prepare(
    `SELECT kind, game, version, platform, provider, tier, SUM(n) AS n FROM downloads WHERE day >= ?1
     GROUP BY kind, game, version, platform, provider, tier`,
  ).bind(since).all();
  const rows = res.results || [];
  if (csv) {
    const raw = await env.STATS.prepare(`SELECT day, kind, game, version, platform, provider, tier, n FROM downloads WHERE day >= ?1 ORDER BY day DESC`).bind(since).all();
    return new Response(toCsv(raw.results || []), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="downloads-${range}.csv"`, "cache-control": "no-store" } });
  }
  const catalog = await d.catalog(env).catch(() => ({ games: [] }));
  const titles = Object.fromEntries((catalog.games || []).map((g) => [g.id, g.title || g.id]));
  const html = statsPage({ studio: d.cfg.studio.name, range, summary: summarize(rows), titles, generatedAt: new Date().toISOString() });
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
}

async function authorized(request, password) {
  const h = request.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let given = "";
  try { given = atob(h.slice(6)); } catch { return false; }
  const pw = given.slice(given.indexOf(":") + 1); // any username
  return timingSafeEqual(pw, password);
}

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function toCsv(rows) {
  const cols = ["day", "kind", "game", "version", "platform", "provider", "tier", "n"];
  const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => (n ? n.toLocaleString("en-GB") : "–");

export function statsPage({ studio, range, summary, titles, generatedAt }) {
  const platCols = (used) => PLATFORMS.filter((p) => used.has(p));
  const usedPlatforms = (countsList) => {
    const s = new Set();
    for (const c of countsList) for (const p of PLATFORMS) if (c[p]) s.add(p);
    if (!s.size) s.add("windows");
    return s;
  };
  const head = (cols) => `<tr><th></th>${cols.map((p) => `<th>${esc(PLATFORM_LABEL[p])}</th>`).join("")}<th>Total</th></tr>`;
  const cells = (c, cols) => `${cols.map((p) => `<td>${num(c[p])}</td>`).join("")}<td class="t">${num(c.total)}</td>`;

  const tabs = Object.entries(RANGES).map(([k, label]) => `<a href="/stats?days=${k}" class="${k === range ? "on" : ""}">${label}</a>`).join("");

  // Launcher downloads
  const lCols = platCols(usedPlatforms([summary.launcher.counts]));
  const launcherRows = summary.launcher.versions.map((v) => `<tr><td>Launcher ${esc(v.version || "?")}</td>${cells(v.counts, lCols)}</tr>`).join("");
  const launcherTotal = summary.launcher.versions.length > 1 ? `<tr class="total"><td>All versions</td>${cells(summary.launcher.counts, lCols)}</tr>` : "";
  const launcherSection = summary.launcher.counts.total
    ? `<table>${head(lCols)}${launcherRows}${launcherTotal}</table><p class="note">Clicks on the website's download button (/launcher/download), by platform.</p>`
    : `<p class="note">Nothing yet.</p>`;

  // Game downloads
  const gameSections = Object.entries(summary.games).map(([id, g]) => {
    const versions = g.versions.map((v) => {
      const cols = platCols(usedPlatforms([v.total, ...(v.creator ? [v.creator] : [])]));
      const rows = v.rows.map((r) => `<tr><td>${esc(r.label)}</td>${cells(r.counts, cols)}</tr>`).join("");
      const total = `<tr class="total"><td>Total</td>${cells(v.total, cols)}</tr>`;
      const creator = v.creator ? `<tr class="creator"><td>Creator (you) — not in totals</td>${cells(v.creator, cols)}</tr>` : "";
      return `<h3>${esc(v.version)}</h3><table>${head(cols)}${rows}${total}${creator}</table>`;
    }).join("");
    return `<section><h2>${esc(titles[id] || id)}</h2>${versions}</section>`;
  }).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Download stats — ${esc(studio)}</title>
<style>
:root{color-scheme:dark}body{margin:0;padding:2rem 1rem 4rem;background:#0e0f14;color:#eceef5;font:15px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto}h1{font-weight:600;margin:0 0 .25rem}h2{font-weight:600;margin:2.5rem 0 .5rem;font-size:1.25rem}h3{font-weight:600;margin:1.5rem 0 .5rem;font-size:1rem;opacity:.9}
.sub{opacity:.6;margin:0 0 1.5rem}.tabs{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1.5rem}.tabs a{color:inherit;text-decoration:none;padding:.35rem .8rem;border:1px solid #2a2d3a;border-radius:999px;opacity:.75}.tabs a.on{background:#1d2030;opacity:1;border-color:#3a3f55}
table{border-collapse:collapse;width:100%;background:#13151d;border-radius:10px;overflow:hidden}th,td{padding:.55rem .8rem;text-align:right;border-top:1px solid #1e2130;white-space:nowrap}th{font-weight:500;opacity:.6;border-top:0}td:first-child,th:first-child{text-align:left;white-space:normal}
td.t{font-weight:600}tr.total td{border-top:2px solid #2a2d3a;font-weight:600}tr.creator td{opacity:.45;font-style:italic}.note{opacity:.55;font-size:.9rem;margin:.5rem 0 0}
footer{margin-top:3rem;opacity:.5;font-size:.85rem}footer a{color:inherit}
</style></head><body><main>
<h1>Download stats</h1>
<p class="sub">${esc(studio)} · ${esc(RANGES[range])} · counts only, no personal data</p>
<nav class="tabs">${tabs}</nav>
<section><h2>Launcher downloads</h2>${launcherSection}</section>
${gameSections || `<section><h2>Game downloads</h2><p class="note">Nothing yet.</p></section>`}
<footer>Game rows: one per manifest fetch by the desktop launcher (≈ one install or update; the install dialog's size preview is not double-counted) or one per APK download from the Android portal. "Unknown" platform = launchers older than the version that reports its OS. Alpha Testers = every access code together. Creator = your own account, shown separately and left out of totals. <a href="/stats.csv?days=${esc(range)}">Download CSV</a> · generated ${esc(generatedAt.slice(0, 16).replace("T", " "))} UTC</footer>
</main></body></html>`;
}

const PLATFORM_LABEL = { windows: "Windows", mac: "Mac", linux: "Linux", android: "Android", unknown: "Unknown" };
