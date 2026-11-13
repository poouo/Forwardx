# ForwardX 转发管理面板

[简体中文](README.md) | [English](README.en.md)

通过轻量 Agent 统一管理多台 Linux 服务器的端口转发、加密隧道、故障转移、用户与套餐。面板负责管理，业务流量由被管理主机上的运行时转发；面板不保存主机 SSH 密钥。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/poouo/Forwardx?display_name=tag&sort=semver)](https://github.com/poouo/Forwardx/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[使用文档](https://poouo.github.io/Forwardx/) · [发布下载](https://github.com/poouo/Forwardx/releases/latest) · [中文更新日志](CHANGELOG.md) · [English changelog](CHANGELOG.en.md) · [Telegram 群组](https://t.me/ForwardX_panel)

> 新功能需要对应版本的面板和 Agent，各组件的版本对应关系见 [版本说明](docs/guide/releases.md)。

## 功能概览

- TCP / UDP / TCP+UDP 转发，支持 iptables、nftables、Realm、socat、GOST、Nginx。
- GOST、ForwardX V1/V2、Nginx Stream 隧道，以及固定多跳转发链、入口组、出口组和故障转移。
- 主机监控、规则流量与限额、延迟历史、在线率、链路自测和诊断日志。
- 多用户权限、套餐、账单、余额、支付、工单及可选 AFF 推广返佣。
- 邮件、Telegram / Discord 通知，Google 登录、AI 助手、插件和中英文界面。
- Android APK、未签名 iOS IPA，以及 Linux SSH 管理命令 `fwxm`。

## 1. 选择部署方式

面板只支持单实例运行，数据库可选 SQLite、MySQL 或 PostgreSQL。被管理主机需要是 Linux、有 root 权限，并且能访问面板。

| 方式 | 适用场景 | 详细说明 |
| --- | --- | --- |
| Docker 一键安装 | 由脚本管理镜像、容器和数据卷 | [Docker 部署](docs/guide/deploy-docker.md) |
| Linux 本地安装 | 不使用 Docker，由系统服务运行发布包 | [本地部署](docs/guide/deploy-local.md) |
| 手动 Compose / 发布包 | 自行维护环境、服务及升级 | [部署总览](docs/guide/deploy-panel.md) |
| 本地开发 | 修改源码、测试页面，不用于公网生产 | [开发指南](docs/guide/development.md) |

以下命令用 root 执行，非 root 把管道后的 `bash` 换成 `sudo bash`。面板默认端口 **9810**，安装时可以改。

### Docker 安装

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install --language zh-CN
```

默认安装到 `/opt/forwardx-docker`，容器名 `forwardx-panel`，宿主机端口映射到容器的 `3000`。数据库配置、SQLite 文件等数据保存在挂载到容器 `/data` 的 Docker 命名卷里，**不在部署目录下**。

### Linux 本地安装

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install --language zh-CN
```

默认安装到 `/opt/forwardx-panel`，数据在其中的 `data` 目录，服务名 `forwardx-panel`，支持 systemd / OpenRC / SysV。安装器会自动准备 Node.js 22+ 和 pnpm。

`--language` 决定安装器和初始化向导的默认语言，可选 `zh-CN` 或 `en`，进入向导后仍可切换。

## 2. 完成初始化并接入主机

1. 打开 `http://服务器IP:9810`，确认数据库配置并创建管理员。沿用旧数据库时直接用原来的账号登录。
2. 配置 [HTTPS 与反向代理](docs/guide/reverse-proxy.md)，并在系统设置里填写 Agent 能访问到的面板地址。
3. 在「主机管理 → Token 管理」为**每台主机分别创建 Token**，复制该主机的安装命令。
4. 在被管理的主机上用 root 执行安装命令，回到面板确认主机在线。
5. 在「链路管理」创建端口转发或隧道，再到「转发规则」添加规则，并实际连接一次确认能通。

Agent 安装示例：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

把地址和 Token 换成自己的。几个常见问题：面板跑在 Docker 里并连接宿主机上的数据库时，地址不能填 `127.0.0.1`（那是容器自己）；NAT 主机要填写实际映射的端口段；云安全组和系统防火墙都要放行转发端口。详见 [快速开始](docs/guide/quick-start.md)、[首次初始化](docs/guide/first-setup.md)、[Agent 安装](docs/guide/agent.md)。

## 3. SSH 日常管理

用官方脚本安装或升级后，主机上会多一个 `fwxm` 命令：

```bash
fwxm
```

不带参数时进入交互菜单，可以查看状态和日志、重启、设置代理、升级、重装修复和卸载，面板还可以重置管理员密码。同一台机器同时装了面板和 Agent 时，会先让你选择管理哪一个。Docker 部署的面板在**宿主机**上执行；非 root 用 `sudo fwxm`。常用子命令：

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

旧版本和手工部署没有这个命令，用官方安装器升级后才会有；手工部署不要直接运行安装器。完整命令见 [SSH 管理与代理](docs/guide/agent-proxy-manager.md)。

## 4. Agent 通过 SOCKS 代理安装、运行与升级

下载安装脚本和执行安装是两步，**都要指定代理**：

```bash
curl --proxy 'socks5h://127.0.0.1:1080' -fsSL \
  https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh \
  -o /tmp/forwardx-install-agent.sh

PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh \
  install YOUR_AGENT_TOKEN --proxy 'socks5h://127.0.0.1:1080'
```

代理地址保存在 `/etc/forwardx/agent/config.json` 的 `proxyUrl`，升级时沿用。之后要修改，可以编辑这个字段再重启 Agent，或者用：

```bash
fwxm agent proxy show
fwxm agent proxy set
fwxm agent proxy off
```

`set` 和 `off` 都会重启 Agent。清空 `proxyUrl` 即为直连，Agent 不读取系统的代理环境变量。代理只用于 Agent 与面板的通信和下载，**转发流量和网络探测不走代理**。

支持 SOCKS5 / HTTP / HTTPS 代理。系统依赖由包管理器安装，不受此代理控制，Alpine 上使用 SOCKS 时需要先装好依赖；Docker 拉取镜像要另外给 Docker daemon 配置代理。详见 [代理指南](docs/guide/agent-proxy-manager.md)。

## 5. 升级、备份与恢复

升级前先 [备份数据库和配置](docs/guide/upgrade-backup.md)。已有 `fwxm` 时：

```bash
fwxm panel upgrade
fwxm agent upgrade
```

没有 `fwxm` 的旧部署：

```bash
# Docker 面板
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade

# 本地面板
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

升级会重启服务或重建容器，期间面板不可用；升级 Agent 可能短暂中断该主机上的转发。脚本保留数据和核心配置，但会重写 `.env` 和 Compose 文件，自己加过的环境变量、挂载和服务配置要先备份，升级后核对。数据库结构升级后不能直接换回旧版程序，需要回退时请恢复升级前的备份。

访问 GitHub 受限时可以使用 [下载加速站](docs/guide/deploy-docker.md#github-下载加速)。它只加速 GitHub 下载，不是代理，也不能加速 GHCR 镜像拉取。

忘记管理员密码时执行 `fwxm panel reset-admin`，旧部署见 [账号恢复](docs/guide/account-recovery.md)；重装面板不会重置密码。**卸载 Agent 会停掉该主机上的转发；Docker 方式卸载会删除数据卷，本地方式可以选择保留数据**，详见 [卸载说明](docs/guide/uninstall.md)。

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 安装与初始化 | [部署准备](docs/guide/preparation.md) · [Docker](docs/guide/deploy-docker.md) · [本地](docs/guide/deploy-local.md) · [数据库](docs/guide/database.md) |
| 日常维护 | [SSH 管理与代理](docs/guide/agent-proxy-manager.md) · [目录与日志](docs/guide/paths-logs.md) · [环境变量](docs/guide/env-vars.md) |
| 转发与计量 | [规则](docs/guide/rules.md) · [隧道](docs/guide/tunnels.md) · [转发链](docs/guide/port-chains.md) · [组](docs/guide/groups.md) · [流量与延迟](docs/guide/traffic-latency.md) |
| 账户与通知 | [用户套餐](docs/guide/users-billing.md) · [通知](docs/guide/notifications.md) · [工单](docs/guide/support-tickets.md) · [推广](docs/guide/affiliates.md) |
| 扩展与恢复 | [Google 登录](docs/guide/google-login.md) · [AI](docs/guide/ai-assistant.md) · [插件](docs/guide/plugins.md) · [迁移](docs/guide/migration.md) · [排障](docs/guide/troubleshooting.md) |

完整目录见 [文档首页](docs/guide/index.md)。界面支持简体中文和 English，默认按浏览器语言显示，可在界面中切换。

## 移动客户端

在 [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest) 下载 Android APK 或 iOS 的 `forwardx-ios-v版本-unsigned.ipa`。IPA **未签名**，需要自行签名后安装（iOS / iPadOS 15+），不提供 App Store 或 TestFlight 版本。

Android 和 iOS 使用同一个 App 版本号，与面板、Agent 的版本号无关。详见 [移动客户端](docs/guide/mobile-app.md)。

## 本地开发

```bash
pnpm install
pnpm dev:panel
```

需要 Node.js 22+ 和 pnpm 10.28.1。`dev:panel` 在 `http://127.0.0.1:5173` 启动面板，使用项目 `.dev` 目录里的独立 SQLite 数据，并自动以开发管理员登录，**不要暴露到公网**。`pnpm dev` 只启动后端，不带这套隔离数据。

提交前可以运行：`pnpm exec tsc --noEmit`、`pnpm test:agent-proxy`、`pnpm test:server`、`pnpm build`、`pnpm docs:build`、`pnpm check:versions`。详见 [开发指南](docs/guide/development.md)。

## 安全建议

- 设置固定的随机 `JWT_SECRET`，启用 HTTPS，使用强密码。
- 不开放注册时关闭注册入口。登录人机验证默认开启，公网部署建议保留。
- Agent Token、DDNS Token、代理账号和备份文件按密码对待；不要公开 `.env`、数据库配置和迁移密钥。
- 定期备份，并确认备份能恢复。

## 给作者充点克劳德

USDT (TRON)：`TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana：`8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

USDT (Polygon)：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

ForwardX Agent also includes the third-party userspace WireGuard implementation under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Star 趋势

<a href="https://star-history.com/#poouo/Forwardx&amp;Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=poouo/Forwardx&amp;type=Date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=poouo/Forwardx&amp;type=Date" />
    <img alt="ForwardX Star 趋势" src="https://api.star-history.com/svg?repos=poouo/Forwardx&amp;type=Date" />
  </picture>
</a>
