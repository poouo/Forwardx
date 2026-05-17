# ForwardX

ForwardX 是一个面向 Linux 服务器的端口转发和隧道管理面板。它通过 Agent 管理多台主机，支持端口转发、加密隧道、用户权限、套餐订阅、流量统计和在线升级。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

## 主要功能

- 多主机 Agent 管理，不需要在面板保存 SSH 密钥。
- 支持 TCP、UDP、TCP+UDP 端口转发。
- 支持 `iptables`、`realm`、`socat`、`gost` 等转发方式。
- 支持 GOST 隧道和 ForwardX 自定义加密隧道。
- 支持按规则、按用户统计流量，并展示近 24 小时趋势。
- 支持主机 CPU、内存、硬盘、网络吞吐、在线状态展示。
- 支持用户到期时间、流量额度、端口数、规则数、主机/隧道权限管理。
- 支持套餐管理、商店开关和支付方式配置。
- 支持面板和 Agent 在线升级。

## 部署面板

推荐使用一键脚本部署。面板默认监听 `3000` 端口。

### 本地 systemd 部署

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- install
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo bash -s -- uninstall
```

本地部署默认路径：

- 安装目录：`/opt/forwardx-panel`
- 服务名称：`forwardx-panel.service`
- 数据库：`/opt/forwardx-panel/data/forwardx.db`

### Docker Compose 部署

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- install
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo bash -s -- uninstall
```

Docker 部署默认路径：

- 安装目录：`/opt/forwardx-docker`
- 容器名称：`forwardx-panel`
- 数据卷：`forwardx_forwardx-data`

## 默认登录信息

```text
访问地址：http://服务器IP:3000
用户名：admin
密码：admin123
```

首次登录后请立即修改管理员密码。生产环境建议同时设置 `JWT_SECRET` 和 `ADMIN_PASSWORD`。

## 安装 Agent

在面板「系统设置 -> Agent Token」中创建 Token，然后在被管理的 Linux 主机上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
  PANEL_URL="http://你的面板地址:3000" bash -s -- install YOUR_AGENT_TOKEN
```

Agent 默认以 `forwardx-agent.service` 运行。

升级 Agent：

```bash
curl -fsSL http://你的面板地址:3000/api/agent/install.sh | bash -s -- upgrade YOUR_AGENT_TOKEN
```

卸载 Agent：

```bash
curl -fsSL http://你的面板地址:3000/api/agent/install.sh | bash -s -- uninstall
```

## 基本使用流程

1. 部署并登录 ForwardX 面板。
2. 在「系统设置」中创建 Agent Token。
3. 在被控服务器安装 Agent。
4. 在「主机管理」中确认 Agent 在线。
5. 在「转发规则」中创建端口转发。
6. 需要跨机器转发时，先在「隧道管理」中创建隧道，再创建隧道转发规则。

## 隧道说明

ForwardX 支持两类隧道：

- GOST 隧道：使用 GOST 提供的 TLS、WSS、TCP、MTLS、MWSS、MTCP 等模式。
- ForwardX 自定义加密隧道：由 ForwardX Agent 建立入口到出口的加密链路，支持 TCP/UDP、按规则流量统计和用户限速。

如果只是普通端口转发，可以直接选择端口转发规则。如果入口和出口不在同一台机器，建议使用隧道转发。

## 用户、套餐与支付

管理员可以：

- 创建用户并设置总开关。
- 设置用户到期时间、流量额度、规则数、端口数、连接数和 IP 接入限制。
- 分配可用主机和可用隧道。
- 创建套餐并配置价格、周期、流量、端口数和权限范围。
- 开启或关闭商店功能。
- 配置支付接口。商店开启后，用户在购买时选择管理员已启用的支付方式。

商店默认关闭。关闭时，管理员可以手动给用户分配套餐或权限。

## 流量与限制说明

- 流量按 Agent 上报的规则增量累计。
- 首页趋势图默认按 30 分钟聚合展示。
- GOST 和 ForwardX 自定义加密隧道支持用户限速。
- `iptables`、`realm`、`socat` 当前主要用于转发和统计，不作为限速主路径。
- 连接数限制主要针对 TCP 生效。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 面板监听端口 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 数据库路径 |
| `JWT_SECRET` | `change-me-to-a-random-string` | 登录签名密钥，生产环境必须修改 |
| `ADMIN_PASSWORD` | `admin123` | 默认管理员密码 |
| `FORWARDX_TARGET_VERSION` | 空 | 安装或升级到指定版本，例如 `v2.2.41` |

## 手动 Docker Compose

```bash
git clone https://github.com/poouo/Forwardx.git
cd Forwardx
docker compose -p forwardx up -d --build
```

手动升级：

```bash
git fetch --tags origin
git checkout v2.2.41
docker compose -p forwardx up -d --build --remove-orphans
```

## 安全建议

- 修改默认管理员密码。
- 设置随机 `JWT_SECRET`。
- 使用防火墙或反向代理限制面板访问范围。
- 妥善保存 Agent Token，泄露后应立即禁用并重新生成。
- 定期备份 SQLite 数据库。

## License

MIT
