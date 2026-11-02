# Game Launcher (White Phantom Games)

A small, open-source game launcher for creators who distribute builds to
Patreon / SubscribeStar supporters — the Steam-style experience (sign in,
install, play, delta updates, achievements) without a platform in the middle.

**Why it's public:** the launcher runs on players' PCs and downloads code, so
you should be able to see exactly what it does. Its security doesn't depend
on secrecy: every catalog and manifest is Ed25519-signed with a key that only
exists on the developer's machine, launcher updates are minisign-signed via
Tauri's updater, and the launcher refuses anything that doesn't verify. The
public keys are in this repo (`src-tauri/signing.pub`, `plugins.updater.pubkey`
in `src-tauri/tauri.conf.json`) so anyone can check a release.

**What's deliberately not here:** game files and artwork (`cdn/`, lives in
R2), the tier/tester/access-code mapping (`tools/tiers.json` — see
`tools/tiers.example.json`), and all secrets (`.env`, Cloudflare secrets,
private keys). A fresh clone builds and runs against an empty library; to run
your own instance, follow the sections below.

Stack: [Tauri 2](https://tauri.app) (Rust + plain HTML/CSS/JS), a Cloudflare
Worker, Cloudflare R2. MIT licensed. Security contact: see
`/.well-known/security.txt` on the API host.

---

A Steam/Itch-style launcher for your Patreon & SubscribeStar builds:
sign in with the player's existing Patreon/SubscribeStar account, download
games from cheap object storage (Cloudflare R2), and only ever download the
files that changed between versions.

```
WPG-Launcher/
├── launcher.config.json  ← the only file you edit to make it yours
├── src/              Launcher UI (HTML/CSS/JS) — what players see
├── src-tauri/        Rust backend: login, downloads, hashing, launching games
├── tools/
│   ├── publish.mjs   Turns a Ren'Py build folder into CDN files (manifest + objects)
│   └── serve.mjs     Local stand-in for Cloudflare (CDN + mock Patreon login)
├── cdn/              What gets uploaded to R2: catalog.json + games/<id>/…
└── sample-game/      Two versions of a fake game for testing updates
```

## 0. Make it yours — `launcher.config.json`

Everything studio-specific is in one file at the repo root: studio name,
website, contact e-mail, launcher product name and app identifier, the
`Games\<folder>` install folder, the access-code prefix, the private-key
folder, API domain, Worker name, R2 bucket, token lifetime, rate limit, RSS
feed, news page and Patreon/SubscribeStar links. Edit it, then:

```powershell
npm run configure
```

That regenerates `src/config.js` (UI), `worker/wrangler.jsonc` (Cloudflare) and
stamps `src-tauri/tauri.conf.json` (product name, identifier, updater URL —
the updater public key is left alone). `dev`, `build`, `serve`, `test` and
`worker:deploy` run it automatically, so you can't forget. The Rust code and
the Worker include `launcher.config.json` directly. Nothing in `src/`,
`src-tauri/`, `worker/` or `tools/` needs editing to rebrand; `npm test`
fails if the generated files are stale.

Things that are *not* in the config, on purpose: secrets (`.env`, Worker
secrets, private keys), the tier/code mapping (`tools/tiers.json`), game
content (`cdn/catalog.json`), and the two brand colours in `src/styles.css`
(`--patreon`, `--substar`) which are the platforms', not yours. Your logo is
`src/logo.png` and the installer icons are `src-tauri/icons/` (`npm run tauri
icon your.png` regenerates them).

The rest of this README uses White Phantom Games' real values
(`api.whitephantomgames.co.uk`, bucket `wpg-cdn`, key folder `.wpg`, codes
`WPG-…`) as worked examples — read them as "whatever you put in
`launcher.config.json`".

## 1. One-time setup (Windows)

Install the toolchain (PowerShell):

```powershell
winget install Rustlang.Rustup
winget install OpenJS.NodeJS.LTS
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Open a **new** PowerShell afterwards, then in this folder:

```powershell
rustup default stable-msvc
npm install
```

## 2. Run it locally

You need two terminals in this folder.

**Terminal A — the fake Cloudflare** (serves files + mock login):

```powershell
npm run demo:v1     # publish sample game v0.1.0 into cdn/
npm run serve       # http://127.0.0.1:8787
```

**Terminal B — the launcher:**

```powershell
npm run dev         # first build takes a few minutes; later runs are seconds
```

Then in the launcher:

1. Click **Sign in → Continue with Patreon**. Your browser opens a *mock*
   Patreon page — pick a tier and click **Allow**. The launcher now shows
   your name and tier top-right.
2. Click **Install** on Midnight Manor. Watch it download 24 files / ~10 MB.
3. Click **Play** — the sample "game" is a .bat that prints the script.
4. Back in Terminal A: `npm run demo:v2` to publish v0.1.1. Click the game in
   the launcher's sidebar (or restart it) — the button becomes **Update**, and
   it downloads **only the 3 changed files** and deletes 1 removed file.
5. Try signing in as **Follower (free)**: the game locks, because
   `requiredTier` in `cdn/catalog.json` is 1.

The **⋯** menu next to Play has *Open install folder*, *Verify files*
(re-hashes everything; damaged files get re-downloaded on the next Update)
and *Uninstall*.

Games install to `%APPDATA%\uk.co.whitephantomgames.launcher\games\<id>`.

### UI-only preview (no Rust build)

With `npm run serve` running, open http://127.0.0.1:8787/ in a browser.
Downloads and login are faked in-page, but it's handy for tweaking the look.

## 3. Publishing a real build

```powershell
node tools/publish.mjs <game-id> <version> "<path to Ren'Py pc build>" --exe YourGame.exe --notes "What changed"
```

For example:

```powershell
node tools/publish.mjs midnight-manor 0.5.0 "D:\renpy\MidnightManor-0.5.0-pc" --exe MidnightManor.exe --notes "Chapter 5"
```

This hashes every file, copies only *new* content into
`cdn/games/<id>/objects/<sha256>`, writes the version manifest and updates
`catalog.json`. Edit `catalog.json` by hand for titles, descriptions, tiers
and artwork (`games/<id>/cover.png` 600×800, `hero.jpg` 1600×600).

### News panels

Each game's detail page has three text areas, all driven by data, no code:

| Panel | Where it comes from | Scope |
|---|---|---|
| **Game news** | `games[].news` in `cdn/catalog.json` — max 2 shown, newest first | per game |
| **About** + *Version history* | `games[].description` and the `--notes` you pass to `publish.mjs` | per game |
| **What's new** | The website RSS feed (`newsFeed` in `catalog.json`, default `https://whitephantomgames.co.uk/rss.xml`) | same for every game |

A game-news item looks like this — `text` supports Markdown-style links,
which open in the player's browser:

```json
"news": [
  {
    "title": "Version 1.7 released",
    "text": "A new full day of the game, with ten new scenes. [Full changelog](https://www.whitephantomgames.co.uk/v17-released)",
    "date": "2026-11-01"
  }
]
```

Keep it to two lines; anything longer belongs in a website post, which then
shows up in What's new automatically. When offline, point `newsFeed` at
`http://127.0.0.1:8787/rss.xml` (a sample feed in `cdn/rss.xml`).

## 3½. Real Patreon login (local)

The mock login is replaced by real Patreon OAuth as soon as the server has
your API client's credentials.

1. Create a client at https://www.patreon.com/portal/registration/register-clients
   with Redirect URIs:
   `https://api.whitephantomgames.co.uk/auth/patreon/callback http://localhost:8787/auth/patreon/callback`
2. Copy `.env.example` to `.env` and paste in the **Client ID** and
   **Client Secret**. (`.env` is git-ignored — never share the secret.)
3. Map your tiers once, using the **Creator's Access Token** from the same page
   (on a fresh clone, first `copy tools\tiers.example.json tools\tiers.json`):
   ```powershell
   npm run patreon:tiers -- <creator access token>
   ```
   This writes `tools/tiers.json` (Patreon tier id → launcher level 1, 2, 3 …,
   cheapest first). Edit the `level`/`name` values if two tiers should unlock
   the same content. Games in `catalog.json` use `requiredTier` = one of those levels.
4. Restart `npm run serve`. It now prints `Patreon : REAL login …`.
   In the launcher, **Sign in → Continue with Patreon** opens the real
   Patreon consent page; after Allow you're back in the launcher with your
   real name, avatar and tier.

If a tier doesn't map, set `PATREON_DEBUG=1` in `.env` to print Patreon's
raw membership response on each login. SubscribeStar still uses the mock
page until their API access is granted.

`tools/patreon.mjs` is written against the standard `fetch` API so the same
file runs unchanged inside the Cloudflare Worker.

## 4. Going to production (Cloudflare)

Production = the `worker/` folder deployed as a Cloudflare Worker at
`api.whitephantomgames.co.uk`, serving files from an R2 bucket. It speaks the
same protocol as `tools/serve.mjs`, so the launcher just needs its server URL
changed. All of this is in the same Cloudflare account as the website.

### One-time setup (about 15 minutes)

In PowerShell, in the `WPG-Launcher` folder:

```powershell
cd worker
npm install
npx wrangler login                                  # opens a browser; approve
npx wrangler r2 bucket create wpg-cdn
npx wrangler secret put SESSION_SECRET              # paste any long random string (40+ chars)
npx wrangler secret put PATREON_CLIENT_ID           # same values as your .env
npx wrangler secret put PATREON_CLIENT_SECRET
npx wrangler secret put SUBSCRIBESTAR_CLIENT_ID
npx wrangler secret put SUBSCRIBESTAR_CLIENT_SECRET
npx wrangler deploy                                 # creates api.whitephantomgames.co.uk automatically
cd ..
npm run sync                                        # upload cdn/ to the bucket
```

Check: https://api.whitephantomgames.co.uk/health should say `wpg-launcher-api ok`
and `/catalog.json` should show your games.

Then in the launcher: **Settings → Content server** = `https://api.whitephantomgames.co.uk`.
Sign in with Patreon or SubscribeStar — both are now real.

### Every update afterwards

```powershell
node tools/publish.mjs <game-id> <version> "<build folder>" --exe Game.exe --notes "…"
npm run sync
```

`sync` only uploads objects it hasn't uploaded before (tracked in
`cdn/.r2-uploaded.json`), plus the small manifest/catalog files, so a typical
update is a couple of minutes. Edit `cdn/catalog.json` (news, descriptions,
tiers) and run `npm run sync` to push text changes with no new build.

### Faster uploads (recommended for the real game)

`npm run sync` uploads one file at a time through wrangler, which is slow for
a full Ren'Py build (thousands of files). Install rclone once and the same
command uses it automatically, uploading 16 files in parallel:

```powershell
winget install Rclone.Rclone
```

Then create an R2 API token: Cloudflare dashboard → **R2 Object Storage** →
**Manage R2 API Tokens** → Create → permission *Object Read & Write*, bucket
`wpg-cdn`. It shows an **Access Key ID**, **Secret Access Key** and an
endpoint URL like `https://<account-id>.r2.cloudflarestorage.com`. Then, in a
new PowerShell window:

```powershell
rclone config create r2 s3 provider=Cloudflare access_key_id=<ACCESS KEY> secret_access_key=<SECRET> endpoint=https://<account-id>.r2.cloudflarestorage.com acl=private no_check_bucket=true
rclone ls r2:wpg-cdn    # should list the files already in the bucket
```

From then on `npm run sync` goes through rclone (`npm run sync -- --wrangler`
forces the old path). Objects are content-addressed, so files already in the
bucket are skipped without re-uploading.

### How updates stay small (chunking)

Files of 8 MB or more — in practice Ren'Py's `.rpa` archives — are split by
`publish.mjs` into ~4 MB pieces using content-defined boundaries
(`tools/cdc.mjs`, mirrored in `src-tauri/src/cdc.rs`). Boundaries depend on
the bytes, not on offsets, so adding a scene to a 5 GB `images.rpa` changes
only the pieces around the insertion. The launcher scans the player's
existing archive, keeps the pieces that still match, downloads the rest in
parallel, rebuilds the file next to the old one and verifies the whole hash
before swapping it in. An interrupted update resumes from the pieces already
on disk.

Practical notes: rebuilding needs free disk space equal to the largest
archive (the old and new copies exist briefly side by side), and the publish
step reads every byte of the build once, so a 6 GB build takes a few minutes.

### Achievements (Steam-style x / 60)

Two pieces, no accounts involved:

1. **In the game**: copy `game-integration/launcher_sync.rpy` into the game's
   `game/` folder. It wraps `achievement.grant` and writes
   `launcher_achievements.json` next to the save files (`%APPDATA%\RenPy\<save dir>\`)
   whenever an achievement is granted, at start, after a load and on quit.
   Ships with the next game build; existing achievements sync the first time
   a player launches that build.
2. **On the CDN**: `node tools/achievements-export.mjs <game-id> "<path to game/>"`
   reads the names (`define achN`), hints, secret list and page order from the
   game source, copies the 100×100 icons to `cdn/games/<id>/ach/`, writes
   `achievements.json` and sets `achievements` + `saveDirectory` on the game in
   `catalog.json`. Then `npm run sync`. Re-run when achievements change.

The launcher shows a trophy pill (`12 / 60`) next to the Play button; clicking
it opens the grid (unlocked first; secret ones stay hidden until earned). It
refreshes when the game process exits.

### Publishing a "for markets" build

Point `publish.mjs` at Ren'Py's **for markets** folder (Windows + Mac + Linux
in one). Each file is tagged with its platform from Ren'Py's layout
(`Game.exe` and `lib/py3-windows-*` → Windows, `Game.app` and `lib/py3-mac-*`
→ Mac, `Game.sh` and `lib/py3-linux-*` → Linux, everything else shared) and
the launcher downloads only its own platform's files. Storage is one copy of
the game; the publish output shows exactly how much a Windows player fetches.
Note `publish.mjs` copies the build into `cdn/` (content-addressed), so you
need free disk space equal to the build size the first time.

### Access codes (testers, friends)

```powershell
npm run code -- new "Dev friend" 3     # prints WPG-XXXX-XXXX-XXXX; level 3 = Day One access
npm run code -- list
npm run code -- revoke WPG-XXXX-XXXX-XXXX
npm run worker:deploy                  # after any change
```

Codes live in `tools/tiers.json` → `codes`. In the launcher: Sign in →
**Have a code?** → paste. A revoked code stops working at the next launcher
start (or within 7 days); installed games keep playing as always.

### Changing tier rules

`tools/tiers.json` is bundled into the Worker, so after editing it (new tier,
an override for a tester) run `npm run worker:deploy`.

### Release windows (Day 1 / Day 4 / Day 8 access)

Patreon-style staggered releases are built in. `tools/tiers.json` → `levels`
defines each access level once, with how long after a Day-1 release it may
download a new version:

```json
"levels": {
  "0": { "name": "No game access" },
  "1": { "name": "Supporter",   "delayDays": 7 },
  "2": { "name": "Law Student", "delayDays": 3 },
  "3": { "name": "Day One",     "delayDays": 0 },
  "4": { "name": "Creator",     "delayDays": 0 }
}
```

Every Patreon tier id, SubscribeStar price rule and access code maps to one
of those levels (`node tools/patreon-tiers.mjs <creator token>` lists your
tiers, grandfathered ones included, and keeps any levels you've already set).
A game's `requiredTier` is the floor — below it nothing downloads.

`publish.mjs` stamps each version with `releasedAt` (now, or
`--release-date 2026-11-08T18:00Z` to schedule). The Worker refuses a
manifest until `releasedAt + delayDays` for the player's level (403 with an
`X-Available-At` header); the launcher shows the newest version the player
*can* get as "Latest", and a note like "v0.23.0 is out for Day 1 tiers — on
Supporter (Day 8 release) it unlocks for you on Sun 15 Nov, 18:00". The
changelog marks not-yet-unlocked versions too. Older versions stay
downloadable, installed games always play.

Every locked state carries an **Upgrade** button (or **Re-subscribe** for a
lapsed patron) that opens the player's own provider — Patreon members go to
Patreon, SubscribeStar members to SubscribeStar; code users see no button.
The destinations and the tier named in the note come from `catalog.json`:

```json
"support": {
  "patreon": "https://www.patreon.com/whitephantomgames/membership",
  "subscribestar": "https://subscribestar.art/white-phantom-games",
  "dayOneTierName": "Premium Supporter (£10)"
}
```

### Useful

- `npm run worker:tail` — live log of logins and errors from the deployed Worker.
- `npm run worker:dev` — run the Worker locally on http://localhost:8788 with a
  local bucket (`node tools/sync-r2.mjs --local` to fill it). Put secrets in
  `worker/.dev.vars` for that.
- Tokens are encrypted and self-contained (no database). The launcher
  re-checks the player's tier with Patreon/SubscribeStar at startup and before
  every install, and tokens expire after `TOKEN_DAYS` (30). Changing
  `SESSION_SECRET` signs everyone out.

### Signing — what protects players

Two independent signatures, neither tied to a real-world identity:

1. **Content signing (Ed25519).** `npm run keygen` creates a private key at
   `%USERPROFILE%\.wpg\manifest-signing.key` and writes the public key to
   `src-tauri/signing.pub`, which is compiled into the launcher. `publish.mjs`
   and `npm run sync` sign `catalog.json` and every `manifest.json`
   (`*.sig` beside them). The launcher refuses anything that doesn't verify,
   so even someone inside the Cloudflare account or the bucket cannot ship
   files to players. **Back the private key up offline**; losing it means
   shipping a new launcher before any new game version can be installed.
2. **Launcher update signing (Tauri/minisign).** `npm run tauri signer generate -- -w %USERPROFILE%\.tauri\wpg-launcher.key`
   creates a password-protected key; paste the printed public key into
   `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Launcher updates
   are refused unless signed with it.

Neither is a Windows Authenticode certificate, so SmartScreen still warns on
first install of the launcher ("More info → Run anyway"). That's the one
signature that needs a verified legal identity; it can be added later as a
build setting without changing anything above.

### Launcher releases (self-update)

```powershell
# once: generate the updater key (choose a password; keep both safe)
npm run tauri signer generate -- -w $env:USERPROFILE\.tauri\wpg-launcher.key
#   → paste the public key into src-tauri/tauri.conf.json plugins.updater.pubkey

# each release:
#   1. bump "version" in src-tauri/tauri.conf.json
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $env:USERPROFILE\.tauri\wpg-launcher.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<your password>"
npm run build
node tools/release-launcher.mjs --notes "What changed"
npm run sync
```

Running launchers check `/launcher/latest.json` at startup, show a banner,
and "Restart to update" installs the signed update passively. The website can
link to `https://api.whitephantomgames.co.uk/launcher/download`, which always
redirects to the newest installer for the visitor's platform (Mac browsers get
the `.dmg`; add `?platform=windows` or `?platform=mac` to force one).

### Mac build (universal: Apple Silicon + Intel)

Tauri can't cross-compile for macOS, so the Mac launcher is built on the Mac
and its three output files are copied to the PC, where the normal release
steps publish them next to the Windows build. The Windows steps above don't
change.

**One-time setup on the Mac** (Terminal):

```bash
xcode-select --install                                   # Apple's compiler tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust; then open a new Terminal
rustup target add aarch64-apple-darwin x86_64-apple-darwin
# Node.js: install the LTS from https://nodejs.org (or `brew install node`)
git clone https://github.com/WP-Games/wpg-launcher.git && cd wpg-launcher
npm install
```

Copy `wpg-launcher.key` from the PC (`%USERPROFILE%\.tauri\`) to the Mac at
`~/.tauri/wpg-launcher.key` — AirDrop is fine; never put it in the repo or chat.
The repo's `tauri.conf.json` already carries the matching public key.

**Each release on the Mac**, after the PC has been pushed with the new version
number (`git pull` first so the Mac builds the same code):

```bash
cd ~/wpg-launcher && git pull
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/wpg-launcher.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<your password>"
npm run build -- --target universal-apple-darwin --bundles app,dmg
open src-tauri/target/universal-apple-darwin/release/bundle/
```

That opens a folder with two subfolders. Copy these three files to the PC into
`incoming\mac\` in the launcher project (the folder is git-ignored):

- `dmg/White Phantom Games_<version>_universal.dmg` — what players download
- `macos/White Phantom Games.app.tar.gz` — what the self-updater downloads
- `macos/White Phantom Games.app.tar.gz.sig` — its signature

Then on the PC run the usual `npm run release -- --notes "…"` and `npm run sync`.
The release script publishes both platforms and merges them into one
`latest.json`, so the order (Windows first or Mac first) doesn't matter as long
as the version number matches.

**Unsigned app, first launch.** There's no Apple developer account, so macOS
will say the app can't be verified. The player opens the `.dmg`, drags the app
to Applications, double-clicks it once (macOS refuses), then goes to
System Settings → Privacy & Security, scrolls down and clicks **Open Anyway**.
That's a one-off; updates the launcher installs itself are not quarantined.
Put that sentence on the website download page.

**Testing on your Mac:** the first run shows the 18+ / EULA screen, then sign
in with Patreon; the game downloads to `~/Games/White Phantom Games/<title>`
and Play launches the `.app`. If Play says "Couldn't start game: permission
denied", that's the executable-bit fix in `updater.rs` not having run — tell
Claude.

### Linux build (AppImage, x86_64)

Same idea as the Mac: build on a Linux desktop (WP's Linux Mint machine), copy
the two output files to the PC, release from the PC as usual.

**One-time setup on the Mint box** (Terminal, Ctrl+Alt+T):

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev git
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh      # Enter for the default; then open a new terminal
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -   # Node 22 (Mint's own Node is too old)
sudo apt install -y nodejs
cd ~ && git clone https://github.com/WP-Games/wpg-launcher.git && cd wpg-launcher && npm install
```

Copy `wpg-launcher.key` (from the PC's `%USERPROFILE%\.tauri\`) and
`wpg-launcher-cdn-snapshot.zip` over on the USB stick, then:

```bash
mkdir -p ~/.tauri && cp /media/$USER/*/wpg-launcher.key ~/.tauri/
cd ~/wpg-launcher && unzip -o /media/$USER/*/wpg-launcher-cdn-snapshot.zip
```

**Each release on the Mint box** (after the PC has pushed the new version):

```bash
cd ~/wpg-launcher && git pull
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/wpg-launcher.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<your password>"
npm run build -- --bundles appimage
xdg-open src-tauri/target/release/bundle/appimage/
```

Copy these two files to the PC into `incoming\linux\`:

- `white-phantom-games_<version>_amd64.AppImage` — what players download
- `white-phantom-games_<version>_amd64.AppImage.sig` — updater signature

Then on the PC: `npm run release -- --notes "…"` and `npm run sync`. The
release script merges Windows, Mac and Linux into one `latest.json`.

**Player notes for the download page:** right-click the AppImage → Properties
→ Permissions → "Allow executing file as program" (or `chmod +x`), then
double-click. Needs WebKitGTK, which Ubuntu/Mint/Fedora/Steam Deck desktop
already have; on a minimal distro: `sudo apt install libwebkit2gtk-4.1-0`.
Self-updates replace the AppImage in place.

**Testing on the Mint box:** run the AppImage from the build folder; first run
shows the 18+ screen; sign in, install the game to `~/Games/White Phantom
Games/<title>`, Play runs the game's `.sh`.

### Cloudflare hardening (one-time, dashboard)

- **Login routes are rate limited inside the Worker** (30 requests / 10 s per IP,
  `ratelimits` binding in `worker/wrangler.jsonc`) — no dashboard rule needed,
  so the free plan's single WAF rate-limit rule stays available for the website.
- **Two-factor authentication** on Cloudflare, Patreon, SubscribeStar and
  wherever this code is hosted. The PC holding `.env`, the rclone config and
  the two signing keys is the most sensitive machine you own: full-disk
  encryption on.
- Tokens last `TOKEN_DAYS` (7). Changing `SESSION_SECRET` signs everyone out.
- The launcher asks Patreon only for name + avatar (no email); SubscribeStar
  for name/avatar/subscription. Nothing is stored server-side.
- `https://api.whitephantomgames.co.uk/.well-known/security.txt` gives a
  contact for security reports.

### Still to do

| Piece | Status |
|---|---|
| Windows Authenticode (SmartScreen) | optional; needs a verified legal identity |
| Website download page | link to `/launcher/download` |
| Local SubscribeStar testing | only via production (their integration allows one redirect URL) |

### Protocol

```
GET  /catalog.json                                        public
GET  /games/<id>/cover.png | hero.jpg                     public
GET  /auth/<provider>/start?redirect_uri=&state=          browser → provider login → /auth/<provider>/callback →
     http://127.0.0.1:<port>/callback?token=<t>&state=<s>
GET  /auth/me                      Authorization: Bearer  → {provider, displayName, avatar, tier, tierName, token?}
GET  /games/<id>/versions/<v>/manifest.json   Bearer      401 if anon, 403 if tier < requiredTier
GET  /games/<id>/objects/<sha256>             Bearer      file bytes (Range supported)
```

## Tests

```powershell
npm run demo:v1; npm run demo:v2
cd src-tauri; cargo test
```

Spins up `serve.mjs`, installs v0.1.0 into a temp folder, verifies every
hash, updates to v0.1.1 and asserts exactly 3 files download and 1 is
deleted, and checks that anonymous / low-tier requests are refused.
