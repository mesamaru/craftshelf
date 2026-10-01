<p align="center"><img src="static/icon.svg" width="112" alt="CraftShelf"></p>

<h1 align="center">CraftShelf</h1>

<p align="center">
A self-hosted web panel to organize and store your Minecraft plugins, mods, data packs, resource packs, shaders and modpacks —<br>
drag &amp; drop to add, check for updates, and push them to your servers.
</p>

<p align="center"><a href="README.md">日本語</a> · <a href="CHANGELOG.md">Changelog (Japanese)</a></p>

---

## Features

- 📦 **Drop to organize** — drop .jar / .zip files or whole folders; name, version, supported Minecraft versions and server software are detected automatically
- 🔗 **Linked to distribution sites** — matches your files with Modrinth, SpigotMC and CurseForge, checks for updates on a schedule and saves new versions in one click
- 🧩 **Dependency checks** — finds missing required plugins/mods and lets you add them from search
- 🖥️ **Pterodactyl integration** — one-click sync to your servers, side-by-side server comparison, rollback to the state before a sync, scheduled syncs
- 🗂️ **Flexible storage** — local folder, SMB (Unraid, TrueNAS, Synology, Windows shares) or WebDAV (Nextcloud etc.), with a live storage status view (connection, latency, capacity)
- 👥 **Multi-user** — viewer / editor / admin roles, two-factor authentication, API tokens and an audit log
- 🌐 **English / Japanese UI**, themes and custom backgrounds, mobile friendly

Files are stored in a human-readable layout (`library/plugins/<Name>/<file>.jar`), so they stay usable even without CraftShelf.

## Installation

| Use case | Recommended |
| --- | --- |
| On your own PC (Windows / Mac) | [Installer](#installer-windows--macos--linux) |
| Always-on Ubuntu / Debian server | [Install script](#ubuntu--debian-server) |
| NAS or Docker host | [Docker](#docker) |

### Installer (Windows / macOS / Linux)

Download the file for your OS from [Releases](https://github.com/mesamaru/craftshelf/releases/latest).

- **Windows 10 / 11** — run `CraftShelf-Setup-<version>.exe` (no admin rights needed). CraftShelf lives in the system tray and opens in your browser
- **macOS** — open `CraftShelf-<version>-macos-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) and drag CraftShelf to Applications
- **Linux desktop** — extract `CraftShelf-<version>-linux-x64.tar.gz` and run `CraftShelf`

> The builds are not code-signed, so you may see an "unknown publisher" warning the first time. On Windows choose "More info → Run anyway"; on macOS right-click CraftShelf and choose "Open".

Data is stored in `%LOCALAPPDATA%\CraftShelf` (Windows), `~/Library/Application Support/CraftShelf` (macOS) or `~/.local/share/craftshelf` (Linux). By default the panel is only reachable from the same PC (`http://127.0.0.1:8765`). To allow other devices on your LAN, put this `launcher.json` in the data folder and restart:

```json
{ "host": "0.0.0.0", "port": 8765 }
```

Updates are one click: ⚙ → "Panel update" → "Download and install". The panel downloads the build for your OS from GitHub, verifies its SHA-256, installs it and restarts — your data is kept.

### Ubuntu / Debian server

```bash
curl -fsSL https://raw.githubusercontent.com/mesamaru/craftshelf/main/install.sh | sudo bash
```

This installs CraftShelf to `/opt/craftshelf`, stores data in `/var/lib/craftshelf` and registers a systemd service. Open `http://<server-ip>:8765`. Run the same command again to update (the panel's own "Panel update" also works). Set `CRAFTSHELF_PORT=9000` to change the port. Uninstall with `... | sudo bash -s -- --uninstall` (data is kept).

### Docker

```bash
git clone https://github.com/mesamaru/craftshelf.git
cd craftshelf
docker compose up -d --build
```

Edit `docker-compose.yml` first if needed: the left side of `volumes` is where files are stored (default `./data`), `ports` sets the port (default `8765`) and `TZ` sets the time zone. Then open `http://<server-ip>:8765` and create the admin account.

## First steps

1. Create the admin account on the setup screen
2. Drop your plugin/mod files onto the page
3. Settings (⚙) → switch **Language / 言語** to English if the UI is in Japanese
4. Optional: link Pterodactyl (Client API key `ptlc_…`), add a CurseForge API key, or add SMB / WebDAV storage

## Updates

The panel checks GitHub for new versions. Docker and script installs can update from ⚙ → "Panel update" with one click (auto-update is off by default); Docker containers also pull the latest code on start unless `AUTO_UPDATE=false`. Installer builds update the same way (the build for your OS is downloaded from GitHub Releases and verified).

## Security

CraftShelf is designed for use on a LAN. If you expose it to the internet, put it behind an HTTPS reverse proxy and enable two-factor authentication (a VPN such as Tailscale is safer). Please report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `DATA_DIR` | `./data` (`/data` in Docker) | Location of the "Local" storage |
| `CONFIG_DIR` (or `DB_DIR`) | same as `DATA_DIR` | Where `index.db`, the encryption key and settings are stored |
| `PORT` / `HOST` | `8765` / `127.0.0.1` | Only when running `python app.py` or the launcher |
| `AUTH_USER` / `AUTH_PASS` | — | Creates this admin automatically when no user exists |
| `GITHUB_REPO` | `mesamaru/craftshelf` | Where updates are fetched from (`owner/repo`) |
| `GITHUB_BRANCH` | `main` | Branch to update from |
| `AUTO_UPDATE` | `true` | Docker only: `false` disables pulling the latest code on start |

## License

Released under the [MIT License](LICENSE).

Minecraft is a trademark of Mojang Studios. CraftShelf is an unofficial tool and is not affiliated with Mojang Studios, Microsoft or any of the distribution sites.
