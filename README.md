# ForwardX

ForwardX 是一个面向 Linux 服务器的端口转发集中管理面板。你可以在一个网页里管理多台 Agent 主机，创建端口转发规则，查看连通状态、流量统计和用户用量。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

## 功能亮点

- 多主机 Agent 集中管理，不需要在面板保存 SSH 密钥。
- 支持 TCP、UDP 和 TCP+UDP 端口转发。
- 支持 `iptables`、`realm`、`socat`、`gost` 等转发方式。
- 支持两台 Agent 组成隧道转发链路。
- 支持 ForwardX 自定义加密隧道，适合需要入口到出口加密传输的场景。
- 支持转发规则启停、编辑、删除、端口检测和链路自测。
- 支持主机 CPU、内存、网络、磁盘状态展示。
- 支持按规则、按用户统计流量。
- 支持用户流量额度、到期时间、规则数量、端口数量和可用主机限制。
- 支持面板和 Agent 在线升级。

## 部署方式

ForwardX 面板推荐使用一键脚本部署。你可以选择本地 systemd 部署，也可以选择 Docker 部署。

### 方式一：本地部署

适合希望面板直接运行在宿主机 systemd 中的用户。

安装：

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

本地部署默认安装到 `/opt/forwardx-panel`，服务名为 `forwardx-panel.service`，数据库位于 `/opt/forwardx-panel/data/forwardx.db`。

### 方式二：Docker 部署

适合希望面板运行在 Docker Compose 中的用户。

安装：

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

Docker 部署默认安装到 `/opt/forwardx-docker`，容器名为 `forwardx-panel`，数据保存在 Docker volume `forwardx_forwardx-data` 中。升级脚本会拉取最新版本，删除同名旧容器，然后重新构建并启动新容器，默认不会删除数据卷。

## 默认登录信息

面板默认访问地址：

```text
http://服务器IP:3000
```

默认账号：

```text
用户名：admin
密码：admin123
```

首次登录后请立即修改管理员密码。生产环境建议设置 `JWT_SECRET` 和 `ADMIN_PASSWORD`。

## 安装 Agent

在面板的「系统设置 -> Agent Token」页面创建 Token，然后到需要被管理的 Linux 主机执行：

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
2. 在「Agent Token」中创建 Token。
3. 在被控服务器上安装 Agent。
4. 在「主机管理」中确认 Agent 在线。
5. 在「转发规则」中创建端口转发。
6. 如需跨机器链路，先在「隧道管理」中创建隧道，再在转发规则中选择该隧道。

## 隧道说明

ForwardX 支持两类隧道：

- GOST 隧道：使用 GOST 提供的 TLS、WSS、TCP、MTLS、MWSS、MTCP 等协议。
- ForwardX 自定义加密隧道：由 ForwardX Agent 直接建立入口到出口的加密链路，支持 TCP/UDP、按规则统计流量和按用户限速。

普通用户只需要根据实际网络环境选择即可。如果不确定，建议优先尝试 ForwardX 自定义加密隧道。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 面板监听端口 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 数据库路径 |
| `JWT_SECRET` | `change-me-to-a-random-string` | 登录签名密钥，生产环境必须修改 |
| `ADMIN_PASSWORD` | `admin123` | 默认管理员密码 |
| `FORWARDX_TARGET_VERSION` | 空 | 安装或升级到指定版本，例如 `v2.2.30` |

## Docker Compose

如果你不使用一键脚本，也可以手动执行：

```bash
git clone https://github.com/poouo/Forwardx.git
cd Forwardx
docker compose -p forwardx up -d --build
```

手动升级：

```bash
git fetch --tags origin
git checkout v2.2.30
docker compose -p forwardx up -d --build --remove-orphans
```

## 安全建议

- 生产环境请修改默认管理员密码。
- 生产环境请设置随机 `JWT_SECRET`。
- 面板端口建议通过防火墙或反向代理限制访问范围。
- Agent Token 请妥善保存，泄露后应立即禁用并重新生成。

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=poouo/Forwardx&type=Date)](https://star-history.com/#poouo/Forwardx&Date)

## License

MIT
