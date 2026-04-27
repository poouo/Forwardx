<div align="center">

# ForwardX

**Linux 端口转发集中管理面板**

轻量、现代、开箱即用的端口转发管理方案，支持 iptables / realm / socat 三种转发引擎，
通过 Agent 实现多主机统一管控。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

[English](#english) · [功能特性](#功能特性) · [快速开始](#快速开始) · [使用指南](#使用指南) · [项目架构](#项目架构) · [贡献指南](CONTRIBUTING.md)

</div>

---

## 功能特性

### 多引擎转发

ForwardX 支持三种主流端口转发工具，可根据场景灵活选择：

| 转发引擎 | 协议支持 | 特点 |
|---------|---------|------|
| **iptables** | TCP / UDP / Both | 内核级 DNAT 转发，性能最优，零额外依赖 |
| **realm** | TCP / UDP / Both | 用户态高性能代理，支持零拷贝，Agent 自动下载安装 |
| **socat** | TCP / UDP / Both | 通用网络瑞士军刀，兼容性最广 |

### 核心能力

| 功能模块 | 说明 |
|---------|------|
| **仪表盘** | 关键指标总览、主机在线率/规则活跃率环形图、最近主机与规则列表 |
| **多主机管理** | 通过 Agent 统一管控多台 Linux 服务器，支持主控机/被控机角色 |
| **转发规则** | 可视化创建/编辑/启停转发规则，支持三种引擎和 TCP/UDP/Both 协议 |
| **实时监控** | Agent 周期性上报 CPU、内存、网络、磁盘等主机指标 |
| **流量统计** | 基于 iptables 计数链精确统计每条规则的入向/出向流量，支持趋势图表 |
| **流量管理** | 支持用户流量额度限制、到期时间设置、流量自动/手动重置 |
| **连通性检测** | 一键自测转发链路，检测目标可达性和 ping 延迟 |
| **多用户权限** | 管理员/普通用户角色分离，支持开放注册和细粒度权限控制（如限制添加规则） |
| **端口管理** | 支持主机端口区间限制，添加规则时自动检测端口占用并支持随机分配 |
| **配置导入导出** | 支持 JSON 格式的规则和主机配置备份与恢复 |
| **暗色主题** | 内置亮色/暗色主题切换，跟随系统偏好 |

### Agent 架构

ForwardX 采用 **Agent 轮询架构**，无需在面板服务器上配置 SSH 密钥：

```
┌─────────────┐    心跳/上报     ┌──────────────┐
│  Agent 主机  │ ──────────────→ │  ForwardX    │
│  (Shell脚本) │ ←────────────── │  面板服务器   │
└─────────────┘   规则下发/响应   └──────────────┘
                                       │
                                  SQLite 存储
                                       │
                                 ┌─────────────┐
                                 │  Web 浏览器  │
                                 │  (React SPA) │
                                 └─────────────┘
```

1. 面板生成 Agent Token，通过一键安装脚本部署到目标主机
2. Agent 以 systemd 服务运行，每 30 秒向面板心跳上报状态
3. 面板通过心跳响应下发转发规则变更，Agent 本地执行
4. 流量数据、主机指标、自测结果均通过 Agent 主动上报

## 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Recharts |
| **后端** | Node.js 22 + Express + tRPC 11 |
| **数据库** | SQLite (better-sqlite3) + Drizzle ORM |
| **构建** | Vite 6 (前端) + esbuild (后端) |
| **部署** | Docker + Docker Compose |
| **Agent** | 纯 Shell 脚本，零依赖（仅需 curl + jq） |

## 快速开始

### Docker 部署（推荐）

```bash
# 克隆项目
git clone https://github.com/your-username/forwardx.git
cd forwardx

# 复制环境变量配置
cp .env.example .env

# 编辑配置（建议修改 JWT_SECRET）
nano .env

# 启动服务
docker compose up -d
```

面板默认运行在 `http://your-server-ip:3000`，默认管理员账户：

| 字段 | 值 |
|------|-----|
| 用户名 | `admin` |
| 密码 | `admin123` |

> **安全提示**：首次登录后请立即修改管理员密码，或通过环境变量 `ADMIN_PASSWORD` 自定义默认密码。每次服务启动时，admin 账户的密码会自动重置为 `ADMIN_PASSWORD` 的值。

### 从源码构建

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建生产版本
pnpm build

# 启动生产服务
pnpm start
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 面板监听端口 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 数据库文件路径 |
| `JWT_SECRET` | `change-me-to-a-random-string` | JWT 签名密钥（**生产环境必须修改**） |
| `ADMIN_PASSWORD` | `admin123` | 管理员默认密码（每次启动自动重置） |
| `NODE_ENV` | `production` | 运行环境 |

## 使用指南

### 1. 部署 Agent

在面板的 **设置 → Agent Token** 页面生成 Token，然后在目标主机上执行一键安装命令：

```bash
# 安装 Agent
curl -fsSL http://your-panel:3000/api/agent/install.sh | bash -s -- \
  --url http://your-panel:3000 \
  --token YOUR_AGENT_TOKEN
```

安装脚本会自动完成以下操作：

- 安装依赖（curl、jq、iptables、iproute2）
- 下载并安装 realm 转发工具
- 创建 Agent 程序并配置 systemd 服务（`forwardx-agent.service`）
- 注册到面板并开始心跳上报

```bash
# 卸载 Agent
curl -fsSL http://your-panel:3000/api/agent/install.sh | bash -s -- uninstall

# 交互模式（不带参数，可选择安装或卸载）
curl -fsSL http://your-panel:3000/api/agent/install.sh | bash
```

### 2. 创建转发规则

1. 进入 **转发规则** 页面，点击 **添加规则**
2. 选择目标主机、转发工具（iptables / realm / socat）
3. 配置源端口、目标 IP、目标端口、协议类型
4. 默认随机分配源端口，也可手动指定（会自动检测端口占用）
5. 保存后规则将在下次 Agent 心跳时自动下发执行

### 3. 流量与权限管理

管理员可在 **用户管理** 页面对用户进行详细配置：

- **流量限额** — 支持 GB/TB 级别设置，超额后自动禁用该用户的所有规则
- **到期时间** — 到期后自动禁用规则
- **自动重置** — 可设置每月指定日期自动清零已用流量
- **权限控制** — 可单独控制用户是否允许添加新规则

### 4. 连通性检测

在规则列表中点击自测按钮，Agent 会执行以下检测：

- **本地监听检测**（仅供参考）— 检查端口是否在监听
- **目标可达** — 检测目标 IP:Port 是否可达，作为连通性判定依据
- **目标延迟** — ping 目标 IP 的平均延迟（ms），按延迟着色显示

### 5. 用户管理

- 管理员可在 **用户管理** 页面创建新用户，或提升/降级用户角色
- 普通用户只能管理自己创建的主机和规则
- 管理员可查看和管理所有资源

## Agent 通信协议

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/agent/register` | POST | Agent 注册，上报主机信息 |
| `/api/agent/heartbeat` | POST | 心跳上报，获取待执行命令 |
| `/api/agent/rule-status` | POST | 规则执行状态回调 |
| `/api/agent/traffic` | POST | 流量数据周期上报 |
| `/api/agent/selftest-result` | POST | 自测结果上报 |
| `/api/agent/install.sh` | GET | 安装/卸载引导脚本下载 |

## Agent 管理命令

```bash
# 查看 Agent 状态
systemctl status forwardx-agent

# 查看 Agent 日志
journalctl -u forwardx-agent -f

# 重启 Agent
systemctl restart forwardx-agent

# 停止 Agent
systemctl stop forwardx-agent
```

## 数据库

项目使用 Drizzle ORM 管理 SQLite 数据库 Schema：

```bash
# 生成迁移文件
pnpm db:generate

# 应用迁移
pnpm db:migrate
```

| 表名 | 说明 |
|------|------|
| `users` | 用户信息，含角色权限 |
| `hosts` | 主机信息，含连接方式和在线状态 |
| `forward_rules` | 转发规则，含运行状态 |
| `host_metrics` | 主机监控指标时序数据 |
| `traffic_stats` | 转发规则流量统计 |
| `agent_tokens` | Agent 认证令牌 |
| `forward_tests` | 转发自测任务与结果 |

## 项目结构

```
forwardx/
├── client/                  # 前端源码
│   └── src/
│       ├── components/      # UI 组件（shadcn/ui）
│       │   └── ui/          # 基础 UI 组件库
│       ├── pages/           # 页面组件
│       │   ├── Home.tsx     #   仪表盘
│       │   ├── Hosts.tsx    #   主机管理
│       │   ├── Rules.tsx    #   转发规则管理
│       │   ├── Users.tsx    #   用户管理
│       │   ├── Settings.tsx #   系统设置
│       │   └── Login.tsx    #   登录页
│       ├── contexts/        # React Context（主题等）
│       ├── hooks/           # 自定义 Hooks
│       └── lib/             # 工具函数（tRPC 客户端等）
├── server/                  # 后端源码
│   ├── index.ts             # 入口文件（Express + tRPC）
│   ├── routers.ts           # tRPC 路由定义
│   ├── agentRoutes.ts       # Agent HTTP API + 脚本生成
│   ├── db.ts                # SQLite 数据访问层
│   └── env.ts               # 环境变量解析
├── drizzle/                 # 数据库
│   └── schema.ts            # Drizzle ORM Schema 定义
├── shared/                  # 前后端共享代码
│   └── const.ts             # 共享常量
├── Dockerfile               # 多阶段 Docker 构建
├── docker-compose.yml       # Docker Compose 编排
├── .env.example             # 环境变量模板
└── package.json
```

## 系统要求

**面板服务器：**

- Docker 20+ 或 Node.js 22+
- 最低 512MB 内存

**Agent 目标主机：**

- Linux (Debian / Ubuntu / CentOS / Alpine 等)
- 需要 `curl`、`jq`、`iptables` 命令
- 使用 realm 引擎时 Agent 自动下载安装 realm 二进制
- 使用 socat 引擎时需预装 `socat`


## 常见问题

**Q: Agent 流量统计显示为 0？**

确保 Agent 版本为最新。旧版本中 realm/socat 转发的流量计数链挂载位置有误，导致用户态代理的流量无法统计。更新 Agent 后需重新应用规则以重建计数链。

**Q: 如何更新 Agent？**

在目标主机上重新执行安装命令即可，Agent 会自动覆盖更新。

**Q: 支持 IPv6 吗？**

目前仅支持 IPv4 转发。IPv6 支持计划在后续版本中加入。

**Q: 数据库如何备份？**

SQLite 数据库文件默认位于 Docker Volume 中的 `/data/forwardx.db`，可直接复制该文件进行备份。面板也支持通过设置页面导出/导入配置。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

## 贡献

欢迎提交 Issue 和 Pull Request！请阅读 [贡献指南](CONTRIBUTING.md) 了解详情。

---

<a id="english"></a>

<div align="center">

## English

</div>

### What is ForwardX?

ForwardX is a lightweight, modern, and self-hosted **Linux port forwarding management panel**. It provides a beautiful web UI to centrally manage port forwarding rules across multiple Linux servers through an Agent-based architecture.

### Key Features

- **Multi-engine support** — iptables (kernel-level DNAT), realm (high-performance userspace proxy), and socat (universal network tool)
- **Multi-host management** — Manage forwarding rules on multiple servers through a unified dashboard
- **Real-time monitoring** — CPU, memory, network metrics and per-rule traffic statistics with trend charts
- **Traffic management** — User traffic quotas, expiration dates, and auto/manual traffic reset
- **Port management** — Host port range limits, automatic port conflict detection, and random port assignment
- **Connectivity testing** — One-click link testing with target reachability and ping latency detection
- **Multi-user RBAC** — Admin and regular user roles with resource isolation
- **Config backup** — JSON-based import/export for rules and host configurations
- **Docker-ready** — One-command deployment with Docker Compose
- **Agent-based** — No SSH keys needed; lightweight shell-based agent with zero dependencies

### Quick Start

```bash
git clone https://github.com/your-username/forwardx.git
cd forwardx
docker compose up -d
```

Default login: `admin` / `admin123`

Visit `http://your-server-ip:3000` to access the panel.

### Deploy Agent

Generate an Agent Token in **Settings → Agent Token**, then run on the target host:

```bash
curl -fsSL http://your-panel:3000/api/agent/install.sh | bash -s -- \
  --url http://your-panel:3000 \
  --token YOUR_AGENT_TOKEN
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Recharts |
| **Backend** | Node.js 22 + Express + tRPC 11 |
| **Database** | SQLite (better-sqlite3) + Drizzle ORM |
| **Build** | Vite 6 (frontend) + esbuild (backend) |
| **Deploy** | Docker + Docker Compose |
| **Agent** | Pure Shell script, zero dependencies (only curl + jq) |

### License

[MIT](LICENSE)
