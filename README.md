# ForwardX 转发管理面板

[简体中文](README.md) | [English](README.en.md)

ForwardX 通过轻量 Agent 统一管理多台 Linux 服务器上的端口转发、加密隧道、转发链、故障转移、用户权限、套餐和流量统计。面板不保存主机 SSH 密钥。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/poouo/Forwardx?display_name=tag&sort=semver)](https://github.com/poouo/Forwardx/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

## 链接

- [使用文档](https://poouo.github.io/Forwardx/)
- [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest)
- [更新日志（中文）](CHANGELOG.md) · [Changelog (English)](CHANGELOG.en.md)
- [Telegram 群组](https://t.me/ForwardX_panel)
- [Android APK](https://github.com/poouo/Forwardx/releases/latest)
- [iOS IPA（需自行签名）](https://github.com/poouo/Forwardx/releases/latest)

## 文档目录

- [部署总览](docs/guide/deploy-panel.md) · [Docker 部署](docs/guide/deploy-docker.md) · [本地部署](docs/guide/deploy-local.md)
- [数据库](docs/guide/database.md) · [HTTPS 与反代](docs/guide/reverse-proxy.md) · [环境变量](docs/guide/env-vars.md)
- [首次初始化](docs/guide/first-setup.md) · [Agent 安装](docs/guide/agent.md) · [转发规则](docs/guide/rules.md)
- [通知渠道](docs/guide/notifications.md) · [AI 助手](docs/guide/ai-assistant.md) · [Google 登录](docs/guide/google-login.md)
- [目录与日志](docs/guide/paths-logs.md) · [账号恢复](docs/guide/account-recovery.md) · [升级备份](docs/guide/upgrade-backup.md) · [面板迁移](docs/guide/migration.md)
- [全部文档](docs/guide/index.md) · [本地开发](docs/guide/development.md) · [插件开发](docs/guide/plugins.md)

## 主要功能

- 创建 TCP、UDP 或 TCP+UDP 规则，支持 `iptables`、`nftables`、`realm`、`socat`、`gost` 和 `nginx`。
- 管理 GOST、ForwardX V1/V2 和 Nginx Stream 隧道，支持多跳、入口组、出口组和多出口。
- 使用转发链组织固定的入口、中转和出口路径。
- 使用转发组和 DDNS 实现多入口故障转移，支持 Cloudflare、华为云、阿里云、腾讯云 DNSPod 和 Webhook。
- 查看主机状态、规则流量、累计流量、延迟趋势、链路图、自测结果和系统日志。
- 管理用户权限、流量与端口额度、套餐、余额、兑换码、折扣码和支付通道。
- 支持邮件提醒、Telegram / Discord 通知渠道二选一（默认 Telegram）、面板与 Agent 更新，以及 Android / iOS 客户端。
- 提供可选 Google 登录、AI 自然语言查询与确认操作、管理员单条规则限额。
- 登录/注册人机验证默认开启，可在「系统设置 → 系统配置」中关闭并保存以处理部分 HTTP 浏览器兼容问题；不影响密码、登录限流、邮箱验证及 2FA，公网部署推荐使用 HTTPS 并保持开启。
- 提供插件商店、第三方商店和 Agent 动态资源管理接口。

## 资源模型

链路资源在「链路管理」中创建，业务端口和目标地址在「转发规则」中配置。

| 资源 | 路径 | 适用场景 |
| --- | --- | --- |
| 端口转发 | 用户 -> 单台主机 -> 目标 | 单台主机可直接访问目标 |
| 隧道 | 用户 -> 入口 -> 隧道 -> 出口 -> 目标 | 入口和出口不同，或需要加密链路 |
| 转发链 | 用户 -> 入口 -> 中转 -> 出口 -> 目标 | 固定多跳路径 |
| 转发组 | 多个入口 -> 同一目标 | 多入口高可用和 DDNS 故障转移 |

入口组用于复用多台入口主机，出口组用于复用多个隧道出口。规则引用已保存的资源，因此同一资源可以供多条规则使用。

## 移动客户端

### iOS 客户端

从 [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest) 下载 `forwardx-ios-v版本-unsigned.ipa`，支持 iOS / iPadOS 15 及以上。该包未签名，不能直接在普通设备上安装；证书、签名和安装工具由用户自行准备，不提供 App Store / TestFlight 分发。

GitHub Actions 的 **iOS IPA** 工作流可手动构建，也会在推送版本 Tag 时独立构建并附加到对应 Release；手动构建结果在 Actions 的 `forwardx-ios-ipa` 附件中下载。无需配置 Apple 签名 Secrets。详见 [移动客户端文档](docs/guide/mobile-app.md)。

## 快速部署

面板默认访问端口为 `9810`。以下命令请使用 `root` 执行；非 `root` 环境可将 `bash` 替换为 `sudo bash`。

下方安装命令传入 `--language zh-CN`，首次部署向导默认中文；英文 README 的命令传入 `--language en`，默认英文。向导右上角可切换简体中文 / English，界面直接更新且保留表单输入；用户选择保存在浏览器并优先生效。两个安装脚本均支持 `--language auto`（改用浏览器 / IP 判断），或通过 `FORWARDX_SETUP_LANGUAGE=zh-CN` / `en` 传入。升级保留原值；初始化完成后，自动模式恢复正常浏览器 / IP 判断。

### Docker Compose

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install --language zh-CN
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- uninstall
```

Docker 默认使用 `ghcr.io/poouo/forwardx` 仓库，由脚本选择并校验发布镜像。数据库配置和 SQLite 数据在容器 `/data` 对应的命名卷中，不是默认放在宿主机部署目录的 `data/`。升级保留数据卷和脚本识别的核心配置，但会重新生成 Compose 与 `.env`；自定义环境、网络和挂载需备份并核对。卸载脚本经确认后会删除数据卷及部署目录。

### 本地部署

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install --language zh-CN
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- uninstall
```

默认安装目录为 `/opt/forwardx-panel`，systemd 服务名为 `forwardx-panel.service`，也适配 OpenRC / SysV，数据位于 `/opt/forwardx-panel/data`。升级保留数据，但会重新生成 `.env` 并保留已识别的核心项；手动追加配置需自行备份核对。

### 管理员密码恢复

忘记管理员密码时，可以从 Docker 容器或 SSH 终端执行重置命令。密码会在交互式终端中隐藏输入，不会作为命令行参数传递：

```bash
# Docker 部署（默认容器名为 forwardx-panel）
docker exec -it forwardx-panel node dist/reset-admin-password.js

# 本地 systemd 部署
sudo bash /opt/forwardx-panel/scripts/install-panel-local.sh reset-admin
```

如果有多个管理员，按提示输入要修改的用户名或邮箱。命令会撤销该管理员已有的登录会话，但保留 2FA 设置；被禁用的账号默认仍保持禁用状态，确认后再追加 `--enable-account` 才会启用。Docker 容器必须处于运行状态，执行前请先备份数据库。

如果自定义过容器名，请将命令中的 `forwardx-panel` 替换为实际容器名；也可以先执行 `docker exec -it forwardx-panel sh`，再在容器内运行 `node dist/reset-admin-password.js`。

### GitHub 下载加速

GitHub 访问不稳定时，可为 Docker 或本地安装脚本指定加速站。加速站格式为 `加速站地址/原始 GitHub URL`。首次执行时，安装脚本本身的 Raw 地址也需要加上前缀：

```bash
# Docker 安装
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh" \
  | bash -s -- install --language zh-CN --github-accelerator "https://mirror.example.com"

# 本地 systemd 安装
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh" \
  | bash -s -- install --language zh-CN --github-accelerator "https://mirror.example.com"
```

安装器会把地址保存到部署 `.env`，后续升级可继续使用；加速请求失败时会自动回退直连 GitHub。也可在「系统设置 -> 系统配置 -> GitHub 下载加速」开启「面板更新使用加速站」，让版本检查、Release 信息、安装包检测、回退及升级命令使用该地址。

该参数不代理 `ghcr.io` 镜像拉取。Docker 镜像源需要通过 `FORWARDX_IMAGE` 或 `FORWARDX_IMAGE_REPO` 单独配置。详细用法见[部署面板](https://poouo.github.io/Forwardx/guide/deploy-panel)和[升级与备份](https://poouo.github.io/Forwardx/guide/upgrade-backup)。

## 首次使用

1. 打开 `http://服务器IP:9810`。
2. 核对安装器预填的数据库，选择 SQLite、MySQL 或 PostgreSQL 并完成初始化。
3. 注册首个管理员，或使用已有数据库中的管理员登录。
4. 在「主机管理 -> Token 管理」创建 Token。
5. 在被管理主机安装 Agent，并在「主机管理」确认 Agent 在线。
6. 在「链路管理」创建端口转发、隧道、转发链或转发组。
7. 在「转发规则」选择资源，填写入口端口、协议和目标地址。

Agent 安装命令由面板按当前地址和 Token 生成，形式如下：

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

升级或卸载 Agent：

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- upgrade YOUR_AGENT_TOKEN
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- uninstall
```

## 隧道类型

| 类型 | 说明 |
| --- | --- |
| GOST | 使用 TLS、WSS、TCP、MTLS、MWSS 或 MTCP 等 GOST 模式 |
| ForwardX V1 | 使用原有 FXP 加密传输，兼容已部署隧道 |
| ForwardX V2 | 使用 Agent 内置的 userspace WireGuard 作为外层 UDP 传输，内层继续使用 FXP |
| Nginx Stream | 使用独立 `forwardx-nginx` 运行时进行四层 TCP/UDP 转发；TCP 可选 TLS 证书 |

ForwardX V2 不要求系统安装 `wg`，不会创建系统 WireGuard 网卡或修改主机路由。防火墙和安全组需要放行配置的 WireGuard UDP 端口。

Nginx 运行时监听规则或隧道配置中的端口，不会固定占用 80 端口。若主机上的其他 Nginx 出现 80 端口冲突，应检查该服务自身的站点配置和监听进程。

## mimic UDP 混淆

mimic 仅在用户为 ForwardX 隧道启用混淆时使用。V1 处理 FXP UDP，V2 处理 userspace WireGuard 的外层 UDP；TCP 仍使用原有 TCP 通道。参与链路的主机需要安装 `mimic`/`mimic-dkms`，并具备所需的 Linux 内核与 XDP/TC 能力。

Agent 安装脚本会询问是否安装 mimic，默认选择 `n`。也可以手动执行：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-mimic.sh | sudo bash
```

安装器默认使用 `wg-mimic-fabric v1.4.9` 安装或升级到 `mimic v0.7.1`；已满足目标版本时不会重复安装。可通过 `FORWARDX_MIMIC_VERSION` 和 `WMF_REF` 显式覆盖目标版本与安装器版本。

Agent 会上报 mimic 命令和内核模块的环境检测结果。启用 UDP 混淆时，面板会逐台校验链路主机；环境缺失、Agent 离线或尚未上报检测结果时会拒绝启用并提示手动安装，不会由 Agent 自动安装。

mimic 只改变 UDP 包在物理网卡上的外观，不负责端口转发，也不能改善公网本身的丢包或抖动。

## 数据库

ForwardX 支持 SQLite、MySQL 和 PostgreSQL：

- SQLite 适合单实例部署：Docker 默认为容器内 `/data/forwardx.db`，本地安装为 `/opt/forwardx-panel/data/forwardx.db`。
- MySQL 和 PostgreSQL 适合已有独立数据库运维的环境。
- 原地升级会保留数据库配置和业务数据。
- 按 [备份说明](docs/guide/upgrade-backup.md) 创建一致备份，不要在线仅复制 SQLite 主文件。

数据库地址、反向代理和升级相关变量见[环境变量文档](https://poouo.github.io/Forwardx/guide/env-vars)。MySQL/PostgreSQL 连接池由面板根据主机数量自动管理。常用变量如下（路径为容器/程序默认值，本地安装器会覆盖；Docker `.env` 中新增变量还需由 Compose 映射到容器）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9810` | 面板访问端口 |
| `DATABASE_CONFIG_PATH` | `/data/database.json` | 数据库连接配置文件 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 数据文件 |
| `DATABASE_TYPE` / `DB_TYPE` | 空 | 强制指定 `sqlite`、`mysql` 或 `postgresql` |
| `JWT_SECRET` | 自动生成 | 登录签名密钥；生产环境应固定配置 |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram 机器人 Token |
| `DISCORD_BOT_TOKEN` | 空 | Discord 机器人 Token；在通知设置中选择 Discord 并启用 |
| `FORWARDX_IMAGE` | `ghcr.io/poouo/forwardx:latest` | Docker 镜像 |

## 界面语言

面板支持简体中文和 English，可在左下角账号菜单中切换；登录页和首次部署页也提供语言选择。自动模式优先匹配浏览器语言，未匹配到支持语言时才使用已有 IP 地区缓存或可信代理提供的国家信息；无可靠信息时使用中文。不会为语言选择额外请求第三方 IP 定位。

手动选择保存在当前浏览器的 localStorage；本地存储不可用时尝试使用当前标签页的 sessionStorage。选择“自动”可恢复自动识别。语言切换会刷新页面，请先保存表单。用户自行填写的主机名、公告、插件内容和原始诊断输出不自动翻译。

## 本地开发

```bash
pnpm install
pnpm dev:panel
```

`dev:panel` 默认在 `http://127.0.0.1:5173` 提供真实页面，使用项目 `.dev` 中的隔离 SQLite 数据与开发管理员自动登录，**不能开放到公网**。`pnpm dev` 是直接启动后端，不等于该隔离模式。详见 [本地开发](docs/guide/development.md)。

检查与构建：

```bash
pnpm exec tsc --noEmit
pnpm test:server
pnpm build
pnpm docs:build
pnpm check:versions
```

## 安全建议

- 使用强密码并固定配置随机 `JWT_SECRET`。
- 不需要开放注册时，在系统设置中关闭注册入口。
- 为 MySQL 或 PostgreSQL 使用独立账户并授予最小权限。
- 通过 HTTPS 反向代理或防火墙限制面板访问范围。
- 妥善保存 Agent Token 和 DDNS Token，泄露后立即吊销。
- 定期备份数据库和面板数据目录。

## 给作者充点克劳德

USDT (TRON)：`TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana：`8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

USDT (Polygon)：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

ForwardX Agent also includes the third-party userspace WireGuard implementation
under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Star 趋势

[![Stargazers over time](https://starchart.cc/poouo/Forwardx.svg)](https://starchart.cc/poouo/Forwardx)
