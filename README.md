# ForwardX 转发管理面板

> 面向多台 Linux 服务器的端口转发、加密隧道、转发组、用户权限、套餐与流量计费统一管理面板。

ForwardX 是一套中文化的多主机转发管理系统。它通过轻量 Agent 管理服务器入口、隧道链路、端口转发规则、转发组、DDNS 故障转移、用户权限、套餐订阅、余额和流量统计，适合把多台服务器统一组织成可观测、可切换、可授权、可计费的网络入口平台。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.3.130-brightgreen.svg)](https://github.com/poouo/Forwardx/releases)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

## 社群与下载

- TG 群组：https://t.me/ForwardX_panel
- Android APK 最新下载：https://github.com/poouo/Forwardx/releases/download/v2.3.130/forwardx-android-v2.3.42.apk
- GitHub Releases：https://github.com/poouo/Forwardx/releases

## 项目定位

ForwardX 不只是一个端口转发工具。更贴切的定位是：

**ForwardX 转发管理面板**

它把端口转发、隧道链路、主机入口、转发组、DDNS 故障转移、用户配额和流量统计放在同一个控制面里管理。你可以把它理解为一个轻量的多机器网络入口管理面板。

## 功能概览

- 多主机 Agent 管理，无需在面板保存 SSH 密钥。
- 支持 TCP、UDP、TCP+UDP 转发规则。
- 支持 `iptables`、`nftables`、`realm`、`socat`、`gost` 等转发方式。
- 支持 GOST 隧道和 ForwardX 自定义加密隧道。
- 支持转发组，把多个主机入口或隧道入口作为一个高可用入口使用。
- 支持转发组成员优先级拖拽排序，默认按高优先级到低优先级故障转移。
- 支持 DDNS 故障转移，当前支持 Cloudflare 和 Webhook 服务商。
- 支持服务恢复后自动切回原入口，也可以关闭切回等待当前入口故障后再切换。
- 支持 TCPing 链路探测、流量统计、最近趋势、系统日志和 DDNS 事件记录。
- 支持用户到期时间、流量额度、端口数、规则数、主机权限和隧道权限管理。
- 支持开放注册开关，关闭后只能由管理员新增用户。
- 支持套餐、余额、兑换码、折扣码、商店开关和支付方式配置。
- 支持邮件验证码、套餐到期提醒、流量不足提醒和 Telegram 机器人。
- 支持面板和 Agent 在线升级。

## 转发模型

ForwardX 里常用的入口方式有三类：

| 模式 | 适用场景 | 说明 |
| --- | --- | --- |
| 主机端口转发 | 入口和目标都可以由单台主机直接处理 | 在转发规则中选择所属主机、协议、入口端口和目标地址 |
| 隧道转发 | 入口机和出口机不同，或需要加密链路 | 先创建隧道，再在转发规则中选择隧道入口 |
| 转发组 | 多台机器对同一目标提供同一服务入口 | 在转发组中维护成员和 DDNS 策略，在转发规则中选择转发组生成成员规则 |

转发组不会在组内直接设置真实转发目标。转发组只维护入口成员、成员优先级、DDNS 域名和故障转移策略；入口端口、协议、目标 IP 和目标端口仍然在「转发规则」中配置。这样同一个转发组可以像普通主机或隧道一样被多条转发规则复用。

## 转发组与故障转移

转发组用于解决多机器同时转发和入口高可用问题：

1. 在「转发组」中创建主机组或隧道组。
2. 添加多个入口成员，并通过鼠标拖动调整优先级。
3. 配置 DDNS 域名、记录类型、故障转移时间和是否恢复后切回。
4. 在「转发规则」中选择转发组，填写入口端口、协议和目标地址。
5. ForwardX 会为组内成员生成同一目标的真实转发规则，并根据 TCPing 健康数据执行故障转移。

故障转移默认从高优先级成员切到低优先级成员。开启「恢复后切回」后，高优先级成员恢复可用时会主动切回；关闭后会保持当前成员，直到当前成员再次故障才触发下一次切换。

DDNS 操作会写入系统日志和转发组事件，包括跳过、当前记录一致、开始更新、切换成功和更新失败，便于追踪域名入口变化。

## 数据库

首次部署时可以选择 SQLite、MySQL 或 PostgreSQL：

- SQLite 适合单机轻量部署，默认数据文件为 `/data/forwardx.db` 或本地安装目录下的 `data/forwardx.db`。
- MySQL 适合生产环境、长期运维和跨机器迁移。
- PostgreSQL 适合已有 PostgreSQL 运维体系或偏好 PostgreSQL 的生产环境。
- 首次打开面板会进入初始化向导，先选择数据库，再选择新面板或从旧面板迁移。
- 如果连接的是已有数据库，且里面已经存在管理员账户，会直接进入登录流程。
- 原地升级会保留已有配置和数据；Docker 部署会保留数据卷，本地 systemd 部署会保留安装目录下的 `data` 目录。
- 数据库备份建议由用户在 SQLite 文件、MySQL 或 PostgreSQL 侧自行维护。

## 快速部署

面板默认监听 `3000` 端口。

以下命令请以 `root` 用户执行；如果当前不是 `root`，把命令中的 `bash` 替换为 `sudo bash`。

### 本地 systemd 部署

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

默认路径：

| 项目 | 路径 |
| --- | --- |
| 安装目录 | `/opt/forwardx-panel` |
| 服务名称 | `forwardx-panel.service` |
| 数据库配置 | `/opt/forwardx-panel/data/database.json` |
| SQLite 数据文件 | `/opt/forwardx-panel/data/forwardx.db` |

### Docker Compose 部署

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

Docker 部署默认会把数据库配置保存到数据卷中的 `/data/database.json`，SQLite 数据文件保存在 `/data/forwardx.db`。
默认拉取 `ghcr.io/poouo/forwardx:latest` 预编译镜像，不会在用户服务器上重新构建镜像。
安装和升级会保留 `.env`、Docker 数据卷和部署目录内的 `data/` 数据；只有执行卸载脚本并输入 `y` 后才会删除部署目录和 Docker 数据卷。


## 首次初始化

1. 访问 `http://服务器IP:3000`。
2. 选择 SQLite、MySQL 或 PostgreSQL，并完成连接检测。
3. 选择作为新面板使用，或输入旧面板地址和管理员账户发起迁移。
4. 如果是新库，注册第一个管理员账户；如果是旧库或迁移完成，直接使用原管理员账户登录。
5. 登录后建议在系统设置中配置面板公开地址、Agent Token、邮件、开放注册和 DDNS 服务商。

## 安装 Agent

在面板「系统设置 -> Agent Token」中创建 Token，然后在被管理的 Linux 主机上执行：

```bash
curl -fsSL http://你的面板地址:3000/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

升级 Agent：

```bash
curl -fsSL http://你的面板地址:3000/api/agent/install.sh | bash -s -- upgrade YOUR_AGENT_TOKEN
```

卸载 Agent：

```bash
curl -fsSL http://你的面板地址:3000/api/agent/install.sh | bash -s -- uninstall
```

## 基本使用流程

1. 部署 ForwardX 面板并完成数据库初始化。
2. 在「系统设置」中创建 Agent Token。
3. 在被控服务器安装 Agent。
4. 在「主机管理」中确认 Agent 在线。
5. 在「隧道管理」中创建需要的 GOST 或 ForwardX 隧道。
6. 在「转发组」中按需创建主机组或隧道组。
7. 在「转发规则」中选择主机、隧道或转发组创建真实转发。
8. 在「系统日志」和转发组事件中观察 DDNS、故障转移和规则同步状态。

## 隧道说明

ForwardX 支持两类隧道：

- GOST 隧道：使用 GOST 提供的 TLS、WSS、TCP、MTLS、MWSS、MTCP 等模式。
- ForwardX 自定义加密隧道：由 ForwardX Agent 建立入口到出口的加密链路，支持 TCP/UDP、按规则流量统计和用户限速。

自定义加密隧道可以在入口和出口 Agent 下方指定出口 IP。不填写时默认走公网出口；填写内网 IP 时，会优先使用指定内网 IP 作为链路出口。

## Telegram 机器人

1. 在 Telegram 找到 `@BotFather` 创建机器人并复制 Bot Token。
2. 在面板「系统设置 -> 系统信息 -> Telegram 机器人」填写 Token 并启用；也可以通过环境变量 `TELEGRAM_BOT_TOKEN` 配置。
3. 用户登录面板后，在右下角用户菜单点击「绑定 Telegram」，再点击「使用 Telegram 绑定」。
4. Telegram 会打开机器人并携带一次性绑定码，点击 Start 即可完成绑定；也可以手动发送 `/bind 绑定码`。

绑定后可使用：

- `/usage`：查询自己的流量、到期时间、规则/端口配额。
- `/rules`：查看自己的转发规则。
- `/enable 规则ID`、`/disable 规则ID`：启用或停用自己的规则。
- `/login`：生成 5 分钟有效的一次性网页登录链接。
- `/unbind`：解除当前 Telegram 绑定。

管理员绑定 Telegram 后还可使用 `/users` 查看用户流量概览，使用 `/reset 用户ID` 重置指定用户流量。机器人采用 Telegram 长轮询，不需要配置 webhook；服务器需要能访问 `api.telegram.org`。

## 用户、套餐与支付

管理员可以：

- 控制访客是否开放注册，关闭后只能由管理员新增用户。
- 创建用户并设置总开关、到期时间、流量额度、规则数、端口数、连接数和 IP 接入限制。
- 分配可用主机和可用隧道。
- 创建套餐并配置价格、周期、流量、端口数和权限范围。
- 开启或关闭商店功能。
- 配置支付接口。商店开启后，用户在购买时选择管理员已启用的支付方式。
- 生成余额兑换码、套餐兑换码和折扣码。

商店默认关闭。关闭时，管理员可以手动给用户充值、分配套餐或调整权限。

## 流量与限制

- 流量按 Agent 上报的规则增量累计。
- 首页趋势图默认按 30 分钟聚合展示。
- TCPing 默认用于链路健康探测和延迟趋势展示。
- GOST 和 ForwardX 自定义加密隧道支持用户限速。
- `iptables`、`nftables`、`realm`、`socat` 当前主要用于转发和统计，不作为限速主路径。
- 连接数限制主要针对 TCP 生效；隧道转发按隧道维度聚合，端口转发按主机维度聚合。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 面板监听端口 |
| `DATABASE_CONFIG_PATH` | `/data/database.json` | 面板保存数据库连接配置的位置 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 默认数据文件路径 |
| `DATABASE_TYPE` / `DB_TYPE` | 空 | 可选，强制指定 `mysql`、`postgresql` 或 `sqlite` |
| `MYSQL_CONFIG_PATH` | `/data/mysql.json` | 兼容旧版 MySQL 配置文件路径 |
| `MYSQL_URL` | 空 | 可选，通过环境变量直接提供 MySQL 连接串 |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | 空 | 可选，通过环境变量提供 MySQL 连接信息 |
| `MYSQL_SSL` | `false` | MySQL 是否启用 SSL |
| `POSTGRES_URL` / `POSTGRESQL_URL` / `PG_URL` | 空 | 可选，通过环境变量直接提供 PostgreSQL 连接串 |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DATABASE` | 空 | 可选，通过环境变量提供 PostgreSQL 连接信息 |
| `POSTGRES_SSL` | `false` | PostgreSQL 是否启用 SSL |
| `JWT_SECRET` | `change-me-to-a-random-string` | 登录签名密钥，生产环境必须修改 |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram 机器人 Token |
| `FORWARDX_IMAGE` | `ghcr.io/poouo/forwardx:latest` | Docker 部署使用的预编译镜像 |
| `FORWARDX_TARGET_VERSION` | 空 | 本地非 Docker 部署可指定安装或升级版本，例如 `v2.3.12`；Docker 部署固定使用 `latest` 镜像 |

## 手动 Docker Compose

```bash
git clone https://github.com/poouo/Forwardx.git
cd Forwardx
docker compose -p forwardx pull forwardx
docker compose -p forwardx up -d
```

Docker Compose 默认会拉取 GitHub Packages 上的预编译镜像 `ghcr.io/poouo/forwardx:latest`，服务器本地不需要再执行镜像编译。
手动升级时重新拉取 `latest` 并重启容器即可，数据卷会保留：

```bash
git fetch --force --prune origin "+refs/heads/*:refs/remotes/origin/*" "+refs/tags/*:refs/tags/*"
git checkout main
docker compose -p forwardx pull forwardx
docker compose -p forwardx up -d --remove-orphans
```

## 本地开发

```bash
pnpm install
pnpm dev
```

构建与版本校验：

```bash
pnpm build
pnpm check:versions
```

## Android APK

ForwardX Android 客户端用于手机端访问面板，登录时填写面板地址、账号和密码即可。

下载地址：
https://github.com/poouo/Forwardx/releases/download/v2.3.130/forwardx-android-v2.3.42.apk

常用命令：

```bash
pnpm mobile:sync:android
pnpm mobile:apk
```

## 安全建议

- 使用强密码注册管理员账户。
- 生产环境关闭不需要的开放注册。
- 设置随机 `JWT_SECRET`。
- 使用 MySQL 或 PostgreSQL 时建议设置独立账号，并只授予 ForwardX 所需数据库权限。
- 定期备份 MySQL/PostgreSQL 数据库或 SQLite 数据文件。
- 使用防火墙或反向代理限制面板访问范围。
- 妥善保存 Agent Token，泄露后应立即禁用并重新生成。
- DDNS Token 建议只授予目标域名所需的最小权限。

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=poouo/Forwardx&type=Date)](https://www.star-history.com/#poouo/Forwardx&Date)

## V我50喝咖啡

USDT：
TRON ：`TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana ：`8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain ：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`
