# ForwardX

ForwardX 是一个面向 Linux 服务器的端口转发与隧道管理面板。它通过 Agent 管理多台主机，支持端口转发、隧道转发、用户权限、套餐订阅、流量统计、支付接入、公告和在线升级。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

## 主要功能

- 多主机 Agent 管理，无需在面板保存 SSH 密钥。
- 支持 TCP、UDP、TCP+UDP 端口转发。
- 支持 `iptables`、`realm`、`socat`、`gost` 等转发方式。
- 支持 GOST 隧道和 ForwardX 自定义加密隧道。
- 支持按规则、按用户统计流量，并展示最近 24 小时趋势。
- 支持主机 CPU、内存、硬盘、网络吞吐和在线状态展示。
- 支持用户到期时间、流量额度、端口数、规则数、主机权限和隧道权限管理。
- 支持套餐、余额、兑换码、折扣码、商店开关和支付方式配置。
- 支持邮件验证码、套餐到期提醒和流量不足提醒。
- 支持 Telegram 机器人绑定、用量查询、规则开关和一次性网页登录。
- 支持面板和 Agent 在线升级。

## 数据库说明

ForwardX 首次部署时可以选择 SQLite 或 MySQL：

- SQLite 适合单机轻量部署，默认数据文件为 `/data/forwardx.db` 或本地安装目录下的 `data/forwardx.db`。
- MySQL 适合生产环境、长期运维和跨机器迁移。
- 首次打开面板会进入初始化向导，先选择数据库，再选择新面板或从旧面板迁移。
- 如果连接的是已有数据库，且里面已经存在管理员账户，会直接进入登录流程，不会要求重新注册。
- 原地升级会保留已有配置和数据；Docker 部署会保留数据卷，本地 systemd 部署会保留安装目录下的 `data` 目录。
- 不再提供旧版 JSON 备份/恢复入口；数据库备份建议由用户在 SQLite 文件或 MySQL 侧自行维护。

## 部署面板

面板默认监听 `3000` 端口。

以下命令请以 `root` 用户执行；如果当前不是 `root`，把命令中的 `bash` 替换为 `sudo bash`。已经是 `root` 时不要再加 `sudo`，否则部分系统会出现 `sudo: unable to resolve host ...` 的主机名解析警告。

### 本地 systemd 部署

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

- 安装目录：`/opt/forwardx-panel`
- 服务名称：`forwardx-panel.service`
- 数据库配置文件：`/opt/forwardx-panel/data/database.json`
- SQLite 数据文件：`/opt/forwardx-panel/data/forwardx.db`

### Docker Compose 部署

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

## 首次初始化

1. 访问 `http://服务器IP:3000`。
2. 选择 SQLite 或 MySQL，并完成连接检测。
3. 选择作为新面板使用，或输入旧面板地址和管理员账户发起迁移。
4. 如果是新库，注册第一个管理员账户；如果是旧库或迁移完成，直接使用原管理员账户登录。
5. 登录后建议在系统设置中配置面板公开地址、邮件和 Agent Token。

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

## 安装 Agent

在面板「系统设置 -> Agent Token」中创建 Token，然后在被管理的 Linux 主机上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
  PANEL_URL="http://你的面板地址:3000" bash -s -- install YOUR_AGENT_TOKEN
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
5. 在「转发规则」中创建端口转发。
6. 需要跨机器转发时，先在「隧道管理」中创建隧道，再创建隧道转发规则。

## 隧道说明

ForwardX 支持两类隧道：

- GOST 隧道：使用 GOST 提供的 TLS、WSS、TCP、MTLS、MWSS、MTCP 等模式。
- ForwardX 自定义加密隧道：由 ForwardX Agent 建立入口到出口的加密链路，支持 TCP/UDP、按规则流量统计和用户限速。

如果只是普通端口转发，可以直接创建端口转发规则。如果入口和出口不在同一台机器，建议使用隧道转发。

## 用户、套餐与支付

管理员可以：

- 创建用户并设置总开关。
- 设置用户到期时间、流量额度、规则数、端口数、连接数和 IP 接入限制。
- 分配可用主机和可用隧道。
- 创建套餐并配置价格、周期、流量、端口数和权限范围。
- 开启或关闭商店功能。
- 配置支付接口。商店开启后，用户在购买时选择管理员已启用的支付方式。
- 生成余额兑换码、套餐兑换码和折扣码。

商店默认关闭。关闭时，管理员可以手动给用户充值、分配套餐或调整权限。

## 流量与限制

- 流量按 Agent 上报的规则增量累计。
- 首页趋势图默认按 30 分钟聚合展示。
- GOST 和 ForwardX 自定义加密隧道支持用户限速。
- `iptables`、`realm`、`socat` 当前主要用于转发和统计，不作为限速主路径。
- 连接数限制主要针对 TCP 生效；隧道转发按隧道维度聚合，端口转发按主机维度聚合。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 面板监听端口 |
| `DATABASE_CONFIG_PATH` | `/data/database.json` | 面板保存数据库连接配置的位置 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 默认数据文件路径 |
| `DATABASE_TYPE` / `DB_TYPE` | 空 | 可选，强制指定 `mysql` 或 `sqlite` |
| `MYSQL_CONFIG_PATH` | `/data/mysql.json` | 兼容旧版 MySQL 配置文件路径 |
| `MYSQL_URL` | 空 | 可选，通过环境变量直接提供 MySQL 连接串 |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | 空 | 可选，通过环境变量提供 MySQL 连接信息 |
| `MYSQL_SSL` | `false` | MySQL 是否启用 SSL |
| `JWT_SECRET` | `change-me-to-a-random-string` | 登录签名密钥，生产环境必须修改 |
| `FORWARDX_TARGET_VERSION` | 空 | 安装或升级到指定版本，例如 `v2.2.52` |

## 手动 Docker Compose

```bash
git clone https://github.com/poouo/Forwardx.git
cd Forwardx
docker compose -p forwardx up -d --build
```

手动升级：

```bash
git fetch --tags origin
git checkout v2.2.52
docker compose -p forwardx up -d --build --remove-orphans
```

## 安全建议

- 使用强密码注册管理员账户。
- 设置随机 `JWT_SECRET`。
- 使用 MySQL 时建议设置独立账号，并只授予 ForwardX 所需数据库权限。
- 定期备份 MySQL 数据库或 SQLite 数据文件。
- 使用防火墙或反向代理限制面板访问范围。
- 妥善保存 Agent Token，泄露后应立即禁用并重新生成。

## License

MIT
