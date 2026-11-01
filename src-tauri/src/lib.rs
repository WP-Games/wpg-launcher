mod auth;
mod cdc;
mod config;
mod news;
mod signing;
mod store;
mod types;
mod updater;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use types::*;

/// Shared app state. Settings/installed DB are re-read from disk on each
/// command (they're tiny) so there's a single source of truth; `busy`
/// tracks games currently installing so the UI can't start two at once.
pub struct AppState {
    app_data: PathBuf,
    client: reqwest::Client,
    busy: Mutex<HashSet<String>>,
}

impl AppState {
    fn settings(&self) -> Settings {
        store::load_settings(&self.app_data)
    }
    fn installed(&self) -> InstalledDb {
        store::load_installed(&self.app_data)
    }
    /// Where a game lives: its recorded folder if installed, otherwise the
    /// default location for a fresh install.
    fn install_dir(&self, game_id: &str, title: &str) -> PathBuf {
        if let Some(g) = self.installed().games.get(game_id) {
            return PathBuf::from(&g.install_dir);
        }
        self.install_root().join(folder_name(title))
    }

    fn install_root(&self) -> PathBuf {
        if let Some(r) = self.settings().install_root {
            return PathBuf::from(r);
        }
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| self.app_data.clone())
            .join("Games")
            .join(&config::config().launcher.install_folder)
    }
}

/// "Defending Lydia Collier" → "Defending Lydia Collier" (just strips characters Windows forbids).
fn folder_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let t = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() { "Game".to_string() } else { t }
}

fn free_space(path: &std::path::Path) -> u64 {
    // Walk up until an existing ancestor so new folders still report their drive's space.
    let mut p = path.to_path_buf();
    while !p.exists() {
        if !p.pop() {
            return 0;
        }
    }
    fs4::available_space(&p).unwrap_or(0)
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- settings & account ----------

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    let mut s = state.settings();
    s.token = s.token.map(|_| "•••".to_string()); // never hand the raw token to the UI
    s
}

#[tauri::command]
fn set_server_url(state: State<AppState>, url: String) -> Result<(), String> {
    let mut s = state.settings();
    s.server_url = url.trim().trim_end_matches('/').to_string();
    store::save_settings(&state.app_data, &s).map_err(err)
}

#[tauri::command]
fn get_account(state: State<AppState>) -> Option<Account> {
    state.settings().account
}

#[tauri::command]
async fn login(app: AppHandle, state: State<'_, AppState>, provider: String) -> Result<Account, String> {
    let settings = state.settings();
    let start = auth::begin(&settings.server_url, &provider).await.map_err(err)?;
    app.opener()
        .open_url(&start.browser_url, None::<&str>)
        .map_err(err)?;
    let token = auth::wait_for_callback(&start).await?;
    let mut account = auth::fetch_account(&state.client, &settings.server_url, &token)
        .await
        .map_err(|e| e.to_string())?;
    let token = account.token.take().unwrap_or(token);

    let mut s = state.settings();
    s.token = Some(token);
    s.account = Some(account.clone());
    store::save_settings(&state.app_data, &s).map_err(err)?;
    Ok(account)
}

/// Sign in with an access code (testers / friends). The server validates the
/// code and returns an account + token exactly like a provider login.
#[tauri::command]
async fn login_with_code(state: State<'_, AppState>, code: String) -> Result<Account, String> {
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err("Enter a code".into());
    }
    let settings = state.settings();
    let url = format!("{}/auth/code", settings.server_url);
    let resp = state
        .client
        .post(&url)
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the server: {e}"))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("That code isn't valid.".into());
    }
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Too many attempts — wait a moment and try again.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Server error ({})", resp.status()));
    }
    let mut account: Account = resp.json().await.map_err(err)?;
    let token = account.token.take().ok_or("Server didn't return a session")?;
    let mut s = state.settings();
    s.token = Some(token);
    s.account = Some(account.clone());
    store::save_settings(&state.app_data, &s).map_err(err)?;
    Ok(account)
}

/// Re-check the tier with the server (e.g. after the player upgrades).
#[tauri::command]
async fn refresh_account(state: State<'_, AppState>) -> Result<Option<Account>, String> {
    refresh_account_inner(&state).await
}

async fn refresh_account_inner(state: &AppState) -> Result<Option<Account>, String> {
    let mut s = state.settings();
    let Some(token) = s.token.clone() else {
        return Ok(None);
    };
    match auth::fetch_account(&state.client, &s.server_url, &token).await {
        Ok(mut acc) => {
            if let Some(t) = acc.token.take() {
                s.token = Some(t);
            }
            s.account = Some(acc.clone());
            store::save_settings(&state.app_data, &s).map_err(err)?;
            Ok(Some(acc))
        }
        Err(auth::AccountError::Rejected(_)) => {
            // Token expired or revoked: sign out locally.
            s.token = None;
            s.account = None;
            store::save_settings(&state.app_data, &s).map_err(err)?;
            Ok(None)
        }
        Err(auth::AccountError::Unavailable(_)) => {
            // Offline or server hiccup: keep the last known account.
            Ok(s.account.clone())
        }
    }
}

#[tauri::command]
fn logout(state: State<AppState>) -> Result<(), String> {
    let mut s = state.settings();
    s.token = None;
    s.account = None;
    store::save_settings(&state.app_data, &s).map_err(err)
}

// ---------- catalog & install status ----------

/// Catalog plus where it came from: live network, the on-disk copy of the last
/// live fetch, or the snapshot compiled into the launcher (first run offline).
#[derive(serde::Serialize)]
struct CatalogResult {
    catalog: Catalog,
    offline: bool,
    bundled: bool,
}

/// Snapshot taken by tools/bundle-offline.mjs at build time.
const BUNDLED_CATALOG: &str = include_str!("../bundled/catalog.json");

/// Fetches catalog.json; on network failure falls back to the last copy we
/// saved, so installed games stay playable without a connection.
#[tauri::command]
async fn get_catalog(state: State<'_, AppState>) -> Result<CatalogResult, String> {
    let s = state.settings();
    let url = format!("{}/catalog.json", s.server_url);
    let cache = state.app_data.join("catalog-cache.json");
    let fetched = match updater::fetch_signed_json::<Catalog>(&state.client, &url, None, signing::EMBEDDED_PUBLIC_KEY).await {
        Err(updater::UpdateError::Signature(_)) if cfg!(debug_assertions) => {
            eprintln!("[dev] catalog signature missing/invalid — allowed in debug builds only");
            updater::fetch_json::<Catalog>(&state.client, &url, None).await
        }
        other => other,
    };
    match fetched {
        Ok(c) => {
            if let Ok(bytes) = serde_json::to_vec(&c) {
                let _ = std::fs::write(&cache, bytes);
            }
            Ok(CatalogResult { catalog: c, offline: false, bundled: false })
        }
        Err(e) => match std::fs::read(&cache).ok().and_then(|b| serde_json::from_slice::<Catalog>(&b).ok()) {
            Some(c) => Ok(CatalogResult { catalog: c, offline: true, bundled: false }),
            None => match serde_json::from_str::<Catalog>(BUNDLED_CATALOG) {
                Ok(c) => Ok(CatalogResult { catalog: c, offline: true, bundled: true }),
                Err(_) => Err(e.to_string()),
            },
        },
    }
}

#[tauri::command]
fn get_install_status(state: State<AppState>, game_id: String, latest: String, title: String) -> InstallStatus {
    let db = state.installed();
    let inst = db.games.get(&game_id);
    let busy = state.busy.lock().unwrap().contains(&game_id);
    InstallStatus {
        game_id: game_id.clone(),
        installed: inst.is_some(),
        installed_version: inst.map(|g| g.version.clone()),
        update_available: inst.map(|g| g.version != latest).unwrap_or(false),
        latest_version: latest,
        install_dir: state.install_dir(&game_id, &title).to_string_lossy().to_string(),
        busy,
    }
}

/// Total bytes a fresh install of this version would download on this platform.
#[tauri::command]
async fn get_download_size(state: State<'_, AppState>, game_id: String, version: String) -> Result<u64, String> {
    let s = state.settings();
    let url = format!("{}/games/{}/versions/{}/manifest.json", s.server_url, game_id, version);
    let m: Manifest = updater::fetch_signed_json::<Manifest>(&state.client, &url, s.token.as_deref(), signing::EMBEDDED_PUBLIC_KEY)
        .await
        .map(Manifest::for_current_platform)
        .map_err(err)?;
    Ok(m.total_size)
}

/// Proposed folder + free space for the install dialog.
#[tauri::command]
fn get_install_defaults(state: State<AppState>, title: String) -> InstallDefaults {
    let root = state.install_root();
    let dir = root.join(folder_name(&title));
    InstallDefaults {
        free_bytes: free_space(&dir),
        install_dir: dir.to_string_lossy().to_string(),
        install_root: root.to_string_lossy().to_string(),
    }
}

/// Native "choose folder" dialog. Returns the chosen *root*; the game goes in a
/// subfolder named after it. Remembers the root for next time.
#[tauri::command]
async fn pick_install_root(app: AppHandle, state: State<'_, AppState>, title: String) -> Result<Option<InstallDefaults>, String> {
    let current = state.install_root();
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose where to install games")
            .set_directory(current)
            .blocking_pick_folder()
    })
    .await
    .map_err(err)?;
    let Some(fp) = picked else { return Ok(None) };
    let root = fp.into_path().map_err(err)?;
    let mut s = state.settings();
    s.install_root = Some(root.to_string_lossy().to_string());
    store::save_settings(&state.app_data, &s).map_err(err)?;
    let dir = root.join(folder_name(&title));
    Ok(Some(InstallDefaults {
        free_bytes: free_space(&dir),
        install_dir: dir.to_string_lossy().to_string(),
        install_root: root.to_string_lossy().to_string(),
    }))
}

/// Website RSS → "What's New". `url` comes from catalog.newsFeed.
#[tauri::command]
async fn get_news_feed(state: State<'_, AppState>, url: String) -> Result<Vec<news::NewsItem>, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Invalid feed URL".into());
    }
    news::fetch_feed(&state.client, &url, 8).await
}

// ---------- install / update ----------

#[tauri::command]
async fn install_or_update(
    app: AppHandle,
    state: State<'_, AppState>,
    game_id: String,
    version: String,
    title: String,
    install_dir: Option<String>,
) -> Result<InstallStatus, String> {
    {
        let mut busy = state.busy.lock().unwrap();
        if !busy.insert(game_id.clone()) {
            return Err("That game is already installing.".into());
        }
    }
    // Fresh installs may choose a folder; updates always use the recorded one.
    let dir = match (state.installed().games.get(&game_id), install_dir) {
        (Some(g), _) => PathBuf::from(&g.install_dir),
        (None, Some(d)) if !d.trim().is_empty() => PathBuf::from(d),
        (None, None) | (None, Some(_)) => state.install_dir(&game_id, &title),
    };
    let result = do_install(&app, &state, &game_id, &version, &dir).await;
    state.busy.lock().unwrap().remove(&game_id);

    match result {
        Ok(()) => {
            let _ = app.emit(
                "install-progress",
                Progress {
                    game_id: game_id.clone(),
                    phase: "done".into(),
                    files_done: 0,
                    files_total: 0,
                    bytes_done: 0,
                    bytes_total: 0,
                    current_file: String::new(),
                    message: "Up to date".into(),
                },
            );
            Ok(get_install_status(state, game_id, version, title))
        }
        Err(e) => {
            let _ = app.emit(
                "install-progress",
                Progress {
                    game_id: game_id.clone(),
                    phase: "error".into(),
                    files_done: 0,
                    files_total: 0,
                    bytes_done: 0,
                    bytes_total: 0,
                    current_file: String::new(),
                    message: e.clone(),
                },
            );
            Err(e)
        }
    }
}

async fn do_install(app: &AppHandle, state: &AppState, game_id: &str, version: &str, install_dir: &std::path::Path) -> Result<(), String> {
    // Re-check the tier with the server first (also picks up a refreshed token).
    if state.settings().token.is_some() {
        let _ = refresh_account_inner(state).await;
    }
    let s = state.settings();
    let token = s.token.as_deref();
    let emit = |p: Progress| {
        let _ = app.emit("install-progress", p);
    };

    emit(Progress {
        game_id: game_id.to_string(),
        phase: "planning".into(),
        files_done: 0,
        files_total: 0,
        bytes_done: 0,
        bytes_total: 0,
        current_file: String::new(),
        message: "Checking files…".into(),
    });

    let manifest_url = format!("{}/games/{}/versions/{}/manifest.json", s.server_url, game_id, version);
    let manifest: Manifest = updater::fetch_signed_json::<Manifest>(&state.client, &manifest_url, token, signing::EMBEDDED_PUBLIC_KEY)
        .await
        .map(Manifest::for_current_platform)
        .map_err(|e| match e {
            updater::UpdateError::Status { status: 401, .. } => "Please sign in to download this game.".to_string(),
            updater::UpdateError::Status { status: 403, .. } => "Your current tier doesn't include this game.".to_string(),
            other => other.to_string(),
        })?;

    let install_dir = install_dir.to_path_buf();
    let db = state.installed();
    // Planning may read multi-GB files to find reusable chunks → off the async thread.
    let plan = {
        let manifest = manifest.clone();
        let local = db.games.get(game_id).cloned();
        let dir = install_dir.clone();
        let app2 = app.clone();
        let gid = game_id.to_string();
        tokio::task::spawn_blocking(move || {
            updater::plan(&manifest, local.as_ref(), &dir, &mut |file: &str| {
                let _ = app2.emit(
                    "install-progress",
                    Progress {
                        game_id: gid.clone(),
                        phase: "planning".into(),
                        files_done: 0,
                        files_total: 0,
                        bytes_done: 0,
                        bytes_total: 0,
                        current_file: file.to_string(),
                        message: format!("Checking existing files… {file}"),
                    },
                );
            })
        })
        .await
        .map_err(err)?
        .map_err(err)?
    };

    updater::apply_plan(
        &state.client,
        &s.server_url,
        token,
        &manifest,
        &plan,
        &install_dir,
        emit,
    )
    .await
    .map_err(err)?;

    let mut db = state.installed();
    db.games.insert(
        game_id.to_string(),
        InstalledGame {
            version: manifest.version.clone(),
            exe: manifest.exe.clone(),
            install_dir: install_dir.to_string_lossy().to_string(),
            files: manifest.files.clone(),
        },
    );
    store::save_installed(&state.app_data, &db).map_err(err)
}

/// Re-hash every installed file and report how many are damaged. The next
/// Install/Update click will re-download them because plan() checks size,
/// and we drop bad entries from the DB here so hashes are re-fetched.
#[tauri::command]
async fn verify_files(state: State<'_, AppState>, game_id: String) -> Result<usize, String> {
    let mut db = state.installed();
    let Some(g) = db.games.get_mut(&game_id) else {
        return Err("Not installed".into());
    };
    let dir = PathBuf::from(&g.install_dir);
    let mut bad = 0usize;
    let mut good = Vec::new();
    for f in &g.files {
        let p = dir.join(&f.path);
        match updater::hash_file(&p) {
            Ok(h) if h == f.sha256 => good.push(f.clone()),
            _ => bad += 1,
        }
    }
    g.files = good;
    if bad > 0 {
        // Force "update available" so the button re-downloads.
        g.version = format!("{}+damaged", g.version);
    }
    store::save_installed(&state.app_data, &db).map_err(err)?;
    Ok(bad)
}

#[tauri::command]
fn play(app: AppHandle, state: State<AppState>, game_id: String) -> Result<(), String> {
    let db = state.installed();
    let g = db.games.get(&game_id).ok_or("Game is not installed")?;
    let exe = PathBuf::from(&g.install_dir).join(&g.exe);
    if !exe.exists() {
        return Err(format!("Executable not found: {}", exe.display()));
    }
    let mut child = std::process::Command::new(&exe)
        .current_dir(&g.install_dir)
        .spawn()
        .map_err(|e| format!("Couldn't start game: {e}"))?;
    let _ = app.emit("game-started", &game_id);
    // Watch the process so the UI can refresh achievements when the player quits.
    tauri::async_runtime::spawn_blocking(move || {
        let _ = child.wait();
        let _ = app.emit("game-exited", &game_id);
    });
    Ok(())
}

// ---------- launcher self-update (signed by Tauri's updater key) ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherUpdate {
    version: String,
    notes: String,
    date: String,
}

/// Asks the update endpoint whether a newer launcher exists. Any problem
/// (offline, endpoint missing, pubkey not configured) simply means "no update".
#[tauri::command]
async fn check_launcher_update(app: AppHandle) -> Option<LauncherUpdate> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().ok()?;
    match updater.check().await {
        Ok(Some(u)) => Some(LauncherUpdate {
            version: u.version.clone(),
            notes: u.body.clone().unwrap_or_default(),
            date: u.date.map(|d| d.to_string()).unwrap_or_default(),
        }),
        Ok(None) => None,
        Err(e) => {
            eprintln!("launcher update check failed: {e}");
            None
        }
    }
}

/// Downloads the signed installer, verifies it, runs it (passive mode) and
/// restarts into the new version. Game installs and settings are untouched.
#[tauri::command]
async fn install_launcher_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(err)?;
    let Some(update) = updater.check().await.map_err(err)? else {
        return Err("No update available".into());
    };
    let app2 = app.clone();
    update
        .download_and_install(
            move |downloaded, total| {
                let _ = app2.emit("launcher-update-progress", serde_json::json!({ "downloaded": downloaded, "total": total }));
            },
            || {},
        )
        .await
        .map_err(err)?;
    app.restart();
}

/// Ren'Py's per-user save folder for a game.
fn renpy_save_dir(save_directory: &str) -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("RenPy").join(save_directory))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/RenPy").join(save_directory))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".renpy").join(save_directory))
    }
}

/// Unlocked achievements, as last written by the game (None = never launched with the sync script).
#[tauri::command]
fn get_achievement_progress(save_directory: String) -> Option<AchievementProgress> {
    if save_directory.contains(['/', '\\', ':']) || save_directory.contains("..") {
        return None;
    }
    let path = renpy_save_dir(&save_directory)?.join("launcher_achievements.json");
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Public JSON from the CDN (achievements.json); kept generic for future metadata files.
#[tauri::command]
async fn get_cdn_json(state: State<'_, AppState>, path: String) -> Result<serde_json::Value, String> {
    if path.contains("..") || path.starts_with('/') {
        return Err("bad path".into());
    }
    let s = state.settings();
    let url = format!("{}/{}", s.server_url, path);
    updater::fetch_json::<serde_json::Value>(&state.client, &url, None).await.map_err(err)
}

#[tauri::command]
fn open_install_folder(app: AppHandle, state: State<AppState>, game_id: String) -> Result<(), String> {
    let db = state.installed();
    let g = db.games.get(&game_id).ok_or("Game is not installed")?;
    let dir = PathBuf::from(&g.install_dir);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(err)
}

#[tauri::command]
fn uninstall(state: State<AppState>, game_id: String) -> Result<(), String> {
    let mut db = state.installed();
    if let Some(g) = db.games.remove(&game_id) {
        let dir = PathBuf::from(&g.install_dir);
        // Only ever delete the folder we created: it must contain the game's exe
        // and must not be a drive root or the install root itself.
        let looks_like_ours = dir.join(&g.exe).exists() && dir.parent().map(|p| p.parent().is_some()).unwrap_or(false);
        if looks_like_ours {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("Couldn't remove game files: {e}"))?;
        }
    }
    store::save_installed(&state.app_data, &db).map_err(err)
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            let client = reqwest::Client::builder()
                .user_agent(format!("{}-Launcher/{}", config::config().launcher.product_name.replace(' ', ""), env!("CARGO_PKG_VERSION")))
                .build()?;
            app.manage(AppState {
                app_data,
                client,
                busy: Mutex::new(HashSet::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_server_url,
            get_account,
            login,
            login_with_code,
            refresh_account,
            logout,
            get_catalog,
            get_news_feed,
            get_install_status,
            get_install_defaults,
            get_download_size,
            pick_install_root,
            install_or_update,
            verify_files,
            play,
            get_achievement_progress,
            get_cdn_json,
            check_launcher_update,
            install_launcher_update,
            open_install_folder,
            uninstall,
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the launcher");
}
