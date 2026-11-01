//! Browser-based login.
//!
//! Flow (identical shape for the mock server and for real Patreon /
//! SubscribeStar OAuth later):
//!
//!   1. Launcher starts a one-shot HTTP listener on 127.0.0.1:<random port>.
//!   2. Launcher opens the system browser at
//!      `<server>/auth/<provider>/start?redirect_uri=http://127.0.0.1:<port>/callback&state=<nonce>`
//!   3. The player logs in on the provider's site and clicks Allow.
//!   4. The server redirects the browser to our callback with
//!      `?token=<launcher token>&state=<nonce>`.
//!   5. Launcher checks the nonce, stores the token, and asks the server
//!      `/auth/me` who this is and what tier they're on.
//!
//! The launcher never sees the player's password; the token is an opaque
//! string the server issues, and the server decides what tier it maps to.

use crate::types::Account;
use rand::{distributions::Alphanumeric, Rng};
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct LoginStart {
    pub listener: TcpListener,
    pub state: String,
    pub browser_url: String,
}

pub async fn begin(server_url: &str, provider: &str) -> std::io::Result<LoginStart> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let state: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let browser_url = format!(
        "{}/auth/{}/start?redirect_uri={}&state={}",
        server_url.trim_end_matches('/'),
        provider,
        urlencoding(&redirect),
        state
    );
    Ok(LoginStart {
        listener,
        state,
        browser_url,
    })
}

/// Wait (up to 5 minutes) for the browser to hit our callback. Returns the
/// token. Any other request (favicon, etc.) is answered and ignored.
pub async fn wait_for_callback(start: &LoginStart) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("Login timed out. Please try again.".into());
        }
        let accept = tokio::time::timeout(remaining, start.listener.accept()).await;
        let (mut sock, _) = match accept {
            Ok(Ok(x)) => x,
            Ok(Err(e)) => return Err(format!("listener error: {e}")),
            Err(_) => return Err("Login timed out. Please try again.".into()),
        };

        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => continue,
        };
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let first = req.lines().next().unwrap_or_default();
        // "GET /callback?token=..&state=.. HTTP/1.1"
        let path = first.split_whitespace().nth(1).unwrap_or("");

        if !path.starts_with("/callback") {
            let _ = sock
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        }

        let query = path.splitn(2, '?').nth(1).unwrap_or("");
        let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
            .into_owned()
            .collect();

        let ok = params.get("state") == Some(&start.state) && params.contains_key("token");
        let body = if ok {
            PAGE_OK
        } else if let Some(err) = params.get("error") {
            let _ = err;
            PAGE_DENIED
        } else {
            PAGE_BAD
        };
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.shutdown().await;

        if ok {
            return Ok(params["token"].clone());
        }
        if params.contains_key("error") {
            return Err("Login was cancelled.".into());
        }
        return Err("Login response didn't match this launcher session. Please try again.".into());
    }
}

#[derive(Debug)]
pub enum AccountError {
    /// The server said no (401/403): the session really is over.
    Rejected(String),
    /// Couldn't reach the server or got a server error: keep what we have.
    Unavailable(String),
}

impl std::fmt::Display for AccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AccountError::Rejected(m) | AccountError::Unavailable(m) => write!(f, "{m}"),
        }
    }
}

pub async fn fetch_account(
    client: &reqwest::Client,
    server_url: &str,
    token: &str,
) -> Result<Account, AccountError> {
    let url = format!("{}/auth/me", server_url.trim_end_matches('/'));
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| AccountError::Unavailable(format!("Couldn't reach the server: {e}")))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(AccountError::Rejected(format!("Session expired ({status})")));
    }
    if !status.is_success() {
        return Err(AccountError::Unavailable(format!("Server error ({status})")));
    }
    resp.json::<Account>()
        .await
        .map_err(|e| AccountError::Unavailable(e.to_string()))
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

const PAGE_OK: &str = "<!doctype html><html><head><meta charset=utf-8><title>Signed in</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f14;color:#eceef5;font:16px/1.5 system-ui,Segoe UI,sans-serif}div{text-align:center;padding:2rem}h1{font-weight:600;margin:0 0 .5rem}p{opacity:.7;margin:0}</style></head><body><div><h1>You're signed in</h1><p>You can close this tab and return to the launcher.</p></div></body></html>";
const PAGE_DENIED: &str = "<!doctype html><html><head><meta charset=utf-8><title>Cancelled</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f14;color:#eceef5;font:16px/1.5 system-ui,Segoe UI,sans-serif}div{text-align:center;padding:2rem}h1{font-weight:600;margin:0 0 .5rem}p{opacity:.7;margin:0}</style></head><body><div><h1>Login cancelled</h1><p>You can close this tab.</p></div></body></html>";
const PAGE_BAD: &str = "<!doctype html><html><head><meta charset=utf-8><title>Error</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f14;color:#eceef5;font:16px/1.5 system-ui,Segoe UI,sans-serif}div{text-align:center;padding:2rem}h1{font-weight:600;margin:0 0 .5rem}p{opacity:.7;margin:0}</style></head><body><div><h1>Something went wrong</h1><p>Please close this tab and try signing in again from the launcher.</p></div></body></html>";
