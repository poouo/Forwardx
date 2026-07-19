# ForwardX 转发管理面板

ForwardX 通过轻量 Agent 统一管理多台 Linux 服务器上的端口转发、加密隧道、转发链、故障转移、用户权限、套餐和流量统计。面板不保存主机 SSH 密钥。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/poouo/Forwardx?display_name=tag&sort=semver)](https://github.com/poouo/Forwardx/releases/latest)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

## 链接

- [使用文档](https://poouo.github.io/Forwardx/)
- [GitHub Releases](https://github.com/poouo/Forwardx/releases/latest)
- [Telegram 群组](https://t.me/ForwardX_panel)
- [Android APK](https://github.com/poouo/Forwardx/releases/latest)

## 主要功能

- 创建 TCP、UDP 或 TCP+UDP 规则，支持 `iptables`、`nftables`、`realm`、`socat`、`gost` 和 `nginx`。
- 管理 GOST、ForwardX V1/V2 和 Nginx Stream 隧道，支持多跳、入口组、出口组和多出口。
- 使用转发链组织固定的入口、中转和出口路径。
- 使用转发组和 DDNS 实现多入口故障转移，支持 Cloudflare、华为云、阿里云、腾讯云 DNSPod 和 Webhook。
- 查看主机状态、规则流量、累计流量、延迟趋势、链路图、自测结果和系统日志。
- 管理用户权限、流量与端口额度、套餐、余额、兑换码、折扣码和支付通道。
- 支持邮件提醒、Telegram 通知、面板与 Agent 更新，以及 Android 客户端。
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

## 快速部署

面板默认访问端口为 `9810`。以下命令请使用 `root` 执行；非 `root` 环境可将 `bash` 替换为 `sudo bash`。

### Docker Compose

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- uninstall
```

Docker 默认拉取 `ghcr.io/poouo/forwardx:latest`，数据库配置和 SQLite 数据保存在数据卷中。升级会保留 `.env`、数据卷和部署目录中的 `data/`；卸载脚本仅在用户确认后删除这些数据。

### 本地 systemd

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- uninstall
```

默认安装目录为 `/opt/forwardx-panel`，服务名为 `forwardx-panel.service`，数据位于 `/opt/forwardx-panel/data`。

## 首次使用

1. 打开 `http://服务器IP:9810`。
2. 选择 SQLite、MySQL 或 PostgreSQL，完成数据库初始化。
3. 注册首个管理员，或使用已有数据库中的管理员登录。
4. 在「系统设置 -> Agent Token」创建 Token。
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

- SQLite 适合单机部署，默认文件为 `/data/forwardx.db`。
- MySQL 和 PostgreSQL 适合已有独立数据库运维的环境。
- 原地升级会保留数据库配置和业务数据。
- 请按所选数据库定期备份 SQLite 文件或数据库实例。

连接池、数据库地址、反向代理和升级相关变量见[环境变量文档](https://poouo.github.io/Forwardx/guide/env-vars)。常用变量如下：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9810` | 面板访问端口 |
| `DATABASE_CONFIG_PATH` | `/data/database.json` | 数据库连接配置文件 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 数据文件 |
| `DATABASE_TYPE` / `DB_TYPE` | 空 | 强制指定 `sqlite`、`mysql` 或 `postgresql` |
| `JWT_SECRET` | 自动生成 | 登录签名密钥；生产环境应固定配置 |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram 机器人 Token |
| `FORWARDX_IMAGE` | `ghcr.io/poouo/forwardx:latest` | Docker 镜像 |

## 本地开发

```bash
pnpm install
pnpm dev
```

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

## 赞助

USDT (TRON)：`TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana：`8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

USDT (Polygon)：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=poouo/Forwardx&type=Date)](https://www.star-history.com/#poouo/Forwardx&Date)
