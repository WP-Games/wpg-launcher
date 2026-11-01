//! Studio-specific settings, compiled in from `launcher.config.json` at the
//! repo root (the same file the Worker and the tooling read). Edit that file,
//! not this one.
use serde::Deserialize;
use std::sync::LazyLock;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub studio: Studio,
    pub launcher: Launcher,
    pub server: Server,
    pub links: Links,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // kept for completeness; the UI shows the studio name
pub struct Studio {
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Launcher {
    pub product_name: String,
    /// Folder under `<home>/Games/` that games install into by default.
    pub install_folder: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub api_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Links {
    pub news_feed: String,
}

pub static CONFIG: LazyLock<Config> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../launcher.config.json"))
        .expect("launcher.config.json is not valid — see its $comment")
});

pub fn config() -> &'static Config {
    &CONFIG
}

#[cfg(test)]
mod tests {
    #[test]
    fn config_parses_and_has_sane_urls() {
        let c = super::config();
        assert!(c.server.api_url.starts_with("https://"), "apiUrl must be https");
        assert!(!c.server.api_url.ends_with('/'), "apiUrl must not end with a slash");
        assert!(c.links.news_feed.starts_with("http"));
        assert!(!c.launcher.install_folder.contains(['\\', '/', ':']));
    }
}
