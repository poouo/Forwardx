# ForwardX Forwarding Management Panel

[简体中文](README.md) | [English](README.en.md)

Manage port forwarding, encrypted tunnels, failover, users and plans across Linux servers through lightweight agents. The panel manages configuration; forwarding runtimes on managed hosts carry business traffic. The panel does not store host SSH keys.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/poouo/Forwardx?display_name=tag&sort=semver)](https://github.com/poouo/Forwardx/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[Documentation (Chinese)](https://poouo.github.io/Forwardx/) · [Downloads](https://github.com/poouo/Forwardx/releases/latest) · [English changelog](CHANGELOG.en.md) · [中文更新日志](CHANGELOG.md) · [Telegram Group](https://t.me/ForwardX_panel)

> Documentation follows the current source. Source, documentation deployment and Release builds update independently. New features require packages and Agents containing those changes; older installed versions may not support them. See [version guidance](docs/guide/releases.md).

## Features

- TCP / UDP / TCP+UDP forwarding using iptables, nftables, Realm, socat, GOST and Nginx.
- GOST, ForwardX V1/V2 and Nginx Stream tunnels; fixed multi-hop chains, entry/exit groups and failover.
- Host monitoring, rule traffic/quotas, latency history, availability, connectivity tests and diagnostic logs.
- User permissions, plans, billing, balances, payments, support tickets and optional AFF referrals.
- Email, Telegram / Discord notifications, Google sign-in, AI assistance, plugins and Chinese/English UI.
- Android APK, unsigned iOS IPA and the Linux SSH management command `fwxm`.

## 1. Choose a deployment method

Production requires a **single panel instance**. SQLite, MySQL and PostgreSQL are supported; an external database does not imply multi-replica support. Managed hosts require Linux, root access and connectivity to the panel.

| Method | Use case | Guide |
| --- | --- | --- |
| Docker installer | Script-managed images, containers and volumes | [Docker](docs/guide/deploy-docker.md) |
| Linux local installer | Release bundle managed by the host init system | [Local deployment](docs/guide/deploy-local.md) |
| Manual Compose / release bundle | You maintain configuration, services and upgrades | [Deployment overview](docs/guide/deploy-panel.md) |
| Local development | Source/UI testing, never public production | [Development](docs/guide/development.md) |

Run commands as root; otherwise replace the Bash command after the pipe with `sudo bash`. The default public port is **9810**, unless changed during installation.

### Docker installation

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install --language en
```

Default host directory: `/opt/forwardx-docker`; container: `forwardx-panel`; container port: `3000`. Database configuration, SQLite and persistent data live in a named volume mounted at `/data`, **not in a data subdirectory of the default host deployment directory**.

### Linux local installation

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install --language en
```

Default directory: `/opt/forwardx-panel`; data: `/opt/forwardx-panel/data`; service: `forwardx-panel`. Supports systemd / OpenRC / SysV. The installer prepares Node.js 22+ and pnpm, then installs a Release bundle.

English commands pass `--language en`; the Chinese README passes `--language zh-CN`. The setup wizard can switch between Simplified Chinese and English without losing form input. A saved browser preference takes priority.

## 2. Initialize and connect hosts

1. Open `http://SERVER_IP:9810`, check database settings and create the first administrator. Reused databases retain existing accounts.
2. Configure [HTTPS/reverse proxy](docs/guide/reverse-proxy.md) and set the public panel URL reachable by Agents.
3. In **Hosts → Token Management**, create a **separate Token for each host** and copy its installation command.
4. Run it as root on the managed Linux host and verify the Agent is online.
5. Create a link resource (port forward/tunnel), add a forwarding rule, then test real application traffic.

Example Agent installation:

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

Replace the URL and Token. Inside Docker, `127.0.0.1` is not the host database address. NAT hosts need their actual mapped port ranges configured; allow ports through both security groups and host firewalls. See [Quick Start](docs/guide/quick-start.md), [Setup](docs/guide/first-setup.md) and [Agent installation](docs/guide/agent.md).

## 3. SSH management

New official installation/upgrade workflows register the four-letter command. In SSH, run:

```bash
fwxm
```

With one installed role, its menu opens directly. With both roles on the same host, choose panel or Agent first. Menus provide status, logs, restart, proxies, upgrades, repair and removal; the panel menu also offers administrator password reset. Manage Docker panels from the **host**, not the container. Non-root users run `sudo fwxm`.

```bash
fwxm panel status
fwxm panel restart
fwxm panel logs
fwxm panel address
fwxm panel reset-admin

fwxm agent status
fwxm agent restart
fwxm agent logs
fwxm agent upgrade
```

Older/manual deployments may not have this command. Official script-managed installations register it on upgrade; do not blindly apply default installers to manually managed deployments. [Full command and proxy guide](docs/guide/agent-proxy-manager.en.md).

## 4. Agent installation, runtime and upgrades through SOCKS

Downloading the bootstrap and running it are separate steps: **configure both proxies**.

```bash
curl --proxy 'socks5h://127.0.0.1:1080' -fsSL \
  https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh \
  -o /tmp/forwardx-install-agent.sh

PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh \
  install YOUR_AGENT_TOKEN --proxy 'socks5h://127.0.0.1:1080'
```

The installer saves `proxyUrl` in `/etc/forwardx/agent/config.json`; upgrades reuse it. Existing newer Agents can edit the field and restart, or use:

```bash
fwxm agent proxy show
fwxm agent proxy set
fwxm agent proxy off
```

`set` uses hidden input, saves and restarts Agent; `off` saves direct mode and restarts. Removing/clearing `proxyUrl` and restarting also means explicit direct mode, ignoring host proxy variables. Only management/download traffic is proxied, **not forwarding or network probes**.

Supports SOCKS5 / HTTP / HTTPS; SOCKS uses remote DNS. Dependency installation depends on package-manager support; preinstall Alpine APK dependencies when using SOCKS. Docker pulls need a separate Docker daemon HTTP/HTTPS proxy. Panel maintenance proxy settings do not proxy Node runtime traffic. See the [proxy guide](docs/guide/agent-proxy-manager.en.md).

## 5. Upgrades, backups and recovery

[Back up databases and configuration](docs/guide/upgrade-backup.md) first. With the manager:

```bash
fwxm panel upgrade
fwxm agent upgrade
```

For older script-managed deployments:

```bash
# Docker panel
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade

# Local panel
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

In-place upgrades restart services/recreate containers; uninterrupted traffic is not guaranteed. Installers retain data and recognized settings, but regenerate `.env`/Compose. Back up and recheck custom variables, mounts and services. Downgrading binaries alone is not a safe rollback after database migrations.

Use a [trusted GitHub accelerator](docs/guide/deploy-docker.md#github-下载加速) if necessary. It is different from a SOCKS proxy and does not proxy GHCR image pulls.

For forgotten passwords use `fwxm panel reset-admin`, or the [older deployment recovery methods](docs/guide/account-recovery.md). Reinstallation does not reset accounts in an existing database. **Agent removal interrupts managed forwarding; confirmed Docker removal deletes its volume, while local removal can retain data.** See [removal guidance](docs/guide/uninstall.md).

## Documentation map

Most detailed guides are in Chinese; English guides cover [SSH/proxies](docs/guide/agent-proxy-manager.en.md) and [multi-entry direct forwarding](docs/guide/port-entry-groups.en.md).

| Topic | Guides |
| --- | --- |
| Deployment/setup | [Preparation](docs/guide/preparation.md) · [Docker](docs/guide/deploy-docker.md) · [Local](docs/guide/deploy-local.md) · [Database](docs/guide/database.md) |
| Maintenance | [SSH manager/proxies (English)](docs/guide/agent-proxy-manager.en.md) · [Paths/logs](docs/guide/paths-logs.md) · [Environment](docs/guide/env-vars.md) |
| Forwarding/metrics | [Rules](docs/guide/rules.md) · [Tunnels](docs/guide/tunnels.md) · [Chains](docs/guide/port-chains.md) · [Groups](docs/guide/groups.md) · [Traffic/latency](docs/guide/traffic-latency.md) |
| Accounts/notifications | [Users/plans](docs/guide/users-billing.md) · [Notifications](docs/guide/notifications.md) · [Tickets](docs/guide/support-tickets.md) · [Referrals](docs/guide/affiliates.md) |
| Extensions/recovery | [Google sign-in](docs/guide/google-login.md) · [AI](docs/guide/ai-assistant.md) · [Plugins](docs/guide/plugins.md) · [Migration](docs/guide/migration.md) · [Troubleshooting](docs/guide/troubleshooting.md) |

See the [full index](docs/guide/index.md). Without a manual preference, language follows the installation hint during setup, then browser languages/trusted country hints; no extra third-party visitor IP lookup is made. Manual selection is saved in the current browser. Normal language switching reloads the page, so save changes first. The selector offers only Simplified Chinese / English.

## Mobile clients

Download Android APK or `forwardx-ios-v<version>-unsigned.ipa` from [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest). iOS/iPadOS 15+ is supported. The IPA is **unsigned**: users provide certificates, signing and installation; App Store/TestFlight distribution is not provided.

Android and iOS share an app version, independent of panel/Agent/FXP versions. Availability depends on workflow completion and actual Release assets. See [mobile clients](docs/guide/mobile-app.md).

## Local development

```bash
pnpm install
pnpm dev:panel
```

Requires Node.js 22+ and pnpm 10.28.1. `dev:panel` serves real pages at `http://127.0.0.1:5173` with isolated SQLite data under the repository's `.dev` and automatic developer-admin sign-in. **Never expose it publicly.** `pnpm dev` starts only the backend and is not the isolated launcher.

Checks: `pnpm exec tsc --noEmit`, `pnpm test:agent-proxy`, `pnpm test:server`, `pnpm build`, `pnpm docs:build`, `pnpm check:versions`. See [development](docs/guide/development.md).

## Security

Keep a fixed random `JWT_SECRET`, use HTTPS/strong passwords/least privilege, and disable public registration when unnecessary. Human verification defaults to enabled; administrators can select click verification or obfuscated image CAPTCHA in system configuration, or disable it. Keep it enabled on public panels. Protect Agent/DDNS Tokens, proxy credentials and backups; verify restores. Never publish `.env`, database configuration or migration credentials.

## Support the author

USDT (TRON): `TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana: `8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain: `0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

USDT (Polygon): `0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

ForwardX Agent includes the third-party userspace WireGuard implementation under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Star history

<a href="https://star-history.com/#poouo/Forwardx&amp;Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=poouo/Forwardx&amp;type=Date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=poouo/Forwardx&amp;type=Date" />
    <img alt="ForwardX Star History" src="https://api.star-history.com/svg?repos=poouo/Forwardx&amp;type=Date" />
  </picture>
</a>
