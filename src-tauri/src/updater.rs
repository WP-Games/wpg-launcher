//! Manifest-based updater.
//!
//! The CDN layout (produced by tools/publish.mjs) is:
//!
//!   catalog.json
//!   games/<id>/cover.png
//!   games/<id>/versions/<version>/manifest.json
//!   games/<id>/objects/<sha256>          <- file contents, content-addressed
//!
//! Because objects are addressed by hash, a new version only needs the
//! changed files uploaded, and the launcher only downloads files whose hash
//! differs from what it already has on disk.

use crate::cdc;
use crate::types::{InstalledGame, Manifest, ManifestFile, Progress};
use std::io::{Read, Seek, SeekFrom, Write};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Error)]
pub enum UpdateError {
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("server returned {status} for {url}")]
    Status { status: u16, url: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("hash mismatch for {path}: expected {expected}, got {actual}")]
    HashMismatch {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("manifest contains an unsafe path: {0}")]
    UnsafePath(String),
    #[error("{0}")]
    Signature(String),
}

pub type Result<T> = std::result::Result<T, UpdateError>;

/// What needs to happen to go from the current install to `remote`.
#[derive(Debug, Default)]
pub struct Plan {
    /// Small files fetched whole.
    pub to_download: Vec<ManifestFile>,
    /// Large files rebuilt from chunks (some reused from disk, the rest downloaded).
    pub chunked: Vec<ChunkedPlan>,
    pub to_delete: Vec<String>,
    pub bytes_to_download: u64,
    pub files_kept: usize,
}

#[derive(Debug)]
pub struct ChunkedPlan {
    pub file: ManifestFile,
    /// chunk sha256 → byte offset in the existing on-disk file where identical bytes live
    pub reuse: HashMap<String, u64>,
    /// indices into file.chunks that must be downloaded
    pub needed: Vec<usize>,
}

/// Reject anything that could escape the install directory.
pub fn safe_relative(path: &str) -> Result<PathBuf> {
    let p = Path::new(path);
    if p.is_absolute() || path.contains('\\') || path.contains(':') {
        return Err(UpdateError::UnsafePath(path.to_string()));
    }
    for c in p.components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err(UpdateError::UnsafePath(path.to_string())),
        }
    }
    Ok(p.to_path_buf())
}

/// Diff the remote manifest against what we recorded as installed.
/// Files we previously installed are trusted if they still exist with the
/// right size (full re-hash happens via "Verify files" in the UI).
pub fn plan(
    remote: &Manifest,
    local: Option<&InstalledGame>,
    install_dir: &Path,
    on_scan: &mut dyn FnMut(&str),
) -> Result<Plan> {
    let mut plan = Plan::default();
    let local_map: HashMap<&str, &ManifestFile> = local
        .map(|l| l.files.iter().map(|f| (f.path.as_str(), f)).collect())
        .unwrap_or_default();

    for f in &remote.files {
        let rel = safe_relative(&f.path)?;
        let on_disk = install_dir.join(&rel);
        let keep = match local_map.get(f.path.as_str()) {
            Some(lf) if lf.sha256 == f.sha256 => on_disk
                .metadata()
                .map(|m| m.is_file() && m.len() == f.size)
                .unwrap_or(false),
            _ => false,
        };
        if keep {
            plan.files_kept += 1;
            continue;
        }

        match &f.chunks {
            None => {
                plan.bytes_to_download += f.size;
                plan.to_download.push(f.clone());
            }
            Some(chunks) => {
                // Scan whatever is on disk (old version, or a previous partial
                // assembly) for pieces we can reuse instead of downloading.
                let mut reuse: HashMap<String, u64> = HashMap::new();
                if on_disk.is_file() {
                    on_scan(&f.path);
                    if let Ok(file) = std::fs::File::open(&on_disk) {
                        if let Ok((existing, _)) = cdc::chunk_reader(std::io::BufReader::with_capacity(1 << 20, file)) {
                            for c in existing {
                                reuse.entry(c.sha256).or_insert(c.offset);
                            }
                        }
                    }
                }
                let mut needed = Vec::new();
                let mut bytes_needed = 0u64;
                for (i, c) in chunks.iter().enumerate() {
                    if !reuse.contains_key(&c.sha256) {
                        needed.push(i);
                        bytes_needed += c.size;
                    }
                }
                plan.bytes_to_download += bytes_needed;
                plan.chunked.push(ChunkedPlan { file: f.clone(), reuse, needed });
            }
        }
    }

    let remote_paths: std::collections::HashSet<&str> =
        remote.files.iter().map(|f| f.path.as_str()).collect();
    if let Some(l) = local {
        for f in &l.files {
            if !remote_paths.contains(f.path.as_str()) {
                plan.to_delete.push(f.path.clone());
            }
        }
    }
    Ok(plan)
}

/// Hash a file on disk (used by "Verify files").
pub fn hash_file(path: &Path) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub async fn fetch_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> Result<T> {
    let mut req = client.get(url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        return Err(UpdateError::Status {
            status: resp.status().as_u16(),
            url: url.to_string(),
        });
    }
    Ok(resp.json::<T>().await?)
}

/// Fetch raw bytes (with optional bearer token), mapping non-2xx to Status.
async fn fetch_bytes(client: &reqwest::Client, url: &str, token: Option<&str>) -> Result<Vec<u8>> {
    let mut req = client.get(url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        return Err(UpdateError::Status { status: resp.status().as_u16(), url: url.to_string() });
    }
    Ok(resp.bytes().await?.to_vec())
}

/// Fetch `url` and `url.sig`, verify the Ed25519 signature against `public_key_b64`,
/// then parse. This is what makes a compromised server harmless: without the
/// developer's private key nothing new can be installed.
pub async fn fetch_signed_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    public_key_b64: &str,
) -> Result<T> {
    let body = fetch_bytes(client, url, token).await?;
    let sig = match fetch_bytes(client, &format!("{url}.sig"), token).await {
        Ok(b) => String::from_utf8_lossy(&b).to_string(),
        Err(UpdateError::Status { status: 404, .. }) => {
            return Err(UpdateError::Signature("This file isn't signed. Refusing to use it.".into()))
        }
        Err(e) => return Err(e),
    };
    crate::signing::verify(public_key_b64, &body, &sig).map_err(|e| UpdateError::Signature(e.to_string()))?;
    serde_json::from_slice::<T>(&body).map_err(|e| UpdateError::Signature(format!("signed file is not valid JSON: {e}")))
}

/// Download one object to `dest`, hashing as we stream. Writes to a `.part`
/// file and renames on success so a cancelled download never leaves a
/// corrupt game file in place.
pub async fn download_object(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    dest: &Path,
    expected: &ManifestFile,
    mut on_bytes: impl FnMut(u64),
) -> Result<()> {
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let part = dest.with_extension(match dest.extension() {
        Some(e) => format!("{}.part", e.to_string_lossy()),
        None => "part".to_string(),
    });

    let mut req = client.get(url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        return Err(UpdateError::Status {
            status: resp.status().as_u16(),
            url: url.to_string(),
        });
    }

    let mut file = tokio::fs::File::create(&part).await?;
    let mut hasher = Sha256::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        on_bytes(chunk.len() as u64);
    }
    file.flush().await?;
    drop(file);

    let actual = hex::encode(hasher.finalize());
    if actual != expected.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(UpdateError::HashMismatch {
            path: expected.path.clone(),
            expected: expected.sha256.clone(),
            actual,
        });
    }
    // Windows can't rename over an open/existing file reliably; remove first.
    let _ = tokio::fs::remove_file(dest).await;
    tokio::fs::rename(&part, dest).await?;
    Ok(())
}

/// Execute a plan. `report` is called with progress snapshots.
pub async fn apply_plan(
    client: &reqwest::Client,
    server_url: &str,
    token: Option<&str>,
    manifest: &Manifest,
    plan: &Plan,
    install_dir: &Path,
    mut report: impl FnMut(Progress),
) -> Result<()> {
    let total_files = plan.to_download.len();
    let total_bytes = plan.bytes_to_download;
    let mut bytes_done: u64 = 0;
    let mut done_files = 0usize;
    let mut current = String::new();

    tokio::fs::create_dir_all(install_dir).await?;

    // Downloads run a few at a time; Ren'Py builds have hundreds of small
    // files so parallelism matters more than raw per-file speed.
    const PARALLEL: usize = 4;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(usize, u64)>();
    let base = server_url.trim_end_matches('/').to_string();

    let mut downloads = futures_util::stream::iter(plan.to_download.iter().cloned().enumerate())
        .map(|(i, f)| {
            let url = format!("{}/games/{}/objects/{}", base, manifest.game_id, f.sha256);
            let dest = install_dir.join(safe_relative(&f.path).expect("validated in plan()"));
            let client = client.clone();
            let token = token.map(|s| s.to_string());
            let tx = tx.clone();
            async move {
                let r = download_object(&client, &url, token.as_deref(), &dest, &f, |n| {
                    let _ = tx.send((i, n));
                })
                .await;
                (i, r)
            }
        })
        .buffer_unordered(PARALLEL);

    report(Progress {
        game_id: manifest.game_id.clone(),
        phase: "downloading".into(),
        files_done: 0,
        files_total: total_files,
        bytes_done: 0,
        bytes_total: total_bytes,
        current_file: String::new(),
        message: format!("Downloading {} files", total_files),
    });

    let mut downloads_finished = false;
    while !downloads_finished {
        tokio::select! {
            Some((i, n)) = rx.recv() => {
                bytes_done += n;
                current = plan.to_download[i].path.clone();
            }
            next = downloads.next() => {
                match next {
                    Some((_i, r)) => { r?; done_files += 1; }
                    None => downloads_finished = true,
                }
            }
        }
        report(Progress {
            game_id: manifest.game_id.clone(),
            phase: "downloading".into(),
            files_done: done_files,
            files_total: total_files,
            bytes_done,
            bytes_total: total_bytes,
            current_file: current.clone(),
            message: String::new(),
        });
    }

    // ---- Large files: fetch missing chunks in parallel, then rebuild the file ----
    let total_files = total_files + plan.chunked.len();
    for cp in &plan.chunked {
        let chunks = cp.file.chunks.as_ref().expect("chunked plan has chunks");
        let dest = install_dir.join(safe_relative(&cp.file.path)?);
        let tmp_dir = install_dir.join(".wpg-tmp").join(&cp.file.sha256[..16]);
        tokio::fs::create_dir_all(&tmp_dir).await?;
        current = cp.file.path.clone();

        let (ctx, mut crx) = tokio::sync::mpsc::unbounded_channel::<u64>();
        // Fully owned work items so the futures borrow nothing from this scope.
        let jobs: Vec<(crate::types::ChunkRef, String, PathBuf, ManifestFile, reqwest::Client, Option<String>, tokio::sync::mpsc::UnboundedSender<u64>)> = cp
            .needed
            .iter()
            .map(|&i| {
                let c = chunks[i].clone();
                let url = format!("{}/games/{}/objects/{}", base, manifest.game_id, c.sha256);
                let tmp = tmp_dir.join(&c.sha256);
                let pseudo = ManifestFile {
                    path: format!("{} [chunk {}]", cp.file.path, &c.sha256[..8]),
                    size: c.size,
                    sha256: c.sha256.clone(),
                    platform: String::new(),
                    chunks: None,
                };
                (c, url, tmp, pseudo, client.clone(), token.map(|s| s.to_string()), ctx.clone())
            })
            .collect();
        let mut dl = futures_util::stream::iter(jobs)
            .map(|(c, url, tmp, pseudo, client, token, ctx)| {
                async move {
                    // Resume: a chunk left over from an interrupted run is reused if intact.
                    if tmp.is_file() && hash_file(&tmp).ok().as_deref() == Some(&c.sha256) {
                        let _ = ctx.send(c.size);
                        return Ok(());
                    }
                    download_object(&client, &url, token.as_deref(), &tmp, &pseudo, |n| {
                        let _ = ctx.send(n);
                    })
                    .await
                }
            })
            .buffer_unordered(PARALLEL);

        let mut finished = false;
        while !finished {
            tokio::select! {
                Some(n) = crx.recv() => { bytes_done += n; }
                next = dl.next() => {
                    match next {
                        Some(r) => { r?; }
                        None => finished = true,
                    }
                }
            }
            report(Progress {
                game_id: manifest.game_id.clone(),
                phase: "downloading".into(),
                files_done: done_files,
                files_total: total_files,
                bytes_done,
                bytes_total: total_bytes,
                current_file: current.clone(),
                message: String::new(),
            });
        }

        report(Progress {
            game_id: manifest.game_id.clone(),
            phase: "finalizing".into(),
            files_done: done_files,
            files_total: total_files,
            bytes_done,
            bytes_total: total_bytes,
            current_file: current.clone(),
            message: format!("Assembling {}…", cp.file.path),
        });
        {
            let dest = dest.clone();
            let tmp_dir = tmp_dir.clone();
            let chunks = chunks.clone();
            let reuse = cp.reuse.clone();
            let expected = cp.file.sha256.clone();
            let path = cp.file.path.clone();
            tokio::task::spawn_blocking(move || assemble(&dest, &chunks, &reuse, &tmp_dir, &expected, &path))
                .await
                .map_err(|e| UpdateError::Io(std::io::Error::other(e.to_string())))??;
        }
        let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        done_files += 1;
    }
    let _ = tokio::fs::remove_dir(install_dir.join(".wpg-tmp")).await; // only if empty

    // Remove files that no longer exist in the new version.
    report(Progress {
        game_id: manifest.game_id.clone(),
        phase: "finalizing".into(),
        files_done: done_files,
        files_total: total_files,
        bytes_done,
        bytes_total: total_bytes,
        current_file: String::new(),
        message: "Cleaning up old files".into(),
    });
    for p in &plan.to_delete {
        if let Ok(rel) = safe_relative(p) {
            let _ = tokio::fs::remove_file(install_dir.join(rel)).await;
        }
    }

    // macOS/Linux: files we wrote come out 0644, but the game binary, the
    // Ren'Py launcher script and everything in the platform's lib/ folder
    // must be executable or the game won't start. (Windows has no such bit.)
    #[cfg(unix)]
    mark_executables(manifest, install_dir);
    Ok(())
}

#[cfg(unix)]
fn mark_executables(manifest: &Manifest, install_dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let plat = Manifest::current_platform();
    for f in &manifest.files {
        let wants = f.path == manifest.exe
            || f.path.ends_with(".sh")
            || f.path.contains("/Contents/MacOS/")
            || (f.platform == plat && f.path.starts_with("lib/"));
        if !wants {
            continue;
        }
        if let Ok(rel) = safe_relative(&f.path) {
            let _ = std::fs::set_permissions(install_dir.join(rel), std::fs::Permissions::from_mode(0o755));
        }
    }
}

/// Rebuild `dest` from chunks: reused pieces are copied out of the existing
/// file, the rest come from `tmp_dir/<sha>`. Written to a `.part` file, the
/// whole-file hash is verified, then it replaces `dest`.
fn assemble(
    dest: &Path,
    chunks: &[crate::types::ChunkRef],
    reuse: &HashMap<String, u64>,
    tmp_dir: &Path,
    expected_sha: &str,
    display_path: &str,
) -> Result<()> {
    let part = dest.with_extension(match dest.extension() {
        Some(e) => format!("{}.part", e.to_string_lossy()),
        None => "part".to_string(),
    });
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut src = if dest.is_file() { Some(std::fs::File::open(dest)?) } else { None };
    let mut out = std::io::BufWriter::with_capacity(4 << 20, std::fs::File::create(&part)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];

    for c in chunks {
        let mut remaining = c.size as usize;
        if let (Some(off), Some(src)) = (reuse.get(&c.sha256), src.as_mut()) {
            src.seek(SeekFrom::Start(*off))?;
            while remaining > 0 {
                let want = remaining.min(buf.len());
                let n = src.read(&mut buf[..want])?;
                if n == 0 {
                    return Err(UpdateError::Io(std::io::Error::other("existing file shorter than expected")));
                }
                hasher.update(&buf[..n]);
                out.write_all(&buf[..n])?;
                remaining -= n;
            }
        } else {
            let mut f = std::fs::File::open(tmp_dir.join(&c.sha256))?;
            while remaining > 0 {
                let want = remaining.min(buf.len());
                let n = f.read(&mut buf[..want])?;
                if n == 0 {
                    return Err(UpdateError::Io(std::io::Error::other("downloaded chunk shorter than expected")));
                }
                hasher.update(&buf[..n]);
                out.write_all(&buf[..n])?;
                remaining -= n;
            }
        }
    }
    out.flush()?;
    drop(out);
    drop(src);

    let actual = hex::encode(hasher.finalize());
    if actual != expected_sha {
        let _ = std::fs::remove_file(&part);
        return Err(UpdateError::HashMismatch {
            path: display_path.to_string(),
            expected: expected_sha.to_string(),
            actual,
        });
    }
    let _ = std::fs::remove_file(dest);
    std::fs::rename(&part, dest)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! End-to-end tests against the real `tools/serve.mjs` and the sample
    //! game published into `cdn/` by `npm run demo:v1` / `demo:v2`.
    //! Run with:  cargo test   (needs node on PATH and both demo versions published)
    use super::*;
    use crate::types::InstalledGame;
    use std::process::{Child, Command, Stdio};

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    struct Server(Child, String);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
        }
    }

    async fn start_server(port: u16) -> Server {
        let child = Command::new("node")
            .arg(repo_root().join("tools/serve.mjs"))
            .env("PORT", port.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("node must be installed to run these tests");
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();
        for _ in 0..50 {
            if client.get(format!("{base}/catalog.json")).send().await.is_ok() {
                return Server(child, base);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("server did not start");
    }

    /// Simulate the browser part of login: hit the mock "Allow" endpoint and
    /// pull the token out of the redirect.
    async fn mock_login(base: &str, tier: u32) -> String {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let resp = client
            .get(format!(
                "{base}/auth/mock/allow?redirect_uri=http://127.0.0.1:1/callback&state=s&tier={tier}&name=Tester"
            ))
            .send()
            .await
            .unwrap();
        let loc = resp.headers()["location"].to_str().unwrap().to_string();
        let u = url::Url::parse(&loc).unwrap();
        u.query_pairs().find(|(k, _)| k == "token").unwrap().1.to_string()
    }

    /// Sign the sample manifests with the test key so the suite doesn't depend
    /// on the developer's real signing key.
    fn sign_sample_manifests() -> String {
        let (sk, pk) = crate::signing::testkey::generate();
        for v in ["0.1.0", "0.1.1"] {
            let p = repo_root().join(format!("sample-game/cdn/games/midnight-manor/versions/{v}/manifest.json"));
            let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("run `npm run demo:v1 && npm run demo:v2` first: {e}"));
            std::fs::write(format!("{}.sig", p.display()), crate::signing::testkey::sign(&sk, &bytes)).unwrap();
        }
        pk
    }

    async fn manifest(client: &reqwest::Client, base: &str, token: &str, v: &str, pk: &str) -> Manifest {
        fetch_signed_json(client, &format!("{base}/games/midnight-manor/versions/{v}/manifest.json"), Some(token), pk)
            .await
            .unwrap_or_else(|e| panic!("signed manifest fetch failed: {e}"))
    }

    #[test]
    fn filters_manifest_to_current_platform() {
        let mk = |path: &str, platform: &str| ManifestFile { path: path.into(), size: 10, sha256: "x".into(), platform: platform.into(), chunks: None };
        let m = Manifest {
            game_id: "g".into(),
            version: "1".into(),
            exe: "Game.exe".into(),
            exe_linux: Some("Game.sh".into()),
            exe_mac: Some("Game.app/Contents/MacOS/Game".into()),
            total_size: 50,
            files: vec![
                mk("game/script.rpyc", ""),
                mk("Game.exe", "windows"),
                mk("lib/py3-windows-x86_64/python.dll", "windows"),
                mk("Game.sh", "linux"),
                mk("Game.app/Contents/MacOS/Game", "mac"),
            ],
        }
        .for_current_platform();
        let plat = Manifest::current_platform();
        assert!(m.files.iter().all(|f| f.platform.is_empty() || f.platform == plat));
        assert_eq!(m.files.len(), if plat == "windows" { 3 } else { 2 });
        assert_eq!(m.total_size, m.files.len() as u64 * 10);
        match plat {
            "windows" => assert_eq!(m.exe, "Game.exe"),
            "linux" => assert_eq!(m.exe, "Game.sh"),
            _ => assert_eq!(m.exe, "Game.app/Contents/MacOS/Game"),
        }
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert!(safe_relative("game/script.rpy").is_ok());
        assert!(safe_relative("../evil").is_err());
        assert!(safe_relative("/abs").is_err());
        assert!(safe_relative("C:/win").is_err());
        assert!(safe_relative("a\\b").is_err());
    }

    #[tokio::test]
    async fn install_then_delta_update() {
        let server = start_server(8799).await;
        let base = server.1.clone();
        let client = reqwest::Client::new();

        // Tier-gated: anonymous must be refused.
        let anon: Result<Manifest> =
            fetch_json(&client, &format!("{base}/games/midnight-manor/versions/0.1.0/manifest.json"), None).await;
        assert!(matches!(anon, Err(UpdateError::Status { status: 401, .. })));

        // Too-low tier must be refused.
        let low = mock_login(&base, 0).await;
        let low_res: Result<Manifest> =
            fetch_json(&client, &format!("{base}/games/midnight-manor/versions/0.1.0/manifest.json"), Some(&low)).await;
        assert!(matches!(low_res, Err(UpdateError::Status { status: 403, .. })));

        let token = mock_login(&base, 2).await;
        let pk = sign_sample_manifests();
        let m1 = manifest(&client, &base, &token, "0.1.0", &pk).await;
        let m2 = manifest(&client, &base, &token, "0.1.1", &pk).await;

        // Wrong key → refused. Tampered body → refused.
        let (_, other_pk) = (crate::signing::testkey::generate().0, {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode([9u8; 32])
        });
        let bad: Result<Manifest> = fetch_signed_json(&client, &format!("{base}/games/midnight-manor/versions/0.1.0/manifest.json"), Some(&token), &other_pk).await;
        assert!(matches!(bad, Err(UpdateError::Signature(_))), "manifest signed with another key must be refused");
        let unsigned: Result<serde_json::Value> = fetch_signed_json(&client, &format!("{base}/catalog.json"), None, &pk).await;
        assert!(matches!(unsigned, Err(UpdateError::Signature(_))), "unsigned file must be refused");

        let dir = std::env::temp_dir().join(format!("wpg-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Node-side chunking must equal Rust-side chunking (same boundaries, same hashes).
        let big = m1.files.iter().find(|f| f.path == "game/images.rpa").expect("sample has a chunked archive");
        let node_chunks = big.chunks.as_ref().expect("images.rpa should be chunked by publish.mjs");
        let src = repo_root().join("sample-game/v0.1.0/game/images.rpa");
        let (rust_chunks, whole) = cdc::chunk_reader(std::fs::File::open(&src).unwrap()).unwrap();
        assert_eq!(whole, big.sha256);
        assert_eq!(rust_chunks.len(), node_chunks.len(), "chunk count differs between Node and Rust");
        for (r, n) in rust_chunks.iter().zip(node_chunks) {
            assert_eq!((r.size, &r.sha256), (n.size, &n.sha256));
        }

        // Fresh install: everything downloads (small files whole, big file as chunks).
        let p1 = plan(&m1, None, &dir, &mut |_| {}).unwrap();
        assert_eq!(p1.to_download.len() + p1.chunked.len(), m1.files.len());
        assert_eq!(p1.chunked.len(), 1);
        assert_eq!(p1.chunked[0].needed.len(), node_chunks.len());
        assert_eq!(p1.bytes_to_download, m1.total_size);
        let mut last = None;
        apply_plan(&client, &base, Some(&token), &m1, &p1, &dir, |p| last = Some(p)).await.unwrap();
        for f in &m1.files {
            let on_disk = dir.join(&f.path);
            assert!(on_disk.is_file(), "missing {}", f.path);
            assert_eq!(hash_file(&on_disk).unwrap(), f.sha256, "bad hash {}", f.path);
        }
        assert!(!dir.join("game/script.rpy.part").exists());

        // Update: only the changed files download, removed file is deleted.
        let installed = InstalledGame {
            version: m1.version.clone(),
            exe: m1.exe.clone(),
            install_dir: dir.to_string_lossy().to_string(),
            files: m1.files.clone(),
        };
        let mut scanned = Vec::new();
        let p2 = plan(&m2, Some(&installed), &dir, &mut |f| scanned.push(f.to_string())).unwrap();
        let changed: Vec<_> = p2.to_download.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(p2.to_download.len(), 3, "expected 3 changed small files, got {changed:?}");
        assert!(changed.contains(&"game/script.rpy"));
        assert!(changed.contains(&"game/options.rpy"));
        assert!(changed.contains(&"game/images/bg_room_12.webp"));
        assert_eq!(p2.to_delete, vec!["game/images/bg_room_00.webp".to_string()]);
        // The 24 MB archive had 100 KB inserted: most chunks are reused from disk.
        assert_eq!(scanned, vec!["game/images.rpa".to_string()]);
        assert_eq!(p2.chunked.len(), 1);
        let cp = &p2.chunked[0];
        let total_chunks = cp.file.chunks.as_ref().unwrap().len();
        assert!(cp.needed.len() < total_chunks / 2, "only a few chunks should be needed: {}/{}", cp.needed.len(), total_chunks);
        assert!(!cp.reuse.is_empty());
        assert!(p2.bytes_to_download < m2.total_size / 2, "delta ({}) should be well under the full size ({})", p2.bytes_to_download, m2.total_size);

        apply_plan(&client, &base, Some(&token), &m2, &p2, &dir, |_| {}).await.unwrap();
        assert!(!dir.join("game/images/bg_room_00.webp").exists());
        for f in &m2.files {
            assert_eq!(hash_file(&dir.join(&f.path)).unwrap(), f.sha256, "bad hash after update {}", f.path);
        }

        // A damaged file is picked up by the size check and re-downloaded.
        std::fs::write(dir.join("lib/renpy.dll"), b"corrupt").unwrap();
        let installed2 = InstalledGame { version: m2.version.clone(), exe: m2.exe.clone(), install_dir: installed.install_dir.clone(), files: m2.files.clone() };
        let p3 = plan(&m2, Some(&installed2), &dir, &mut |_| {}).unwrap();
        assert_eq!(p3.to_download.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["lib/renpy.dll"]);
        assert!(p3.chunked.is_empty());

        // Interrupted assembly: a truncated archive on disk still yields partial reuse, and repair works.
        let rpa = dir.join("game/images.rpa");
        let full = std::fs::read(&rpa).unwrap();
        std::fs::write(&rpa, &full[..full.len() / 2]).unwrap();
        let p4 = plan(&m2, Some(&installed2), &dir, &mut |_| {}).unwrap();
        assert_eq!(p4.chunked.len(), 1);
        assert!(!p4.chunked[0].reuse.is_empty(), "first half of the file should still be reusable");
        apply_plan(&client, &base, Some(&token), &m2, &p4, &dir, |_| {}).await.unwrap();
        assert_eq!(hash_file(&rpa).unwrap(), m2.files.iter().find(|f| f.path == "game/images.rpa").unwrap().sha256);
        assert!(!dir.join(".wpg-tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
