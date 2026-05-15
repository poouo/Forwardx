<div align="center">

# ForwardX

**Linux 端口转发集中管理面板**

轻量、现代、开箱即用的端口转发管理方案，支持 `iptables`、`realm`、`socat`、`gost` 四种转发引擎，并通过 Agent 实现多主机统一管理。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

</div>

---

## 功能特性

- 多引擎端口转发：支持 `iptables`、`realm`、`socat`、`gost`
- 多主机 Agent 管理：面板通过 Agent 心跳下发规则，不需要 SSH 密钥
- TCP / UDP / Both 协议支持
- 规则启停、编辑、删除和运行状态同步
- 主机 CPU、内存、网络、磁盘指标上报
- 端口流量统计和趋势图
- 用户流量额度、到期时间、规则数量和端口数量限制
- 管理员 / 普通用户权限隔离
- Agent 主机授权、端口范围限制、入口 IP/域名配置
- 配置导入导出，便于迁移和备份
- 明暗主题和移动端适配

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Recharts |
| 后端 | Node.js 22 + Express + tRPC 11 |
| 数据库 | SQLite + better-sqlite3 + Drizzle ORM |
| 构建 | Vite + esbuild |
| 部署 | 本地 systemd 或 Docker Compose |
| Agent | Go 常驻程序 + Shell 安装/升级脚本 |

## 快速开始

ForwardX 面板提供两种部署方式：

- **本地部署**：面板运行在宿主机 systemd 中，后台「版本升级」可以直接执行一键升级。
- **Docker 部署**：面板运行在 Docker Compose 中，升级脚本在宿主机执行，会覆盖旧容器并以同名容器重新启动。

### 本地部署

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

本地部署默认安装到 `/opt/forwardx-panel`，创建 `forwardx-panel.service`，数据库位于 `/opt/forwardx-panel/data/forwardx.db`。脚本会写入 `FORWARDX_UPGRADE_COMMAND`，所以后台版本升级按钮可以自动拉取新版本、构建并重启面板服务。

### Docker 部署

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

Docker 部署默认安装到 `/opt/forwardx-docker`，使用 Compose 项目名 `forwardx` 和容器名 `forwardx-panel`。升级脚本会拉取最新 tag，删除旧的 `forwardx-panel` 容器，并执行：

```bash
docker compose -p forwardx up -d --build --remove-orphans forwardx
```

默认不会删除 `forwardx-data` 数据卷。

### 默认登录信息

面板默认运行在：

```text
http://your-server-ip:3000
```

| 字段 | 值 |
|------|-----|
| 用户名 | `admin` |
| 密码 | `admin123` |

首次登录后请立即修改管理员密码，或在安装前通过环境变量 `ADMIN_PASSWORD` 自定义默认密码。生产环境建议同时设置 `JWT_SECRET`。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 面板监听端口 |
| `SQLITE_PATH` | `/data/forwardx.db` 或本地安装目录下的 `data/forwardx.db` | SQLite 数据库路径 |
| `JWT_SECRET` | `change-me-to-a-random-string` | JWT 签名密钥，生产环境必须修改 |
| `ADMIN_PASSWORD` | `admin123` | 管理员默认密码，服务启动时会同步到 admin 账号 |
| `NODE_ENV` | `production` | 运行环境 |
| `FORWARDX_UPGRADE_COMMAND` | 空 | 本地部署脚本会自动配置为 `/bin/bash .../install-panel-local.sh upgrade`，用于后台一键升级 |

## 部署 Agent

在面板的 **设置 -> Agent Token** 页面生成 Token，然后在目标 Linux 主机执行：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
  PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_AGENT_TOKEN
```

升级 Agent：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | bash -s -- upgrade
```

卸载 Agent：

```bash
curl -fsSL http://your-panel:3000/api/agent/install.sh | bash -s -- uninstall
```

Agent 默认以 `forwardx-agent.service` 运行，每 30 秒向面板发送心跳。规则变更、Agent 升级任务、连通性自测任务都会通过心跳响应下发。

## 从源码构建

```bash
pnpm install
pnpm build
pnpm start
```

开发模式：

```bash
pnpm dev
```

## 构建 Agent 发布二进制

```bash
bash scripts/build-agent-release.sh v2.1.27
```

产物位于：

```text
dist/agent/forwardx-agent-linux-amd64
dist/agent/forwardx-agent-linux-arm64
dist/agent/SHA256SUMS
```

推送 `v*.*.*` tag 后，GitHub Actions 会自动构建并上传 Agent 二进制到对应 Release。

## 项目结构

```text
.
├── agent/                  # Go Agent
├── client/                 # React 前端
├── drizzle/                # 数据库 schema
├── scripts/                # 面板与 Agent 一键脚本
├── server/                 # Express / tRPC 后端
├── shared/                 # 共享常量和类型
├── docker-compose.yml
├── Dockerfile
└── package.json
```

## 安全说明

- 生产环境请修改 `JWT_SECRET` 和 `ADMIN_PASSWORD`
- Docker 部署不再要求面板容器挂载 Docker socket
- Docker 面板升级请在宿主机执行 `install-panel-docker.sh upgrade`
- Agent 与面板通信使用 AES-256-CTR + HMAC-SHA256 加密

## License

MIT
