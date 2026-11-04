//! Shared data types. The same shapes are used by the CDN (catalog.json,
//! manifest.json), the auth server, the Rust backend and the frontend.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Top-level list of games served from `<server>/catalog.json`.
/// This file is public: logged-out players can still browse the games.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub games: Vec<Game>,
    /// RSS feed shown in "What's New" for every game. Defaults to the
    /// website feed when missing.
    #[serde(default = "default_news_feed")]
    pub news_feed: String,
    /// Where "Upgrade" buttons send players, per provider, plus the name of
    /// the cheapest Day-1 tier for the "out now for …" wording. Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support: Option<serde_json::Value>,
}

pub fn default_news_feed() -> String {
    crate::config::config().links.news_feed.clone()
}

/// A short per-game announcement pushed via catalog.json ("Game News").
/// Player-facing text in the catalog: either a plain string (English) or a
/// map of language code → string, e.g. `{"en": "…", "de": "…"}`. The UI picks
/// its language and falls back to `en`, then to the first entry. Passed through
/// to the UI as-is, so the JSON shape is preserved.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Text {
    Plain(String),
    Localized(std::collections::BTreeMap<String, String>),
}

impl Default for Text {
    fn default() -> Self {
        Text::Plain(String::new())
    }
}

impl Text {
    /// English (or the only) value — for logs and non-UI uses.
    #[allow(dead_code)]
    pub fn en(&self) -> &str {
        match self {
            Text::Plain(s) => s,
            Text::Localized(m) => m.get("en").or_else(|| m.values().next()).map(String::as_str).unwrap_or(""),
        }
    }
}

/// `text` may contain Markdown-style links: `[Full changelog](https://…)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameNews {
    pub title: Text,
    #[serde(default)]
    pub text: Text,
    #[serde(default)]
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub tagline: Text,
    #[serde(default)]
    pub description: Text,
    /// Relative URL on the CDN, e.g. `games/midnight-manor/cover.png`.
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub hero: String,
    /// Minimum tier level required to download (0 = free/public).
    #[serde(default)]
    pub required_tier: u32,
    /// Human-readable name of that tier, for the "unlock" button.
    #[serde(default)]
    pub required_tier_name: String,
    /// Latest version string; the manifest lives at
    /// `games/<id>/versions/<latest>/manifest.json`.
    pub latest: String,
    #[serde(default)]
    pub versions: Vec<VersionInfo>,
    #[serde(default)]
    pub coming_soon: bool,
    /// Up to 2 are shown; the newest should be first.
    #[serde(default)]
    pub news: Vec<GameNews>,
    /// CDN path of achievements.json (from tools/achievements-export.mjs).
    #[serde(default)]
    pub achievements: Option<String>,
    /// Ren'Py `config.save_directory` — where launcher_achievements.json is written.
    #[serde(default)]
    pub save_directory: Option<String>,
}

/// Contents of launcher_achievements.json written by game-integration/launcher_sync.rpy.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AchievementProgress {
    #[serde(default)]
    pub unlocked: Vec<String>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub updated: String,
    #[serde(default)]
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub version: String,
    #[serde(default)]
    pub date: String,
    /// ISO date-time Day-1 tiers get this version; other tiers add their `delayDays`.
    #[serde(default)]
    pub released_at: String,
    #[serde(default)]
    pub notes: Text,
}

/// Per-version file list produced by `tools/publish.mjs`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub game_id: String,
    pub version: String,
    /// Windows executable, relative to the install dir.
    pub exe: String,
    #[serde(default)]
    pub exe_linux: Option<String>,
    #[serde(default)]
    pub exe_mac: Option<String>,
    pub total_size: u64,
    pub files: Vec<ManifestFile>,
}

impl Manifest {
    /// The platform tag the running launcher should keep ("windows" | "linux" | "mac").
    pub fn current_platform() -> &'static str {
        if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "macos") {
            "mac"
        } else {
            "linux"
        }
    }

    /// Drop files that belong to other platforms (a "for markets" Ren'Py build
    /// bundles Windows + Mac + Linux; players only download their own share)
    /// and pick the matching executable.
    pub fn for_current_platform(mut self) -> Self {
        let plat = Self::current_platform();
        self.files.retain(|f| f.platform.is_empty() || f.platform == "all" || f.platform == plat);
        self.total_size = self.files.iter().map(|f| f.size).sum();
        if plat == "linux" {
            if let Some(e) = self.exe_linux.take() {
                self.exe = e;
            }
        } else if plat == "mac" {
            if let Some(e) = self.exe_mac.take() {
                self.exe = e;
            }
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    /// Forward-slash relative path, e.g. `game/script.rpyc`.
    pub path: String,
    pub size: u64,
    pub sha256: String,
    /// "windows" | "linux" | "mac" | "" (= all platforms).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub platform: String,
    /// Present for large files: content-defined pieces, in order. Each is a
    /// separate object on the CDN; `sha256` above is still the whole file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunks: Option<Vec<ChunkRef>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChunkRef {
    pub size: u64,
    pub sha256: String,
}

/// What the auth server tells us about the logged-in player.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub provider: String, // "patreon" | "subscribestar" | "mock"
    pub display_name: String,
    #[serde(default)]
    pub avatar: String,
    /// Numeric tier level, compared against `Game.required_tier`.
    pub tier: u32,
    #[serde(default)]
    pub tier_name: String,
    #[serde(default)]
    pub patron_status: String,
    /// Release-window delay for this tier (days after a version's Day-1 release).
    #[serde(default)]
    pub delay_days: u32,
    /// The server may hand back a refreshed launcher token with /auth/me.
    /// Stored by the backend, never sent to the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

/// Persisted in `<app_data>/settings.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub server_url: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub account: Option<Account>,
    /// Folder new games are installed under (each game gets its own subfolder).
    /// None → `<home>/Games/<launcher.installFolder from launcher.config.json>`.
    #[serde(default)]
    pub install_root: Option<String>,
    /// `legal.termsVersion` the user accepted on the first-run screen (None → not yet).
    #[serde(default)]
    pub accepted_terms: Option<String>,
    /// UI language code from i18n.js ("en", "de", "ja", …). None → English.
    #[serde(default)]
    pub language: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            // Production backend. For local testing against tools/serve.mjs,
            // run a dev build (`npm run dev`) and change it in
            // Settings → Content server (http://127.0.0.1:8787). Release builds
            // ignore this field and always use the production server.
            server_url: crate::config::config().server.api_url.clone(),
            token: None,
            account: None,
            install_root: None,
            accepted_terms: None,
            language: None,
        }
    }
}

/// Persisted in `<app_data>/installed.json`: which version of each game is
/// on disk and the exact file list we installed, so we can diff against a
/// new manifest without re-hashing everything.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstalledDb {
    pub games: HashMap<String, InstalledGame>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledGame {
    pub version: String,
    pub exe: String,
    pub install_dir: String,
    pub files: Vec<ManifestFile>,
}

/// What the install dialog needs before a fresh install.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallDefaults {
    pub install_dir: String,
    pub install_root: String,
    pub free_bytes: u64,
}

/// Sent to the frontend so it can render the right button.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub game_id: String,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub latest_version: String,
    pub update_available: bool,
    pub install_dir: String,
    pub busy: bool,
}

/// Streamed to the frontend during install/update as the
/// `install-progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub game_id: String,
    pub phase: String, // "planning" | "downloading" | "verifying" | "finalizing" | "done" | "error"
    pub files_done: usize,
    pub files_total: usize,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub current_file: String,
    pub message: String,
}
