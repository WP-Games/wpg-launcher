//! Tiny JSON persistence for settings and the installed-games database.

use crate::types::{InstalledDb, Settings};
use std::fs;
use std::path::Path;

pub fn load_settings(app_data: &Path) -> Settings {
    let p = app_data.join("settings.json");
    fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save_settings(app_data: &Path, s: &Settings) -> std::io::Result<()> {
    fs::create_dir_all(app_data)?;
    write_atomic(&app_data.join("settings.json"), &serde_json::to_vec_pretty(s)?)
}

pub fn load_installed(app_data: &Path) -> InstalledDb {
    let p = app_data.join("installed.json");
    fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save_installed(app_data: &Path, db: &InstalledDb) -> std::io::Result<()> {
    fs::create_dir_all(app_data)?;
    write_atomic(&app_data.join("installed.json"), &serde_json::to_vec_pretty(db)?)
}

/// Write to a temp file then rename, so a crash mid-write never leaves a
/// half-written JSON file behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}
