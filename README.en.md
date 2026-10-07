# ForwardX Forwarding Management Panel

[简体中文](README.md) | [English](README.en.md)

ForwardX manages port forwarding, encrypted tunnels, forwarding chains, failover, user permissions, plans and traffic statistics across Linux servers through lightweight agents. The panel does not store host SSH keys.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/poouo/Forwardx?display_name=tag&sort=semver)](https://github.com/poouo/Forwardx/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

## Links

- [Documentation (Chinese)](https://poouo.github.io/Forwardx/)
- [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest)
- [Changelog (English)](CHANGELOG.en.md) · [更新日志（中文）](CHANGELOG.md)
- [Telegram Group](https://t.me/ForwardX_panel)
- [Android APK](https://github.com/poouo/Forwardx/releases/latest)
- [iOS IPA (self-signing required)](https://github.com/poouo/Forwardx/releases/latest)

## Documentation Map

Detailed guides are currently in Chinese; this README provides English installation instructions.

- [Deployment overview](docs/guide/deploy-panel.md) · [Docker](docs/guide/deploy-docker.md) · [Local deployment](docs/guide/deploy-local.md)
- [Databases](docs/guide/database.md) · [HTTPS and proxies](docs/guide/reverse-proxy.md) · [Environment variables](docs/guide/env-vars.md)
- [Initial setup](docs/guide/first-setup.md) · [Agent installation](docs/guide/agent.md) · [Forwarding rules](docs/guide/rules.md)
- [Notifications](docs/guide/notifications.md) · [AI assistant](docs/guide/ai-assistant.md) · [Google sign-in](docs/guide/google-login.md)
- [Paths and logs](docs/guide/paths-logs.md) · [Account recovery](docs/guide/account-recovery.md) · [Upgrades and backups](docs/guide/upgrade-backup.md) · [Panel migration](docs/guide/migration.md)
- [Full documentation index](docs/guide/index.md) · [Local development](docs/guide/development.md) · [Plugin development](docs/guide/plugins.md)

## Features

- TCP, UDP and TCP+UDP rules using `iptables`, `nftables`, `realm`, `socat`, `gost` or `nginx`.
- GOST, ForwardX V1/V2 and Nginx Stream tunnels with multiple hops, entry/exit groups and multiple exits.
- Forwarding chains with fixed entry, relay and exit paths.
- Multi-entry failover with forwarding groups and DDNS; Cloudflare, Huawei Cloud, Alibaba Cloud, Tencent Cloud DNSPod and Webhook support.
- Host status, rule traffic, cumulative traffic, latency charts, topology maps, connectivity tests and system logs.
- User permissions, traffic/port quotas, plans, balances, redemption codes, discount codes and payment integrations.
- Email reminders, mutually exclusive Telegram / Discord notification channels (Telegram by default), panel/agent upgrades and Android/iOS clients. See the [notification setup guide](docs/guide/notifications.md).
- Optional Google sign-in, AI-assisted queries and confirmed operations, and administrator-controlled per-rule quotas.
- Plugin stores, third-party stores and dynamic agent resource management APIs.

## Resource Model

Create resources in **Links**, then configure application ports and destination addresses in **Forwarding Rules**.

| Resource | Path | Typical Use |
| --- | --- | --- |
| Port forwarding | Client → single host → target | A host that can reach the target directly |
| Tunnel | Client → entry → tunnel → exit → target | Separate entry/exit hosts or encrypted transport |
| Forwarding chain | Client → entry → relays → exit → target | A fixed multi-hop path |
| Forwarding group | Multiple entries → same target | High availability and DDNS failover |

Entry groups reuse multiple entry hosts; exit groups reuse multiple tunnel exits. Rules reference saved resources, so multiple rules can share the same resource.

## Mobile Clients

### iOS Client

Download `forwardx-ios-v<version>-unsigned.ipa` from [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest). iOS/iPadOS 15 or later is supported. The IPA is unsigned and cannot be installed directly on ordinary devices. Users must provide their own certificates, signing tools and installation method. App Store/TestFlight distribution is not provided.

The GitHub Actions **iOS IPA** workflow supports manual builds and independent builds on version tags, attaching the package to the corresponding release. Manual build output is available as the `forwardx-ios-ipa` workflow artifact. Apple signing secrets are not required. See [Mobile Client documentation (Chinese)](docs/guide/mobile-app.md).

## Quick Deployment

The default panel port is `9810`. Run the following commands as `root`; otherwise replace `bash` with `sudo bash`.

### Docker Compose

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install --language en
```

Upgrade:

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade
```

Uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- uninstall
```

The installer selects and verifies a release image from `ghcr.io/poouo/forwardx` by default. Database configuration and SQLite data live in the volume mounted at `/data`, not a host-side `data/` directory by default. Upgrades preserve the volume and recognized core settings, but regenerate Compose and `.env`; back up and recheck custom environment variables, mounts and networking. Uninstalling deletes the data volume and deployment directory after confirmation.

### Local Deployment

Install:

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install --language en
```

Upgrade:

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

Uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- uninstall
```

Default directory: `/opt/forwardx-panel`; systemd service: `forwardx-panel.service`; data: `/opt/forwardx-panel/data`. The installer also supports OpenRC/SysV. Upgrades preserve data but regenerate `.env`, keeping recognized core settings; back up and recheck custom configuration.

### Administrator Password Recovery

Reset a forgotten administrator password from the Docker container or an SSH terminal. Password input is hidden in the interactive terminal and is not passed as a command-line argument:

```bash
# Docker (default container name)
docker exec -it forwardx-panel node dist/reset-admin-password.js

# Local systemd deployment
sudo bash /opt/forwardx-panel/scripts/install-panel-local.sh reset-admin
```

If multiple administrators exist, enter the username or email when prompted. Resetting revokes that administrator's existing sessions but preserves 2FA settings. Disabled accounts remain disabled unless you explicitly confirm and add `--enable-account`. The Docker container must be running. Back up the database first.

Replace `forwardx-panel` if using a custom container name. Alternatively, run `docker exec -it forwardx-panel sh`, then `node dist/reset-admin-password.js` inside the container.

### GitHub Download Acceleration

If GitHub is unreliable, specify a download accelerator for either installer. The URL format is `accelerator-base/original-GitHub-URL`. For the initial run, prefix the installer's Raw URL as well:

```bash
# Docker
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh" \
  | bash -s -- install --language en --github-accelerator "https://mirror.example.com"

# Local systemd
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh" \
  | bash -s -- install --language en --github-accelerator "https://mirror.example.com"
```

The installer saves the address in the deployment `.env` for future upgrades. Failed accelerated downloads fall back to direct GitHub access. In **Settings → System Information → GitHub Download Accelerator**, enable panel update acceleration to use this address for update checks, release metadata, package checks, rollback and upgrade commands.

This does not proxy `ghcr.io` image pulls. Configure `FORWARDX_IMAGE` or `FORWARDX_IMAGE_REPO` separately. See [Deployment](https://poouo.github.io/Forwardx/guide/deploy-panel) and [Upgrades & Backups](https://poouo.github.io/Forwardx/guide/upgrade-backup) (Chinese).

## Getting Started

The installation commands above pass `--language en`, so the initial setup wizard defaults to English even in a Chinese-language browser. The Chinese README passes `--language zh-CN`. Switch between **简体中文 / English** at the top right of the wizard without losing form input; manual selections are saved in your browser and take priority. Both installers accept `--language auto` to follow browser/IP detection instead, or `FORWARDX_SETUP_LANGUAGE=en` / `zh-CN` as an environment variable. Upgrades preserve the installation language; after setup completes, automatic mode returns to normal browser/IP detection.

1. Open `http://SERVER_IP:9810`.
2. Review any database settings prefilled by the installer, select SQLite, MySQL or PostgreSQL, and complete initialization.
3. Create the first administrator or log in using an administrator from the existing database.
4. Create a token in **Hosts → Token Management**.
5. Install Agent on managed hosts and verify their online status in **Hosts**.
6. Create a port forward, tunnel, forwarding chain or forwarding group in **Links**.
7. Select a resource in **Forwarding Rules** and configure the entry port, protocol and target address.

The panel generates the Agent command using its current URL and token:

```bash
curl -fsSL http://YOUR_PANEL_ADDRESS:9810/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

Upgrade or uninstall Agent:

```bash
curl -fsSL http://YOUR_PANEL_ADDRESS:9810/api/agent/install.sh | bash -s -- upgrade YOUR_AGENT_TOKEN
curl -fsSL http://YOUR_PANEL_ADDRESS:9810/api/agent/install.sh | bash -s -- uninstall
```

## Tunnel Types

| Type | Description |
| --- | --- |
| GOST | TLS, WSS, TCP, MTLS, MWSS, MTCP and other GOST modes |
| ForwardX V1 | Original FXP encrypted transport, compatible with existing tunnels |
| ForwardX V2 | Agent's built-in userspace WireGuard outer UDP transport with FXP inside |
| Nginx Stream | Dedicated `forwardx-nginx` runtime for layer-4 TCP/UDP forwarding; optional TLS for TCP |

ForwardX V2 does not require the system `wg` command, create a system WireGuard interface or modify host routing. Allow the configured WireGuard UDP port in firewalls and security groups.

The Nginx runtime listens on ports specified by rules or tunnels, not a fixed port 80. If another Nginx service reports a port-80 conflict, inspect that service's own site configuration and listening processes.

## mimic UDP Obfuscation

mimic is used only when explicitly enabled for a ForwardX tunnel. V1 applies it to FXP UDP; V2 applies it to the outer userspace WireGuard UDP transport. TCP retains its original channel. Hosts along the path need `mimic`/`mimic-dkms`, compatible Linux kernels and XDP/TC support.

The Agent installer asks whether to install mimic; the default is `n`. You can also install it manually:

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-mimic.sh | sudo bash
```

By default, the installer uses `wg-mimic-fabric v1.4.9` to install/upgrade to `mimic v0.7.1`, skipping reinstallation when the target version is already present. Override `FORWARDX_MIMIC_VERSION` and `WMF_REF` to select specific runtime and installer versions.

Agent reports command/module availability. Before enabling UDP obfuscation, the panel checks every host in the path. Missing dependencies, offline agents or missing environment reports prevent enabling it and show manual installation instructions. Agent does not install mimic automatically.

mimic changes the appearance of UDP packets on physical interfaces. It does not perform port forwarding or improve underlying Internet packet loss or jitter.

## Databases

ForwardX supports SQLite, MySQL and PostgreSQL:

- SQLite suits single-instance deployments: `/data/forwardx.db` inside Docker or `/opt/forwardx-panel/data/forwardx.db` with the local installer.
- MySQL and PostgreSQL suit environments with existing database operations.
- In-place upgrades preserve database configuration and business data.
- Create consistent backups using the [backup guide](docs/guide/upgrade-backup.md); do not copy only the main SQLite file while it is being written.

See [Environment Variables (Chinese)](https://poouo.github.io/Forwardx/guide/env-vars) for database URLs, reverse proxies and upgrades. The panel automatically manages MySQL/PostgreSQL connection pools based on host count. Common variables (paths below are container/application defaults, overridden by the local installer; additional Docker `.env` variables must also be mapped into the container by Compose):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `9810` | Panel port |
| `DATABASE_CONFIG_PATH` | `/data/database.json` | Database connection configuration file |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite data file |
| `DATABASE_TYPE` / `DB_TYPE` | Empty | Force `sqlite`, `mysql` or `postgresql` |
| `JWT_SECRET` | Automatically generated | Login signing secret; keep it fixed in production |
| `TELEGRAM_BOT_TOKEN` | Empty | Telegram bot token |
| `DISCORD_BOT_TOKEN` | Empty | Discord bot token; select and enable Discord in notification settings |
| `FORWARDX_IMAGE` | `ghcr.io/poouo/forwardx:latest` | Docker image |

## Interface Language

Choose Simplified Chinese or English from the account menu at the bottom left. Language selection is also available on login and initial setup pages.

Automatic mode first matches browser languages. If none matches, it uses an existing IP country cache entry or a country hint from a configured trusted proxy. Without reliable hints, it defaults to Chinese. No additional third-party visitor-IP lookup is performed.

A manual choice takes priority and is saved in the current browser's localStorage, with sessionStorage as a fallback when local storage is unavailable. Select Automatic to restore detection. Switching reloads the page; save forms first. Custom host names, announcements, plugin content and raw diagnostic output are not automatically translated.

## Local Development

```bash
pnpm install
pnpm dev:panel
```

`dev:panel` serves real pages at `http://127.0.0.1:5173` using isolated SQLite data in the repository's `.dev` directory and automatic developer-admin sign-in. **Never expose this mode publicly.** `pnpm dev` starts the backend directly and is not the isolated launcher. See [Local development](docs/guide/development.md).

Checks and builds:

```bash
pnpm exec tsc --noEmit
pnpm test:server
pnpm build
pnpm docs:build
pnpm check:versions
```

## Security Recommendations

- Use strong passwords and configure a stable, random `JWT_SECRET`.
- Disable registration in Settings when not needed.
- Use dedicated, least-privilege MySQL/PostgreSQL accounts.
- Restrict panel access with an HTTPS reverse proxy or firewall.
- Protect Agent/DDNS tokens and revoke them immediately if exposed.
- Regularly back up the database and panel data directory.

## Support the Author

USDT (TRON): `TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana: `8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain: `0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

USDT (Polygon): `0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

ForwardX Agent includes the third-party userspace WireGuard implementation under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Star History

[![Stargazers over time](https://starchart.cc/poouo/Forwardx.svg)](https://starchart.cc/poouo/Forwardx)
