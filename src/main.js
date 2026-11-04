/* Launcher — frontend logic. Studio-specific values come from config.js
 * (generated from launcher.config.json by tools/configure.mjs).
 *
 * All real work (downloads, hashing, login) happens in Rust; this file just
 * calls commands and renders state. If opened in a normal browser (no Tauri),
 * a mock bridge is used so the UI can be previewed with `npm run preview`.
 */

const tauri = window.__TAURI__;
const hasTauri = !!(tauri && tauri.core);

// ---------- studio config ----------
const CFG = window.LAUNCHER_CONFIG || { studio: {}, launcher: {}, server: {}, links: {} };
const STUDIO = CFG.studio.name || "Launcher";
function applyBranding() {
  document.title = CFG.launcher.productName || STUDIO;
  const words = STUDIO.split(" ");
  $("#brand-name").innerHTML = words.length > 1
    ? `${escapeHtml(words.slice(0, -1).join(" "))} <span>${escapeHtml(words.at(-1))}</span>`
    : escapeHtml(STUDIO);
  if (CFG.launcher.logo) $("#brand-logo").src = CFG.launcher.logo;
  try { $("#feed-domain").textContent = new URL(CFG.links.newsFeed || CFG.studio.website || "").host; } catch {}
  if (CFG.launcher.codePrefix) $("#input-code").placeholder = `${CFG.launcher.codePrefix}-XXXX-XXXX-XXXX`;
  document.querySelectorAll("[data-cfg]").forEach((el) => {
    const v = el.dataset.cfg.split(".").reduce((o, k) => (o == null ? o : o[k]), CFG);
    if (v != null) el.textContent = v;
  });
}

// ---------- language ----------
// Text lives in i18n.js (eight languages). The chosen language is saved in
// settings.json; English is the default and the fallback for any missing key.
const I18N = window.LAUNCHER_I18N || { languages: [{ code: "en", name: "English", locale: "en-GB" }], strings: { en: {} } };
let LANG = "en";
const langInfo = () => I18N.languages.find((l) => l.code === LANG) || I18N.languages[0];
/** Plain-text lookup with {placeholders}. */
function t(key, vars = {}) {
  const raw = (I18N.strings[LANG] || {})[key] ?? I18N.strings.en[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}
/** HTML lookup: placeholders are escaped (pass {__html} to inject markup), **bold** → <b>, [refresh]…[/refresh] etc → links. */
function th(key, vars = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(vars)) safe[k] = v && typeof v === "object" && v.__html !== undefined ? v.__html : escapeHtml(v);
  return t(key, safe)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[(refresh|login)\](.+?)\[\/\1\]/g, '<a data-act="$1">$2</a>')
    .replace(/\[(eula|privacy)\](.+?)\[\/\1\]/g, '<a href="#" data-legal="$1">$2</a>');
}
const htmlVars = (key) => {
  if (key === "terms.intro" || key === "login.intro") return { studio: STUDIO };
  if (key === "settings.serverHint") return { url: { __html: `<code>${escapeHtml(CFG.server.apiUrl || "")}</code>` }, dev: { __html: "<code>http://127.0.0.1:8787</code>" } };
  return {};
};
/** Re-label every static element and rebuild the language dropdowns. */
function applyI18n() {
  document.documentElement.lang = langInfo().locale;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute("aria-label", el.title); });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = th(el.dataset.i18nHtml, htmlVars(el.dataset.i18nHtml)); });
  document.querySelectorAll("select.lang-select").forEach((sel) => {
    sel.innerHTML = I18N.languages.map((l) => `<option value="${l.code}"${l.code === LANG ? " selected" : ""}>${escapeHtml(l.name)}</option>`).join("");
  });
}
async function setLanguage(code, save = true) {
  LANG = I18N.strings[code] ? code : "en";
  applyI18n();
  if (save) {
    if (state.settings) state.settings.language = LANG;
    try { await bridge.invoke("set_language", { language: LANG }); } catch (e) { console.warn("set_language", e); }
  }
  // Everything rendered from JS carries text too.
  if (state.settings) renderAccount();
  if (state.catalog) { renderOffline(); renderList(); renderDetail(); state.feed = null; renderFeed(); loadFeed(); }
  const g = state.catalog && currentGame();
  if (g && !$("#modal-ach").classList.contains("hidden")) renderAchievementsModal(g);
}
document.querySelectorAll("select.lang-select").forEach((sel) => { sel.onchange = (e) => setLanguage(e.target.value); });
/** Catalog text: a plain string, or {en: "…", de: "…"} → this language, else English, else whatever's there. */
const L = (v) => (typeof v === "string" ? v : v && typeof v === "object" ? (v[LANG] ?? v.en ?? Object.values(v)[0] ?? "") : (v ?? ""));
/** Website URLs follow the site's /<lang>/ scheme (English is unprefixed). */
function siteUrlFor(url, lang = LANG) {
  if (!url || lang === "en") return url;
  try { const u = new URL(url); u.pathname = `/${lang}${u.pathname}`; return u.toString(); } catch { return url; }
}

// ---------- bridge ----------
const bridge = hasTauri
  ? {
      invoke: (cmd, args) => tauri.core.invoke(cmd, args),
      listen: (evt, cb) => tauri.event.listen(evt, (e) => cb(e.payload)),
    }
  : makeMockBridge();
let DEV_BUILD = false; // set from is_dev_build below; true only in `npm run dev` builds

// ---------- state ----------
const state = {
  settings: null,
  account: null,
  catalog: null,
  selectedId: null,
  status: {}, // gameId -> InstallStatus
  progress: {}, // gameId -> Progress
  feed: null, // website RSS items (shared by all games)
  feedError: null,
  achMeta: {}, // gameId -> achievements.json
  achProgress: {}, // gameId -> { unlocked:[], updated } | null
  offline: false, // catalog came from the on-disk copy
};

const $ = (sel) => document.querySelector(sel);
const fmtBytes = (n) => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
/** Render plain text with Markdown-style links: "see [the changelog](https://…)". Everything else is escaped. */
function renderInline(text) {
  const parts = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    parts.push(escapeHtml(text.slice(last, m.index)));
    parts.push(`<a data-href="${escapeHtml(m[2])}">${escapeHtml(m[1])}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(escapeHtml(text.slice(last)));
  return parts.join("");
}
const fmtDate = (d) => {
  const t = new Date(d);
  return isNaN(t) ? escapeHtml(d) : t.toLocaleDateString(langInfo().locale, { day: "numeric", month: "short", year: "numeric" });
};
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

// Artwork is cached by the webview for up to an hour; a per-launch stamp makes
// each start fetch fresh copies so a `npm run sync` shows up on next open.
const BOOT_STAMP = Date.now().toString(36);
// Files snapshotted into the launcher at build time (tools/bundle-offline.mjs).
let bundledFiles = new Set();
fetch("bundled/index.json").then((r) => r.json()).then((j) => { bundledFiles = new Set(j.files || []); }).catch(() => {});
const assetUrl = (rel) => {
  if (!rel) return "";
  if (state.offline && bundledFiles.has(rel)) return `bundled/${rel}`;
  return `${state.settings.serverUrl}/${rel}?v=${BOOT_STAMP}`;
};
const canAccess = (game) => game.requiredTier === 0 || (state.account && state.account.tier >= game.requiredTier);

// ---------- release windows ----------
// Day-1 tiers get a new version the moment it's published; other tiers after
// their `delayDays` (sent with the account). The launcher aims at the newest
// version the player can actually download, and says when the next one unlocks.
const DAY_MS = 86_400_000;
const releasedAtMs = (v) => { const t = Date.parse(v.releasedAt || v.date || ""); return Number.isFinite(t) ? t : 0; };
const unlockAtMs = (v) => releasedAtMs(v) + ((state.account && state.account.delayDays) || 0) * DAY_MS;
const versionUnlocked = (v, now = Date.now()) => now >= unlockAtMs(v);
/** Newest version this player may download (falls back to `latest`). */
function targetVersion(g) {
  if (!state.account || !canAccess(g) || !(g.versions || []).length) return g.latest;
  const open = g.versions.find((v) => versionUnlocked(v)); // newest-first
  return open ? open.version : g.latest;
}
/** The newer version that's published but not yet open to this player, if any. */
function pendingVersion(g) {
  if (!state.account || !canAccess(g) || !(g.versions || []).length) return null;
  const newest = g.versions[0];
  return newest.version !== targetVersion(g) ? { version: newest.version, at: new Date(unlockAtMs(newest)) } : null;
}
/** Where "Upgrade" sends this player: their own provider's tier page (catalog.support can override). */
function upgradeUrl() {
  const a = state.account, sup = state.catalog?.support || {};
  if (!a || a.provider === "code") return null;
  if (a.provider === "subscribestar") return sup.subscribestar || CFG.links.subscribestar || null;
  return sup.patreon || CFG.links.patreonUpgrade || CFG.links.patreon || null;
}
const dayOneName = () => state.catalog?.support?.dayOneTierName || t("note.dayOneTier");
function upgradeButton(label = t("btn.upgrade")) {
  const url = upgradeUrl();
  if (!url) return "";
  const brand = state.account.provider === "subscribestar" ? "substar" : "patreon";
  return `<button class="btn-upgrade ${brand}" data-act="upgrade" data-url="${escapeHtml(url)}">${escapeHtml(label)}</button>`;
}
function wireNote(locked) {
  const up = locked.querySelector("[data-act=upgrade]");
  if (up) locked.prepend(up); // floats right; must come first in the flow to sit at the top
  if (up) up.onclick = () => bridge.invoke("open_external", { url: up.dataset.url }).catch((e) => toast(String(e), true));
  const rc = locked.querySelector("[data-act=refresh]");
  if (rc) rc.onclick = recheckTier;
  const li = locked.querySelector("[data-act=login]");
  if (li) li.onclick = () => openModal("#modal-login");
}
const fmtDateTime = (d) => d.toLocaleString(langInfo().locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const dayLabel = (delayDays) => (delayDays > 0 ? t("day.n", { n: delayDays + 1 }) : t("day.one"));

// ---------- boot ----------
async function boot() {
  applyBranding();
  state.settings = await bridge.invoke("get_settings");
  await setLanguage(state.settings.language || "en", false);
  await ensureTermsAccepted();
  state.account = await bridge.invoke("get_account");
  renderAccount();
  $("#about-line").textContent = `Launcher v0.1.2 · ${hasTauri ? "Tauri" : "browser preview"}`;

  bridge.listen("install-progress", onProgress);
  bridge.listen("game-exited", (gameId) => { loadAchievements(gameId, true); });
  bridge.listen("launcher-update-progress", (p) => {
    const el = $("#update-text");
    el.textContent = p.total ? t("update.downloadingPct", { pct: Math.round((p.downloaded / p.total) * 100) }) : t("update.downloading");
  });
  checkLauncherUpdate();

  await loadCatalog();
  // Re-check tier quietly in the background on each start.
  if (state.account) {
    bridge.invoke("refresh_account").then((acc) => { state.account = acc; return accountChanged(); }).catch(() => {});
  }
}

async function loadCatalog() {
  try {
    const res = await bridge.invoke("get_catalog");
    state.catalog = res.catalog;
    state.offline = !!res.offline;
    state.bundled = !!res.bundled;
    renderOffline();
    for (const g of state.catalog.games) {
      state.status[g.id] = await refreshStatus(g);
    }
    if (!state.selectedId && state.catalog.games.length) state.selectedId = state.catalog.games[0].id;
    renderList();
    renderDetail();
    loadFeed();
  } catch (e) {
    $("#detail-empty").innerHTML = `<div class="error"><p><b>${th("error.serverTitle")}</b></p><p class="muted">${th("error.serverBody")}</p><p>${escapeHtml(e)}</p>${DEV_BUILD ? `<p class="muted small">For local testing run <code>npm run serve</code> in the project folder, then check Settings → Content server.</p>` : ""}</div>`;
    $("#detail-empty").classList.remove("hidden");
    $("#detail-content").classList.add("hidden");
  }
}

function renderOffline() {
  let b = $("#offline-badge");
  if (!b) {
    b = document.createElement("span");
    b.id = "offline-badge"; b.className = "offline-badge";
  }
  b.textContent = t("offline.badge");
  b.title = state.bundled ? t("offline.bundledTip") : t("offline.tip");
  if (state.bundled) $(".topbar-spacer").after(b);
  b.classList.toggle("hidden", !state.offline);
}

async function loadFeed() {
  if (state.offline) { state.feed = []; state.feedError = t("news.offline"); renderFeed(); return; }
  const base = state.catalog.newsFeed || CFG.links.newsFeed;
  const lang = LANG;
  try {
    try { state.feed = await bridge.invoke("get_news_feed", { url: siteUrlFor(base, lang) }); }
    catch (e) { if (lang === "en") throw e; state.feed = await bridge.invoke("get_news_feed", { url: base }); } // no feed in this language yet → English
    state.feedError = null;
  } catch (e) {
    state.feed = [];
    state.feedError = String(e);
  }
  if (lang !== LANG) return; // language changed while loading; the newer load will render
  renderFeed();
}

function renderFeed() {
  const el = $("#feed");
  if (state.feed === null) { el.innerHTML = `<p class="muted">${th("news.loading")}</p>`; return; }
  if (state.feedError) { el.innerHTML = `<p class="muted">${escapeHtml(state.feedError)}</p>`; return; }
  if (!state.feed.length) { el.innerHTML = `<p class="muted">${th("news.none")}</p>`; return; }
  el.innerHTML = state.feed.slice(0, 6).map((it) => `
    <div class="post">
      <a class="post-title" data-href="${escapeHtml(it.link)}">${escapeHtml(it.title)}</a>
      <div class="post-date">${fmtDate(it.date)}</div>
      ${it.summary ? `<p>${escapeHtml(it.summary)}</p>` : ""}
    </div>`).join("") + (CFG.links.newsPage ? `<a class="more" data-href="${escapeHtml(siteUrlFor(CFG.links.newsPage))}">${th("news.all")}</a>` : "");
}

function renderGameNews(g) {
  const el = $("#game-news");
  const items = (g.news || []).slice(0, 2); // hard cap: two short items
  $("#card-game-news").classList.toggle("hidden", items.length === 0);
  el.innerHTML = items.map((n) => `
    <div class="item">
      <div class="item-head"><b>${escapeHtml(L(n.title))}</b>${n.date ? `<span>${fmtDate(n.date)}</span>` : ""}</div>
      ${L(n.text) ? `<p>${renderInline(L(n.text))}</p>` : ""}
    </div>`).join("");
}

// Every in-app link opens in the player's browser via Rust (never inside the launcher window).
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-href]");
  if (!a) return;
  e.preventDefault();
  bridge.invoke("open_external", { url: a.dataset.href }).catch((err) => toast(String(err), true));
});

const refreshStatus = (g) => bridge.invoke("get_install_status", { gameId: g.id, latest: targetVersion(g), title: g.title });
/** After sign-in/out or a tier re-check: what counts as "latest" may have changed. */
async function accountChanged() {
  renderAccount();
  for (const g of state.catalog?.games || []) {
    try { state.status[g.id] = await refreshStatus(g); } catch {}
  }
  renderList(); renderDetail();
}

// ---------- launcher self-update ----------
async function checkLauncherUpdate() {
  try {
    const u = await bridge.invoke("check_launcher_update");
    if (!u) return;
    $("#update-text").textContent = u.notes ? t("update.versionAvailableNotes", { version: u.version, notes: u.notes.split("\n")[0] }) : t("update.versionAvailable", { version: u.version });
    $("#update-banner").classList.remove("hidden");
  } catch {}
}
$("#btn-update-later").onclick = () => $("#update-banner").classList.add("hidden");
$("#btn-update-launcher").onclick = async () => {
  const b = $("#btn-update-launcher");
  b.disabled = true; b.textContent = t("update.updating");
  try { await bridge.invoke("install_launcher_update"); }
  catch (e) { toast(String(e), true); b.disabled = false; b.textContent = t("update.restart"); }
};

// ---------- first run: age + terms ----------
// Blocks until the user has accepted the current legal.termsVersion (stored in
// settings.json). Shown again whenever that version changes in launcher.config.json.
function ensureTermsAccepted() {
  const legal = CFG.legal || {};
  const version = legal.termsVersion || "1";
  if (state.settings.acceptedTerms === version) return Promise.resolve();
  return new Promise((resolve) => {
    const chk = $("#chk-terms"), ok = $("#btn-terms-accept");
    chk.checked = false; ok.disabled = true;
    chk.onchange = () => (ok.disabled = !chk.checked);
    ok.onclick = async () => {
      if (!chk.checked) return;
      ok.disabled = true;
      try { await bridge.invoke("accept_terms", { version }); }
      catch (e) { toast(String(e), true); ok.disabled = false; return; }
      state.settings.acceptedTerms = version;
      $("#modal-terms").classList.add("hidden");
      resolve();
    };
    $("#btn-terms-quit").onclick = () => bridge.invoke("quit_app").catch(() => window.close());
    $("#modal-terms").classList.remove("hidden");
    chk.focus();
  });
}

// ---------- rendering ----------
function renderAccount() {
  const area = $("#account-area");
  if (!state.account) {
    area.innerHTML = `<button id="btn-login" class="btn-login">${th("login.signIn")}</button>`;
    $("#btn-login").onclick = () => openModal("#modal-login");
    return;
  }
  const a = state.account;
  const initials = (a.displayName || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  area.innerHTML = `
    <div class="avatar">${a.avatar ? `<img src="${escapeHtml(a.avatar)}" alt="">` : initials}</div>
    <div>
      <div class="account-name">${escapeHtml(a.displayName)}</div>
      <div class="account-tier"><span class="dot ${a.provider === "patreon" ? "patreon" : a.provider === "subscribestar" ? "substar" : "code"}"></span> ${escapeHtml(a.tierName || t("tier.label", { n: a.tier }))}</div>
    </div>
    <button id="btn-logout" class="btn-text small">${th("login.signOut")}</button>`;
  $("#btn-logout").onclick = async () => {
    await bridge.invoke("logout");
    state.account = null;
    await accountChanged();
  };
}

function renderList() {
  const list = $("#game-list");
  list.innerHTML = "";
  for (const g of state.catalog.games) {
    const st = state.status[g.id] || {};
    let dot = "", sub = "";
    if (g.comingSoon) { sub = t("list.comingSoon"); }
    else if (st.installed && st.updateAvailable) { dot = "update"; sub = canAccess(g) ? t("list.updateTo", { version: targetVersion(g) }) : t("list.installedAvailable", { version: g.latest }); }
    else if (st.installed) { dot = "installed"; sub = t("list.installed", { version: st.installedVersion }); }
    else if (!canAccess(g)) { dot = "locked"; sub = t("list.needs", { tier: g.requiredTierName || t("list.higherTier") }); }
    else { sub = t("list.notInstalled"); }

    const btn = document.createElement("button");
    btn.className = "game-item" + (g.id === state.selectedId ? " active" : "");
    btn.dataset.gameId = g.id;
    btn.innerHTML = `
      <img class="game-thumb" src="${escapeHtml(assetUrl(g.cover))}" alt="" onerror="this.removeAttribute('src')">
      <div>
        <div class="game-item-title">${escapeHtml(g.title)}</div>
        <div class="game-item-sub">${dot ? `<span class="status-dot ${dot}"></span>` : ""}${escapeHtml(sub)}</div>
      </div>`;
    btn.onclick = () => { state.selectedId = g.id; renderList(); renderDetail(); };
    list.appendChild(btn);
  }
}

function currentGame() {
  return state.catalog?.games.find((g) => g.id === state.selectedId);
}

function renderDetail() {
  const g = currentGame();
  if (!g) return;
  $("#detail-empty").classList.add("hidden");
  $("#detail-content").classList.remove("hidden");

  const hero = $("#hero");
  hero.style.backgroundImage = g.hero ? `url("${assetUrl(g.hero)}")` : "linear-gradient(160deg,#2a2f44,#161925)";
  $("#game-title").textContent = g.title;
  $("#game-tagline").textContent = L(g.tagline);
  $("#game-desc").textContent = L(g.description);

  renderGameNews(g);

  const cl = $("#changelog");
  $("#history-wrap").classList.toggle("hidden", !(g.versions || []).length);
  cl.innerHTML = g.versions.map((v) => {
    const soon = state.account && canAccess(g) && !versionUnlocked(v);
    return `<div class="entry${soon ? " pending" : ""}"><div class="entry-head"><b>v${escapeHtml(v.version)}</b><span>${soon ? th("changelog.unlocks", { date: fmtDate(unlockAtMs(v)) }) : fmtDate(v.date || "")}</span></div><p>${renderInline(L(v.notes))}</p></div>`;
  }).join("");

  renderAction();
}

function renderAction() {
  const g = currentGame();
  if (!g) return;
  const st = state.status[g.id] || {};
  const p = state.progress[g.id];
  const btn = $("#btn-primary");
  const vline = $("#version-line");
  const locked = $("#locked-note");
  const busy = p && !["done", "error"].includes(p.phase);

  btn.className = "btn-primary";
  btn.disabled = false;
  locked.classList.add("hidden");
  locked.classList.remove("info");

  const access = canAccess(g);
  const target = targetVersion(g);
  const pending = pendingVersion(g);
  const playBtn = () => {
    btn.textContent = t("common.play");
    btn.classList.add("play");
    btn.onclick = async () => {
      try { await bridge.invoke("play", { gameId: g.id }); }
      catch (e) { toast(String(e), true); }
    };
  };

  if (g.comingSoon) {
    btn.textContent = t("list.comingSoon");
    btn.classList.add("locked");
    btn.disabled = true;
    vline.innerHTML = "";
  } else if (busy) {
    btn.textContent = p.phase === "planning" ? t("action.preparing") : p.phase === "finalizing" ? t("action.installing") : t("action.downloading");
    btn.disabled = true;
    vline.innerHTML = th("action.installingV", { version: target });
  } else if (st.installed && st.updateAvailable && access && !state.offline) {
    btn.textContent = t("common.update");
    btn.classList.add("update");
    btn.onclick = () => startInstall(g);
    vline.innerHTML = th("action.installedUpdate", { installed: st.installedVersion, target });
  } else if (st.installed) {
    // Installed games always play — what you downloaded is yours, whatever
    // happens to your subscription or your connection.
    playBtn();
    if (st.updateAvailable && state.offline) {
      vline.innerHTML = th("action.installedWaiting", { installed: st.installedVersion, target });
    } else if (st.updateAvailable) {
      vline.innerHTML = th("action.installedAvailable", { installed: st.installedVersion, latest: g.latest });
      const tierName = g.requiredTierName || t("note.supporters");
      locked.innerHTML = state.account
        ? th("note.availableTo", { latest: g.latest, tier: tierName, current: state.account.tierName || t("tier.label", { n: state.account.tier }) })
        : th("note.availableSignIn", { latest: g.latest, tier: tierName });
      if (state.account) locked.innerHTML += ` ${upgradeButton(t("btn.resubscribe"))}`;
      locked.classList.remove("hidden");
      locked.classList.add("info");
      wireNote(locked);
    } else {
      vline.innerHTML = th("action.installedUpToDate", { installed: st.installedVersion });
    }
  } else if (state.offline) {
    btn.textContent = t("action.offline");
    btn.classList.add("locked");
    btn.disabled = true;
    vline.innerHTML = th("action.latestConnect", { latest: g.latest });
  } else if (!access) {
    btn.textContent = state.account ? t("action.locked") : t("action.signInToDownload");
    btn.classList.add("locked");
    btn.onclick = () => (state.account ? null : openModal("#modal-login"));
    vline.innerHTML = th("action.latest", { latest: g.latest });
    if (state.account) {
      locked.innerHTML = `${th("note.needsTier", { tier: g.requiredTierName || t("note.higher"), current: state.account.tierName || t("tier.label", { n: state.account.tier }) })} ${upgradeButton()}`;
      locked.classList.remove("hidden");
      wireNote(locked);
    }
  } else {
    btn.textContent = t("common.install");
    btn.onclick = () => startInstall(g);
    vline.innerHTML = th("action.latest", { latest: target });
  }

  // A newer build exists but this tier's release window hasn't opened yet.
  if (pending && !busy && locked.classList.contains("hidden")) {
    const a = state.account;
    locked.innerHTML = `${th("note.pending", { version: pending.version, dayOne: dayOneName(), tier: a.tierName || t("note.yourTier"), day: dayLabel(a.delayDays || 0), date: fmtDateTime(pending.at) })}${upgradeUrl() ? th("note.pendingUpgrade") : "."} ${upgradeButton()}`;
    locked.classList.remove("hidden");
    locked.classList.add("info");
    wireNote(locked);
  }

  // progress bar — one calm line, no file names
  const wrap = $("#progress-wrap");
  if (p && p.phase !== "done") {
    wrap.classList.remove("hidden");
    const pct = p.bytesTotal ? Math.min(100, (p.bytesDone / p.bytesTotal) * 100) : (p.phase === "planning" ? 2 : 100);
    $("#progress-bar").style.width = `${pct}%`;
    let left, right = "";
    if (p.phase === "error") {
      left = t("progress.error", { message: p.message });
    } else if (p.phase === "planning") {
      left = t("action.preparing");
    } else if (p.phase === "finalizing") {
      left = st.installed ? t("progress.installingUpdate") : t("action.installing");
    } else {
      left = t(st.installed ? "progress.downloadingUpdate" : "progress.downloadingGame", { pct: pct.toFixed(pct < 10 ? 1 : 0) });
      const speed = speedOf(g.id, p.bytesDone);
      right = `${t("progress.of", { done: fmtBytes(p.bytesDone), total: fmtBytes(p.bytesTotal) })}${speed ? ` · ${fmtBytes(speed)}/s` : ""}`;
    }
    $("#progress-text").innerHTML = `<span>${escapeHtml(left)}</span><span>${escapeHtml(right)}</span>`;
    $("#progress-text").style.color = p.phase === "error" ? "var(--danger)" : "";
  } else {
    wrap.classList.add("hidden");
  }

  // "more" menu only when installed
  $("#btn-more").classList.toggle("hidden", !st.installed);
  renderTrophy(g, st);
}

// ---------- achievements ----------
function renderTrophy(g, st) {
  const btn = $("#btn-achievements");
  // Shown whenever the game defines achievements, installed or not, so
  // players can browse the list; the count stays 0 until the game syncs.
  const show = !!g.achievements && !g.comingSoon;
  btn.classList.toggle("hidden", !show);
  if (!show) return;
  const meta = state.achMeta[g.id];
  const prog = state.achProgress[g.id];
  const total = meta?.total ?? "…";
  const n = prog ? prog.unlocked.length : 0;
  $("#trophy-count").textContent = `${n} / ${total}`;
  btn.classList.toggle("complete", !!meta && n >= meta.total);
  if (!meta) loadAchievements(g.id);
}

async function loadAchievements(gameId, rerender = false) {
  const g = state.catalog?.games.find((x) => x.id === gameId);
  if (!g?.achievements) return;
  try {
    if (!state.achMeta[gameId]) {
      state.achMeta[gameId] = state.offline && bundledFiles.has(g.achievements)
        ? await (await fetch(`bundled/${g.achievements}`)).json()
        : await bridge.invoke("get_cdn_json", { path: g.achievements });
    }
    state.achProgress[gameId] = g.saveDirectory ? await bridge.invoke("get_achievement_progress", { saveDirectory: g.saveDirectory }) : null;
  } catch (e) { console.warn("achievements", e); }
  if (gameId === state.selectedId) renderTrophy(g, state.status[gameId] || {});
  if (rerender && !$("#modal-ach").classList.contains("hidden")) renderAchievementsModal(g);
}

function renderAchievementsModal(g) {
  const meta = state.achMeta[g.id];
  const prog = state.achProgress[g.id];
  const unlocked = new Set(prog?.unlocked || []);
  const list = meta?.achievements || [];
  const n = list.filter((a) => unlocked.has(a.name)).length;
  $("#ach-summary").textContent = t("ach.summary", { title: g.title, n, total: list.length });
  $("#ach-bar").style.width = list.length ? `${(n / list.length) * 100}%` : "0%";
  const sorted = [...list.filter((a) => unlocked.has(a.name)), ...list.filter((a) => !unlocked.has(a.name))];
  $("#ach-list").innerHTML = sorted.map((a) => {
    const got = unlocked.has(a.name);
    const hidden = !got && a.secret;
    const icon = got ? a.icon : (hidden ? meta.secretLockedIcon : (a.iconLocked || a.icon));
    return `<div class="ach ${got ? "unlocked" : "locked"}">
      <img src="${escapeHtml(assetUrl(icon))}" alt="" loading="lazy">
      <div>
        <div class="ach-name">${hidden ? th("ach.secret") : escapeHtml(a.i18n?.[LANG]?.name || a.name)}</div>
        <div class="ach-hint">${hidden ? th("ach.hiddenHint") : escapeHtml(a.i18n?.[LANG]?.hint || a.hint || "")}</div>
      </div>
    </div>`;
  }).join("");
  const st = state.status[g.id] || {};
  $("#ach-note").textContent = prog
    ? t("ach.lastSynced", { date: prog.updated ? new Date(prog.updated).toLocaleDateString(langInfo().locale, { day: "numeric", month: "short", year: "numeric" }) : t("ach.recently") })
    : st.installed
      ? t("ach.playOnce")
      : t("ach.installFirst");
}

$("#btn-achievements").onclick = async () => {
  const g = currentGame();
  if (!g) return;
  await loadAchievements(g.id);
  renderAchievementsModal(g);
  openModal("#modal-ach");
};

async function recheckTier() {
  try {
    state.account = await bridge.invoke("refresh_account");
    await accountChanged();
    toast(state.account ? t("tier.toast", { tier: state.account.tierName || state.account.tier }) : t("login.signedOut"));
  } catch (e) { toast(String(e), true); }
}

// Smoothed download speed from byte deltas (bytes/sec), per game.
const speedState = {};
function speedOf(gameId, bytesDone) {
  const now = performance.now();
  const s = (speedState[gameId] ||= { t: now, b: bytesDone, ema: 0 });
  const dt = (now - s.t) / 1000;
  if (dt >= 0.5) {
    const inst = Math.max(0, (bytesDone - s.b) / dt);
    s.ema = s.ema ? s.ema * 0.7 + inst * 0.3 : inst;
    s.t = now; s.b = bytesDone;
  }
  return s.ema;
}

// ---------- actions ----------
/** Fresh install → ask where; update → straight on with the recorded folder. */
async function startInstall(g) {
  const st = state.status[g.id] || {};
  if (st.installed) return runInstall(g, null);
  openInstallDialog(g);
}

async function runInstall(g, installDir) {
  delete speedState[g.id];
  state.progress[g.id] = { phase: "planning", bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0 };
  renderAction();
  try {
    state.status[g.id] = await bridge.invoke("install_or_update", { gameId: g.id, version: targetVersion(g), title: g.title, installDir });
    toast(t("install.ready", { title: g.title }));
  } catch (e) {
    toast(String(e), true);
  }
  renderList();
  renderAction();
}

// ---------- install location dialog ----------
let installDlg = { game: null, dir: null, size: 0 };
async function openInstallDialog(g) {
  const d = await bridge.invoke("get_install_defaults", { title: g.title });
  installDlg = { game: g, dir: d.installDir, size: 0 };
  $("#install-heading").textContent = t("install.title", { title: g.title });
  $("#install-size").textContent = "…";
  renderInstallDialog(d);
  openModal("#modal-install");
  // Size comes from the manifest (needs sign-in); best effort.
  try {
    const m = await bridge.invoke("get_download_size", { gameId: g.id, version: targetVersion(g) });
    installDlg.size = m;
    renderInstallDialog({ installDir: installDlg.dir, freeBytes: installDlg.free });
  } catch { $("#install-size").textContent = "—"; }
}
function renderInstallDialog(d) {
  installDlg.dir = d.installDir; installDlg.free = d.freeBytes;
  $("#install-path").textContent = d.installDir;
  $("#install-path").title = d.installDir;
  $("#install-free").textContent = fmtBytes(d.freeBytes);
  if (installDlg.size) $("#install-size").textContent = fmtBytes(installDlg.size);
  const warn = $("#install-warning");
  const short = installDlg.size && d.freeBytes && d.freeBytes < installDlg.size * 1.1;
  warn.classList.toggle("hidden", !short);
  if (short) warn.textContent = t("install.notEnough");
  $("#btn-install-confirm").disabled = !!short;
}
$("#btn-browse").onclick = async () => {
  const d = await bridge.invoke("pick_install_root", { title: installDlg.game.title });
  if (d) renderInstallDialog(d);
};
$("#btn-install-confirm").onclick = () => {
  const g = installDlg.game, dir = installDlg.dir;
  closeModals();
  runInstall(g, dir);
};

// ---------- uninstall confirm ----------
function openUninstallDialog(g) {
  $("#uninstall-heading").textContent = t("uninstall.title", { title: g.title });
  $("#uninstall-path").textContent = (state.status[g.id] || {}).installDir || "";
  $("#btn-uninstall-confirm").onclick = async () => {
    closeModals();
    try {
      await bridge.invoke("uninstall", { gameId: g.id });
      state.status[g.id] = await refreshStatus(g);
      toast(t("uninstall.done", { title: g.title }));
    } catch (err) { toast(String(err), true); }
    renderList(); renderAction();
  };
  openModal("#modal-uninstall");
}

// ---------- right-click menu ----------
const ctx = $("#ctx-menu");
let ctxGame = null;
function openContextMenu(g, x, y) {
  ctxGame = g;
  const st = state.status[g.id] || {};
  const busy = state.progress[g.id] && !["done", "error"].includes(state.progress[g.id].phase);
  const show = (act, on) => ctx.querySelector(`[data-act=${act}]`).classList.toggle("hidden", !on);
  show("install", !st.installed && canAccess(g) && !g.comingSoon);
  show("update", st.installed && st.updateAvailable && canAccess(g) && !state.offline);
  show("play", st.installed && !(st.updateAvailable && canAccess(g) && !state.offline));
  show("folder", st.installed);
  show("verify", st.installed);
  show("uninstall", st.installed);
  ctx.querySelectorAll("button").forEach((b) => (b.disabled = !!busy && b.dataset.act !== "folder"));
  ctx.classList.remove("hidden");
  const r = ctx.getBoundingClientRect();
  ctx.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  ctx.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}
document.addEventListener("click", () => ctx.classList.add("hidden"));
document.addEventListener("contextmenu", (e) => {
  const item = e.target.closest(".game-item, .hero, .action-row");
  if (!item) return; // plain right-click elsewhere does nothing
  e.preventDefault();
  const id = item.dataset.gameId || state.selectedId;
  const g = state.catalog?.games.find((x) => x.id === id);
  if (!g) return;
  if (item.classList.contains("game-item")) { state.selectedId = g.id; renderList(); renderDetail(); }
  openContextMenu(g, e.clientX, e.clientY);
});
ctx.onclick = (e) => {
  const act = e.target.dataset.act;
  const g = ctxGame;
  ctx.classList.add("hidden");
  if (!act || !g) return;
  if (act === "play") bridge.invoke("play", { gameId: g.id }).catch((err) => toast(String(err), true));
  if (act === "install" || act === "update") startInstall(g);
  if (act === "folder") bridge.invoke("open_install_folder", { gameId: g.id }).catch((err) => toast(String(err), true));
  if (act === "verify") verifyFiles(g);
  if (act === "uninstall") openUninstallDialog(g);
};
async function verifyFiles(g) {
  try {
    const bad = await bridge.invoke("verify_files", { gameId: g.id });
    toast(bad ? t("verify.damaged", { n: bad }) : t("verify.ok"));
    state.status[g.id] = await refreshStatus(g);
  } catch (err) { toast(String(err), true); }
  renderList(); renderAction();
}

function onProgress(p) {
  state.progress[p.gameId] = p;
  if (p.phase === "done") setTimeout(() => { delete state.progress[p.gameId]; if (p.gameId === state.selectedId) renderAction(); }, 1200);
  if (p.gameId === state.selectedId) renderAction();
}

// menu
$("#btn-more").onclick = (e) => { e.stopPropagation(); $("#more-menu").classList.toggle("hidden"); };
document.addEventListener("click", () => $("#more-menu").classList.add("hidden"));
$("#more-menu").onclick = (e) => {
  const act = e.target.dataset.act;
  const g = currentGame();
  if (!act || !g) return;
  if (act === "folder") bridge.invoke("open_install_folder", { gameId: g.id }).catch((err) => toast(String(err), true));
  if (act === "verify") verifyFiles(g);
  if (act === "uninstall") openUninstallDialog(g);
};

// login modal
document.querySelectorAll("#modal-login .provider").forEach((b) => {
  b.onclick = async () => {
    const provider = b.dataset.provider;
    document.querySelectorAll("#modal-login .provider").forEach((x) => (x.disabled = true));
    $("#login-status").textContent = t("login.waiting");
    try {
      state.account = await bridge.invoke("login", { provider });
      closeModals();
      toast(t("login.signedInAs", { name: state.account.displayName }));
      await accountChanged();
    } catch (e) {
      $("#login-status").textContent = String(e);
    } finally {
      document.querySelectorAll("#modal-login .provider").forEach((x) => (x.disabled = false));
    }
  };
});

// access code
$("#link-have-code").onclick = () => { $("#code-form").classList.toggle("hidden"); $("#input-code").focus(); };
async function redeemCode() {
  const code = $("#input-code").value.trim();
  if (!code) return;
  $("#btn-code").disabled = true;
  $("#login-status").textContent = t("login.checkingCode");
  try {
    state.account = await bridge.invoke("login_with_code", { code });
    closeModals();
    $("#input-code").value = "";
    toast(t("login.signedInAs", { name: state.account.displayName }));
    await accountChanged();
  } catch (e) {
    $("#login-status").textContent = String(e);
  } finally { $("#btn-code").disabled = false; }
}
$("#btn-code").onclick = redeemCode;
$("#input-code").addEventListener("keydown", (e) => { if (e.key === "Enter") redeemCode(); });

// settings
// Content server field: dev builds only (player builds always use the production server).
bridge.invoke("is_dev_build").then((d) => { DEV_BUILD = !!d; $("#field-server").classList.toggle("hidden", !DEV_BUILD); }).catch(() => {});
$("#btn-settings").onclick = () => {
  $("#input-server").value = state.settings.serverUrl;
  $("#terms-accepted-line").textContent = state.settings.acceptedTerms ? t("legal.accepted", { version: state.settings.acceptedTerms }) : "";
  openModal("#modal-settings");
};
$("#btn-save-settings").onclick = async () => {
  if (DEV_BUILD) await bridge.invoke("set_server_url", { url: $("#input-server").value });
  state.settings = await bridge.invoke("get_settings");
  closeModals();
  await loadCatalog();
};

// external links
const legalLinks = CFG.legal || {};
for (const [id, url] of [["#link-patreon", CFG.links.patreon], ["#link-substar", CFG.links.subscribestar]]) {
  const a = $(id);
  if (!url) { a.classList.add("hidden"); continue; }
  a.onclick = (e) => { e.preventDefault(); bridge.invoke("open_external", { url }); };
}
// EULA / Privacy links are generated from the dictionary, so they're wired by delegation.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-legal]");
  if (!a) return;
  e.preventDefault();
  const url = a.dataset.legal === "eula" ? legalLinks.eulaUrl : legalLinks.privacyUrl;
  if (url) bridge.invoke("open_external", { url }).catch((err) => toast(String(err), true));
});

function openModal(sel) { $(sel).classList.remove("hidden"); $("#login-status").textContent = ""; }
function closeModals() { document.querySelectorAll(".modal:not(#modal-terms)").forEach((m) => m.classList.add("hidden")); }
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModals));
document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) closeModals(); }));

// ---------- mock bridge (browser preview only) ----------
function makeMockBridge() {
  const listeners = {};
  const installed = {};
  let account = null;
  let acceptedTerms = null; // preview: terms screen shows every reload
  let language = null;
  const serverUrl = location.origin.includes("127.0.0.1:8787") ? location.origin : "http://127.0.0.1:8787";
  const emit = (evt, payload) => (listeners[evt] || []).forEach((cb) => cb(payload));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    listen: (evt, cb) => { (listeners[evt] ||= []).push(cb); },
    async invoke(cmd, args = {}) {
      switch (cmd) {
        case "get_settings": return { serverUrl, token: account ? "•••" : null, account, acceptedTerms, language };
        case "is_dev_build": return true;
        case "set_server_url": return;
        case "set_language": language = args.language; return;
        case "accept_terms": acceptedTerms = args.version; return;
        case "quit_app": window.close(); return;
        case "get_account": return account;
        case "refresh_account": return account;
        case "logout": account = null; return;
        case "login": await sleep(800); account = { provider: args.provider, displayName: "Preview Patron", tier: 1, tierName: "Supporter", delayDays: 7 }; return account;
        case "login_with_code": await sleep(500); if (!/^TEST/i.test(args.code)) throw "That code isn't valid."; account = { provider: "code", displayName: "Tester", tier: 3, tierName: "Day One (code)", delayDays: 0 }; return account;
        case "get_catalog": { if (location.hash === "#bundled") { return { catalog: await (await fetch("/__bundled-catalog/")).json(), offline: true, bundled: true }; } const r = await fetch(`${serverUrl}/catalog.json`); if (!r.ok) throw new Error(`HTTP ${r.status}`); return { catalog: await r.json(), offline: location.hash === "#offline" }; }
        case "get_install_status": { const i = installed[args.gameId]; return { gameId: args.gameId, installed: !!i, installedVersion: i || null, latestVersion: args.latest, updateAvailable: !!i && i !== args.latest, installDir: "C:\\Users\\you\\Games\\" + (CFG.launcher.installFolder || "Games") + "\\" + (args.title || args.gameId), busy: false }; }
        case "get_install_defaults": return { installDir: "C:\\Users\\you\\Games\\" + (CFG.launcher.installFolder || "Games") + "\\" + args.title, installRoot: "C:\\Users\\you\\Games\\" + (CFG.launcher.installFolder || "Games"), freeBytes: 412 * 1024 ** 3 };
        case "pick_install_root": await sleep(300); return { installDir: "D:\\Games\\" + (CFG.launcher.installFolder || "Games") + "\\" + args.title, installRoot: "D:\\Games\\" + (CFG.launcher.installFolder || "Games"), freeBytes: 1.2 * 1024 ** 4 };
        case "get_download_size": return 6071 * 1024 ** 2;
        case "get_cdn_json": { const r = await fetch(`${serverUrl}/${args.path}`); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }
        case "get_achievement_progress": return { unlocked: ["Hallway Wanderer", "Night Owl"], total: 6, updated: new Date().toISOString() };
        case "check_launcher_update": return location.hash === "#update" ? { version: "0.2.0", notes: "Faster downloads and a fix for the install dialog.", date: "" } : null;
        case "install_launcher_update": await sleep(1500); return;
        case "install_or_update": {
          const total = 180 * 1024 * 1024, files = 212;
          for (let i = 0; i <= 40; i++) { await sleep(60); emit("install-progress", { gameId: args.gameId, phase: "downloading", bytesDone: total * i / 40, bytesTotal: total, filesDone: Math.round(files * i / 40), filesTotal: files, currentFile: `game/images/scene_${i}.webp`, message: "" }); }
          emit("install-progress", { gameId: args.gameId, phase: "done", message: "Up to date" });
          installed[args.gameId] = args.version;
          return this.invoke("get_install_status", { gameId: args.gameId, latest: args.version, title: args.title });
        }
        case "get_news_feed": { const r = await fetch(`${serverUrl}/rss.xml`); const xml = new DOMParser().parseFromString(await r.text(), "text/xml"); return [...xml.querySelectorAll("item")].map((i) => ({ title: i.querySelector("title")?.textContent, link: i.querySelector("link")?.textContent, date: i.querySelector("pubDate")?.textContent, summary: (i.querySelector("description")?.textContent || "").replace(/<[^>]+>/g, "") })); }
        case "verify_files": return 0;
        case "uninstall": delete installed[args.gameId]; return;
        case "play": alert("(preview) would launch the game"); return;
        case "open_install_folder": case "open_external": return;
        default: throw new Error(`mock: unknown command ${cmd}`);
      }
    },
  };
}

boot();
