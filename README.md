# ForwardX 转发管理面板

[简体中文](README.md) | [English](README.en.md)

通过轻量 Agent 统一管理多台 Linux 服务器的端口转发、加密隧道、故障转移、用户与套餐。面板负责管理，业务流量由被管理主机上的运行时转发；面板不保存主机 SSH 密钥。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/poouo/Forwardx?display_name=tag&sort=semver)](https://github.com/poouo/Forwardx/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[使用文档](https://poouo.github.io/Forwardx/) · [发布下载](https://github.com/poouo/Forwardx/releases/latest) · [中文更新日志](CHANGELOG.md) · [English changelog](CHANGELOG.en.md) · [Telegram 群组](https://t.me/ForwardX_panel)

> 文档按当前源码整理。源码、文档站和 Release 构建独立更新；新功能须使用包含它的发布包与 Agent，不能仅凭文档判断旧版本已支持。具体见 [版本说明](docs/guide/releases.md)。

## 功能概览

- TCP / UDP / TCP+UDP 转发，支持 iptables、nftables、Realm、socat、GOST、Nginx。
- GOST、ForwardX V1/V2、Nginx Stream 隧道，以及固定多跳转发链、入口组、出口组和故障转移。
- 主机监控、规则流量与限额、延迟历史、在线率、链路自测和诊断日志。
- 多用户权限、套餐、账单、余额、支付、工单及可选 AFF 推广返佣。
- 邮件、Telegram / Discord 通知，Google 登录、AI 助手、插件和中英文界面。
- Android APK、未签名 iOS IPA，以及 Linux SSH 管理命令 `fwxm`。

## 1. 选择部署方式

正式环境使用**单面板实例**。数据库支持 SQLite、MySQL 和 PostgreSQL；外部数据库不代表支持多副本。被管理主机需 Linux、root 权限及到面板的网络连接。

| 方式 | 适用场景 | 详细说明 |
| --- | --- | --- |
| Docker 一键安装 | 由脚本管理镜像、容器和数据卷 | [Docker 部署](docs/guide/deploy-docker.md) |
| Linux 本地安装 | 不使用 Docker，由系统服务运行发布包 | [本地部署](docs/guide/deploy-local.md) |
| 手动 Compose / 发布包 | 自行维护环境、服务及升级 | [部署总览](docs/guide/deploy-panel.md) |
| 本地开发 | 修改源码、测试页面，不用于公网生产 | [开发指南](docs/guide/development.md) |

以下命令以 root 执行，非 root 将管道后的 `bash` 替换为 `sudo bash`。默认访问端口为 **9810**，以安装时选择为准。

### Docker 安装

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install --language zh-CN
```

默认目录 `/opt/forwardx-docker`，容器 `forwardx-panel`；宿主机端口映射容器 `3000`。数据库配置、SQLite 和其他持久化数据在容器 `/data` 对应的命名卷中，**不在默认部署目录的 data 子目录**。

### Linux 本地安装

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install --language zh-CN
```

默认目录 `/opt/forwardx-panel`，数据目录 `/opt/forwardx-panel/data`，服务 `forwardx-panel`；支持 systemd / OpenRC / SysV。安装器准备 Node.js 22+ 和 pnpm，并安装 Release 发布包。

中文命令传入 `--language zh-CN`，英文 README 传入 `--language en`。首次向导可切换简体中文 / English，保留输入；浏览器中的手动语言选择优先。

## 2. 完成初始化并接入主机

1. 打开 `http://服务器IP:9810`，核对数据库并创建首个管理员。复用旧数据库时使用原账号。
2. 配置 [HTTPS 与反向代理](docs/guide/reverse-proxy.md)，在系统设置填写 Agent 可访问的面板公开地址。
3. 在「主机管理 → Token 管理」为**每台主机分别创建 Token**，复制该主机的安装命令。
4. 在被管理 Linux 主机以 root 执行，确认 Agent 在线。
5. 先创建端口转发 / 隧道等链路资源，再添加规则并用真实业务验证。

Agent 安装示例：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

替换实际地址和 Token。Docker 连接宿主机数据库时，不要把 `127.0.0.1` 当成宿主机。NAT 主机要配置实际映射端口段，安全组与系统防火墙均需放行对应端口。详见 [快速开始](docs/guide/quick-start.md)、[首次初始化](docs/guide/first-setup.md)、[Agent 安装](docs/guide/agent.md)。

## 3. SSH 日常管理

新版官方安装/升级流程会注册四字母命令。SSH 中直接输入：

```bash
fwxm
```

仅安装一种组件时进入对应菜单；同机安装面板与 Agent 时先选择对象。菜单提供运行状态、日志、重启、代理设置、升级、重装修复和卸载；面板额外提供管理员密码重置。Docker 面板在**宿主机**使用，非 root 使用 `sudo fwxm`。

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

旧版本或手工部署未必有该命令；使用对应官方安装器升级后才能注册，手工部署不要直接套用默认安装流程。[完整命令与适用范围](docs/guide/agent-proxy-manager.md)。

## 4. Agent 通过 SOCKS 代理安装、运行与升级

下载入口脚本和执行安装是两个阶段，**两处都要指定代理**：

```bash
curl --proxy 'socks5h://127.0.0.1:1080' -fsSL \
  https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh \
  -o /tmp/forwardx-install-agent.sh

PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh \
  install YOUR_AGENT_TOKEN --proxy 'socks5h://127.0.0.1:1080'
```

代理保存到 `/etc/forwardx/agent/config.json` 的 `proxyUrl`，升级默认沿用。已有新版 Agent 可编辑该字段并重启，或使用：

```bash
fwxm agent proxy show
fwxm agent proxy set
fwxm agent proxy off
```

`set` 提供隐藏输入并重启 Agent；`off` 保存为直连并重启。删除或清空 `proxyUrl` 后重启也会明确直连，不继承系统代理变量。代理仅覆盖管理通信与下载，**不改变转发业务和网络探测路径**。

支持 SOCKS5 / HTTP / HTTPS，SOCKS 域名由代理解析。系统依赖安装仍取决于包管理器；Alpine APK 使用 SOCKS 时需预装依赖。Docker 镜像拉取需单独配置 Docker daemon 的 HTTP/HTTPS 代理；面板维护代理不等同于 Node 运行代理。详见 [代理指南](docs/guide/agent-proxy-manager.md)。

## 5. 升级、备份与恢复

升级前 [备份数据库和配置](docs/guide/upgrade-backup.md)。有 `fwxm` 时：

```bash
fwxm panel upgrade
fwxm agent upgrade
```

旧版脚本部署：

```bash
# Docker 面板
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade

# 本地面板
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

原地升级会重启服务或重建容器，不保证业务不断。脚本保留数据和识别的核心配置，但会重写 `.env` / Compose，自定义环境、挂载与服务配置需备份核对。数据库已升级时，换回旧程序不等于安全回退。

GitHub 访问受限时使用 [可信加速站](docs/guide/deploy-docker.md#github-下载加速)；它与 SOCKS 代理不同，不代理 GHCR 镜像拉取。

忘记密码使用 `fwxm panel reset-admin`，旧部署见 [账号恢复](docs/guide/account-recovery.md)。重装不会重置旧数据库管理员。**卸载 Agent 会中断受管转发；Docker 卸载确认后删除数据卷，本地卸载可选择保留数据**，详见 [卸载说明](docs/guide/uninstall.md)。

## 文档导航

| 主题 | 文档 |
| --- | --- |
| 安装与初始化 | [部署准备](docs/guide/preparation.md) · [Docker](docs/guide/deploy-docker.md) · [本地](docs/guide/deploy-local.md) · [数据库](docs/guide/database.md) |
| 日常维护 | [SSH 管理与代理](docs/guide/agent-proxy-manager.md) · [目录与日志](docs/guide/paths-logs.md) · [环境变量](docs/guide/env-vars.md) |
| 转发与计量 | [规则](docs/guide/rules.md) · [隧道](docs/guide/tunnels.md) · [转发链](docs/guide/port-chains.md) · [组](docs/guide/groups.md) · [流量与延迟](docs/guide/traffic-latency.md) |
| 账户与通知 | [用户套餐](docs/guide/users-billing.md) · [通知](docs/guide/notifications.md) · [工单](docs/guide/support-tickets.md) · [推广](docs/guide/affiliates.md) |
| 扩展与恢复 | [Google 登录](docs/guide/google-login.md) · [AI](docs/guide/ai-assistant.md) · [插件](docs/guide/plugins.md) · [迁移](docs/guide/migration.md) · [排障](docs/guide/troubleshooting.md) |

完整目录见 [文档首页](docs/guide/index.md)。面板支持中英文；未手动选择时根据部署语言（初始化期间）、浏览器和可信地区提示判断，不额外请求第三方 IP 定位。手动选择保存在当前浏览器，常规切换需刷新并先保存表单。语言菜单仅有简体中文 / English。

## 移动客户端

从 [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest) 下载 Android APK 或 `forwardx-ios-v版本-unsigned.ipa`。iOS / iPadOS 15+，IPA **未签名**，证书、签名与安装由用户自行处理，不提供 App Store / TestFlight 分发。

Android 与 iOS 统一应用版本号，独立于面板 / Agent / FXP 版本；安装包是否可用以工作流和 Release 附件为准。详见 [移动客户端](docs/guide/mobile-app.md)。

## 本地开发

```bash
pnpm install
pnpm dev:panel
```

需要 Node.js 22+、pnpm 10.28.1。`dev:panel` 在 `http://127.0.0.1:5173` 启动真实页面，使用项目 `.dev` 中的隔离 SQLite 数据和开发管理员自动登录，**禁止暴露公网**。`pnpm dev` 仅直接启动后端，不是隔离开发启动器。

验证：`pnpm exec tsc --noEmit`、`pnpm test:agent-proxy`、`pnpm test:server`、`pnpm build`、`pnpm docs:build`、`pnpm check:versions`。详见 [开发指南](docs/guide/development.md)。

## 安全建议

固定随机 `JWT_SECRET`，启用 HTTPS、强密码及最小权限；不需要注册时关闭入口。登录人机验证默认开启，管理员可在系统配置选择点击验证或混淆图片验证码，也可关闭，但公网推荐保持开启。保护 Agent / DDNS Token、代理凭据和备份，定期验证恢复；不要公开 `.env`、数据库配置或迁移密钥。

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
