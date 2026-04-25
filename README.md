# PortFlow - 端口转发集中管理面板

PortFlow 是一个功能完整的 Linux 端口转发集中管理面板，支持 **iptables** 和 **realm** 两种转发工具，提供多主机管理、实时状态监控、多用户权限控制和带宽限速功能。

## 功能特性

### 核心功能

| 功能模块 | 说明 |
|---------|------|
| **仪表盘** | 关键指标总览、主机在线率/规则活跃率环形图、最近主机与规则列表 |
| **主机管理** | 支持主控机和被控机、SSH 和 Agent 两种接入方式、在线状态实时监控 |
| **转发规则** | iptables / realm 转发工具可选、TCP/UDP/Both 协议、启停控制 |
| **限速功能** | 每条转发规则支持独立的上行/下行带宽限制 (kbps) |
| **状态监控** | CPU / 内存 / 网络 / 磁盘使用率实时上报与展示 |
| **多用户** | 管理员和普通用户角色、权限隔离、用户管理 |
| **一键部署** | Agent 一键安装/卸载脚本自动生成、被控机快速接入 |

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + Tailwind CSS 4 + shadcn/ui |
| 后端 | Express + tRPC 11 + Drizzle ORM |
| 数据库 | SQLite (内置单文件存储) |
| 部署 | Docker + docker-compose |
| Agent | Bash Shell 脚本 + systemd 服务 |

## 快速部署

### 前置要求

- Docker 20.10+
- Docker Compose v2+
- 至少 512MB 可用内存

### 一键启动

```bash
# 克隆项目
git clone <your-repo-url> portflow
cd portflow

# 复制环境变量配置
cp .env.example .env

# 编辑配置（建议修改 JWT_SECRET）
nano .env

# 启动服务
docker-compose up -d
```

服务启动后访问 `http://your-server-ip:3000` 即可使用。

### 默认账户

系统内置一个默认管理员账户：
- **用户名**: `admin`
- **密码**: `admin123`（或通过 `ADMIN_PASSWORD` 环境变量自定义）

> **说明**：每次服务启动时，admin 账户的密码会自动重置为 `ADMIN_PASSWORD` 环境变量的值（默认 `admin123`）。如需在面板内修改密码并保持生效，请同时修改 `ADMIN_PASSWORD` 环境变量，否则下次重启后密码会被重置。

### 环境变量说明

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `SQLITE_PATH` | 否 | `/data/portflow.db` | SQLite 数据库文件路径，默认挂载在数据卷中 |
| `JWT_SECRET` | 是 | `change-me-to-a-random-string` | JWT 签名密钥，生产环境务必修改为强随机字符串 |
| `ADMIN_PASSWORD` | 否 | `admin123` | 默认管理员密码，每次启动时自动重置 admin 密码为此值 |
| `PORT` | 否 | `3000` | 面板监听端口 |
| `NODE_ENV` | 否 | `production` | 运行环境 |

### Docker Compose 配置

默认配置采用单容器部署，内置 SQLite 数据库，数据持久化到 Docker Volume 中。

```yaml
# 自定义端口映射
ports:
  - "8080:3000"  # 将面板映射到宿主机的 8080 端口

# 数据持久化目录
volumes:
  - portflow-data:/data
```

## 使用指南

### 1. 添加被控机（Agent 方式）

Agent 方式是推荐的被控机接入方式，通过轻量级 Shell 脚本实现自动注册和状态上报。

**步骤：**

1. 登录面板，进入 **系统设置** > **Agent Token** 标签页
2. 点击 **创建 Token**，填写描述信息
3. 复制生成的安装命令
4. 在被控机上以 root 权限执行安装命令：

```bash
# 安装 Agent
curl -sL http://your-panel:3000/api/agent/install.sh | PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_TOKEN

# 卸载 Agent
curl -sL http://your-panel:3000/api/agent/install.sh | bash -s -- uninstall

# 交互模式（不带参数，可选择安装或卸载）
curl -sL http://your-panel:3000/api/agent/install.sh | bash
```

**安装脚本**会自动完成以下操作：

- 安装依赖（curl、jq、iptables、iproute2）
- 安装 realm 转发工具
- 创建 Agent 程序并配置 systemd 服务
- 注册到面板并开始心跳上报

**卸载脚本**会自动完成以下操作：

- 停止并禁用 Agent 服务
- 删除服务文件和安装目录
- 清理所有 iptables 转发规则和 tc 限速规则
- 停止所有 realm 进程

### 2. 添加被控机（SSH 方式）

1. 进入 **主机管理** 页面
2. 点击 **添加主机**
3. 选择连接方式为 **SSH**
4. 填写主机 IP、SSH 端口、用户名和密码/密钥

### 3. 创建转发规则

1. 进入 **转发规则** 页面
2. 点击 **添加规则**
3. 选择目标主机、转发工具（iptables / realm）
4. 配置源端口、目标 IP、目标端口、协议类型
5. 可选设置上行/下行限速（kbps）
6. 保存后规则将在下次 Agent 心跳时自动下发执行

### 4. 限速配置

每条转发规则支持独立的带宽限制：

- **上行限速** - 限制从源端口发出的流量速率
- **下行限速** - 限制到达源端口的流量速率
- 单位为 kbps，设置为 0 表示不限速
- iptables 模式通过 tc (traffic control) 实现限速
- realm 模式暂不支持内置限速，建议使用 iptables 模式配合 tc 实现限速

### 5. 用户管理

- 默认管理员账户为 `admin` / `admin123`
- 管理员可在 **用户管理** 页面创建新用户，或提升/降级用户角色
- 普通用户只能管理自己创建的主机和规则

## Agent 通信协议

Agent 客户端通过 HTTP 长轮询方式与面板通信，主要接口如下：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/agent/register` | POST | Agent 注册，上报主机信息 |
| `/api/agent/heartbeat` | POST | 心跳上报，获取待执行命令 |
| `/api/agent/rule-status` | POST | 规则状态回调 |
| `/api/agent/traffic` | POST | 流量数据上报 |
| `/api/agent/install.sh` | GET | 安装/卸载引导脚本下载 |

心跳间隔默认为 30 秒。每次心跳时，面板会检查该主机的转发规则状态，将需要启动或停止的规则生成为 Shell 命令，通过心跳响应下发给 Agent 执行。

## 数据库迁移

项目使用 Drizzle ORM 管理 SQLite 数据库 Schema，支持版本化迁移。

```bash
# 生成迁移文件
pnpm db:generate

# 应用迁移
pnpm db:migrate
```

数据库表结构：

| 表名 | 说明 |
|------|------|
| `users` | 用户信息，含角色权限 |
| `hosts` | 主机信息，含连接方式和在线状态 |
| `forward_rules` | 转发规则，含限速和运行状态 |
| `host_metrics` | 主机监控指标时序数据 |
| `traffic_stats` | 转发规则流量统计 |
| `agent_tokens` | Agent 认证令牌 |
| `forward_tests` | 转发自测任务状态 |

## Agent 管理命令

```bash
# 查看 Agent 状态
systemctl status portflow-agent

# 查看 Agent 日志
journalctl -u portflow-agent -f

# 重启 Agent
systemctl restart portflow-agent

# 停止 Agent
systemctl stop portflow-agent

# 一键卸载 Agent（推荐）
curl -sL http://your-panel:3000/api/agent/install.sh | bash -s -- uninstall

# 手动卸载 Agent
systemctl stop portflow-agent
systemctl disable portflow-agent
rm -rf /opt/portflow-agent
rm -f /etc/systemd/system/portflow-agent.service
systemctl daemon-reload
```

## 项目结构

```
portflow/
├── client/                 # 前端源码
│   └── src/
│       ├── pages/          # 页面组件
│       ├── components/     # 通用组件
│       └── App.tsx         # 路由配置
├── server/                 # 后端源码
│   ├── routers.ts          # tRPC API 路由
│   ├── db.ts               # SQLite 数据库查询
│   └── agentRoutes.ts      # Agent HTTP API
├── drizzle/                # 数据库 Schema 与迁移
│   └── schema.ts           # 表结构定义
├── Dockerfile              # Docker 构建配置
├── docker-compose.yml      # Docker Compose 编排
└── .env.example            # 环境变量模板
```

## 许可证

MIT License
