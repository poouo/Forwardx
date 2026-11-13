# ForwardX Forwarding Management Panel

[简体中文](README.md) | [English](README.en.md)

Manage port forwarding, encrypted tunnels, failover, users and plans across Linux servers through lightweight agents. The panel manages configuration; forwarding runtimes on managed hosts carry business traffic. The panel does not store host SSH keys.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/poouo/Forwardx?display_name=tag&sort=semver)](https://github.com/poouo/Forwardx/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[Documentation (Chinese)](https://poouo.github.io/Forwardx/) · [Downloads](https://github.com/poouo/Forwardx/releases/latest) · [English changelog](CHANGELOG.en.md) · [中文更新日志](CHANGELOG.md) · [Telegram Group](https://t.me/ForwardX_panel)

> New features need a panel and Agent release that includes them. See [version guidance](docs/guide/releases.md) for how component versions line up.

## Features

- TCP / UDP / TCP+UDP forwarding using iptables, nftables, Realm, socat, GOST and Nginx.
- GOST, ForwardX V1/V2 and Nginx Stream tunnels; fixed multi-hop chains, entry/exit groups and failover.
- Host monitoring, rule traffic/quotas, latency history, availability, connectivity tests and diagnostic logs.
- User permissions, plans, billing, balances, payments, support tickets and optional AFF referrals.
- Email, Telegram / Discord notifications, Google sign-in, AI assistance, plugins and Chinese/English UI.
- Android APK, unsigned iOS IPA and the Linux SSH management command `fwxm`.

## 1. Choose a deployment method

The panel runs as a single instance and stores data in SQLite, MySQL or PostgreSQL. Managed hosts must run Linux, give you root access and be able to reach the panel.

| Method | Use case | Guide |
| --- | --- | --- |
| Docker installer | Script-managed images, containers and volumes | [Docker](docs/guide/deploy-docker.md) |
| Linux local installer | Release bundle managed by the host init system | [Local deployment](docs/guide/deploy-local.md) |
| Manual Compose / release bundle | You maintain configuration, services and upgrades | [Deployment overview](docs/guide/deploy-panel.md) |
| Local development | Source/UI testing, never public production | [Development](docs/guide/development.md) |

Run the commands below as root, or replace `bash` after the pipe with `sudo bash`. The panel listens on port **9810** by default; you can change it during installation.

### Docker installation

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install --language en
```

Installs to `/opt/forwardx-docker` with a container named `forwardx-panel`; the host port maps to container port `3000`. Database settings, the SQLite file and other data live in a Docker named volume mounted at `/data`, **not under the deployment directory**.

### Linux local installation

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install --language en
```

Installs to `/opt/forwardx-panel` with data in its `data` directory and a service named `forwardx-panel`. systemd, OpenRC and SysV are supported. The installer sets up Node.js 22+ and pnpm for you.

`--language` sets the default language of the installer and the setup wizard (`en` or `zh-CN`). You can still switch inside the wizard.

## 2. Initialize and connect hosts

1. Open `http://SERVER_IP:9810`, confirm the database settings and create the administrator. If you reuse an existing database, sign in with the existing account.
2. Configure [HTTPS and a reverse proxy](docs/guide/reverse-proxy.md), then enter the panel address that Agents can reach under **Settings**.
3. In **Hosts → Token Management**, create a **separate Token for each host** and copy its installation command.
4. Run the command as root on the managed host, then check in the panel that the host is online.
5. Create a port forward or tunnel under **Links**, add a rule under **Forwarding Rules**, and connect through it once to confirm it works.

Example Agent installation:

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

Replace the URL and Token with your own. Common pitfalls: when the panel runs in Docker and uses a database on the host, `127.0.0.1` points at the container, not the host; NAT hosts need their actual mapped port range; forwarding ports must be open in both the cloud security group and the host firewall. See [Quick Start](docs/guide/quick-start.md), [Setup](docs/guide/first-setup.md) and [Agent installation](docs/guide/agent.md).

## 3. SSH management

Installing or upgrading with the official scripts adds the `fwxm` command to the host:

```bash
fwxm
```

Without arguments it opens an interactive menu for status, logs, restart, proxy settings, upgrade, repair and removal; the panel menu can also reset the administrator password. If the panel and an Agent share a host, it asks which one to manage first. For a Docker panel, run it on the **host**, not in the container. Non-root users run `sudo fwxm`. Common subcommands:

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

Older versions and manual deployments do not have this command until they are upgraded with the official installer; do not run the installer over a manual deployment. See the [full command and proxy guide](docs/guide/agent-proxy-manager.en.md).

## 4. Agent installation, runtime and upgrades through SOCKS

Downloading the install script and running it are two steps, and **both need the proxy**:

```bash
curl --proxy 'socks5h://127.0.0.1:1080' -fsSL \
  https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh \
  -o /tmp/forwardx-install-agent.sh

PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh \
  install YOUR_AGENT_TOKEN --proxy 'socks5h://127.0.0.1:1080'
```

The proxy address is saved as `proxyUrl` in `/etc/forwardx/agent/config.json` and reused on upgrade. To change it later, edit that field and restart the Agent, or use:

```bash
fwxm agent proxy show
fwxm agent proxy set
fwxm agent proxy off
```

`set` and `off` both restart the Agent. An empty `proxyUrl` means a direct connection; the Agent does not read the system proxy environment variables. The proxy only carries Agent-to-panel traffic and downloads; **forwarded traffic and network probes do not use it**.

SOCKS5, HTTP and HTTPS proxies are supported. System dependencies are installed by the package manager, which this proxy does not control, so preinstall them on Alpine when using SOCKS. Docker image pulls need a proxy configured on the Docker daemon. See the [proxy guide](docs/guide/agent-proxy-manager.en.md).

## 5. Upgrades, backups and recovery

[Back up the database and configuration](docs/guide/upgrade-backup.md) before upgrading. If you have `fwxm`:

```bash
fwxm panel upgrade
fwxm agent upgrade
```

For older deployments without `fwxm`:

```bash
# Docker panel
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade

# Local panel
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

An upgrade restarts the service or recreates the container, so the panel is briefly unavailable; upgrading an Agent can briefly interrupt forwarding on that host. The scripts keep your data and core settings but rewrite `.env` and the Compose file, so back up any custom variables, mounts or service settings and check them afterwards. Once the database schema has been upgraded you cannot simply switch back to the old program; restore the pre-upgrade backup to roll back.

If GitHub is hard to reach, use a [download accelerator](docs/guide/deploy-docker.md#github-下载加速). It only speeds up GitHub downloads; it is not a proxy and does not cover GHCR image pulls.

If you forget the administrator password, run `fwxm panel reset-admin` (older deployments: see [account recovery](docs/guide/account-recovery.md)). Reinstalling the panel does not reset it. **Removing an Agent stops forwarding on that host; removing a Docker panel deletes its data volume, while a local removal lets you keep the data.** See [removal guidance](docs/guide/uninstall.md).

## Documentation map

Most detailed guides are in Chinese; English guides cover [SSH/proxies](docs/guide/agent-proxy-manager.en.md) and [multi-entry direct forwarding](docs/guide/port-entry-groups.en.md).

| Topic | Guides |
| --- | --- |
| Deployment/setup | [Preparation](docs/guide/preparation.md) · [Docker](docs/guide/deploy-docker.md) · [Local](docs/guide/deploy-local.md) · [Database](docs/guide/database.md) |
| Maintenance | [SSH manager/proxies (English)](docs/guide/agent-proxy-manager.en.md) · [Paths/logs](docs/guide/paths-logs.md) · [Environment](docs/guide/env-vars.md) |
| Forwarding/metrics | [Rules](docs/guide/rules.md) · [Tunnels](docs/guide/tunnels.md) · [Chains](docs/guide/port-chains.md) · [Groups](docs/guide/groups.md) · [Traffic/latency](docs/guide/traffic-latency.md) |
| Accounts/notifications | [Users/plans](docs/guide/users-billing.md) · [Notifications](docs/guide/notifications.md) · [Tickets](docs/guide/support-tickets.md) · [Referrals](docs/guide/affiliates.md) |
| Extensions/recovery | [Google sign-in](docs/guide/google-login.md) · [AI](docs/guide/ai-assistant.md) · [Plugins](docs/guide/plugins.md) · [Migration](docs/guide/migration.md) · [Troubleshooting](docs/guide/troubleshooting.md) |

See the [full index](docs/guide/index.md). The interface is available in Simplified Chinese and English; it follows your browser language by default and can be switched in the interface.

## Mobile clients

Download the Android APK or the iOS `forwardx-ios-v<version>-unsigned.ipa` from [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest). The IPA is **unsigned**: sign and install it yourself (iOS/iPadOS 15+). There is no App Store or TestFlight build.

Android and iOS share one app version number, which is independent of the panel and Agent versions. See [mobile clients](docs/guide/mobile-app.md).

## Local development

```bash
pnpm install
pnpm dev:panel
```

Requires Node.js 22+ and pnpm 10.28.1. `dev:panel` serves the panel at `http://127.0.0.1:5173` using separate SQLite data under `.dev` and signs you in as a development administrator, so **never expose it publicly**. `pnpm dev` starts only the backend, without that isolated data.

Before submitting, run `pnpm exec tsc --noEmit`, `pnpm test:agent-proxy`, `pnpm test:server`, `pnpm build`, `pnpm docs:build` and `pnpm check:versions`. See [development](docs/guide/development.md).

## Security

- Set a fixed random `JWT_SECRET`, enable HTTPS and use strong passwords.
- Turn off registration if you do not need it. Sign-in human verification is on by default; keep it on for public panels.
- Treat Agent Tokens, DDNS Tokens, proxy credentials and backups like passwords. Never publish `.env`, database settings or migration keys.
- Back up regularly and confirm that a backup restores.

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
