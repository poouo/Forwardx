# ForwardX 架构说明

本文面向开发和排障，说明当前代码结构、运行链路和主要边界。

## 总览

ForwardX 由四个部分组成：

- Web 面板：React + Vite，负责管理界面、用户操作和数据展示。
- 面板服务端：Express + tRPC + MySQL，负责鉴权、规则管理、Agent 指令、支付、公告和统计聚合。
- Agent：Go 程序，运行在受控 Linux 主机上，负责转发、隧道、iptables 计数、主机指标和升级。
- 发布脚本：负责面板/Agent 安装升级，以及 GitHub Release 中的 Agent 预编译包。

简化数据流：

```text
Browser -> /api/trpc -> Panel Server -> MySQL
Panel Server -> /api/agent/events -> Agent refresh/upgrade
Agent -> /api/agent/heartbeat -> actions
Agent -> /api/agent/traffic -> traffic stats
Agent -> /api/agent/tcping -> latency stats
Agent -> iptables / realm / socat / gost / ForwardX tunnel runtime
```

## 首次启动和数据库

ForwardX 只使用用户提供的 MySQL 数据库：

- `server/dbRuntime.ts` 负责读取 MySQL 配置、测试连接、创建连接池和 Drizzle 实例。
- `server/dbSchema.ts` 负责在已连接的 MySQL 上创建缺失的数据表。
- `server/db.ts` 负责数据库初始化和仓储 facade。
- `server/routers/setup.ts` 提供首次配置 MySQL 和创建首个管理员的公开接口。

启动时如果没有 MySQL 配置，面板会继续运行并显示初始化页面。连接旧数据库时，如果已有管理员账户，不会要求重新注册管理员。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `client/src` | 前端页面、布局、UI 组件、tRPC client |
| `server/index.ts` | HTTP 启动入口、Express 中间件、静态资源、路由挂载 |
| `server/scheduler.ts` | 后台定时任务：流量重置、到期检查、自测超时、TCPing 清理、邮件提醒 |
| `server/routers.ts` | tRPC 根路由组合层 |
| `server/routers/*` | 鉴权、初始化、仪表盘、用户、主机、规则、隧道、套餐、Token、公告 |
| `server/agentRoutes.ts` | Agent 专用 HTTP API |
| `server/agentEvents.ts` | Agent SSE 连接、刷新推送、升级推送、前台指标观察状态 |
| `server/agentInstallScripts.ts` | Agent 安装/升级脚本生成器 |
| `server/db.ts` | 数据访问 facade，对外保持原 `db` API |
| `server/dbRuntime.ts` | MySQL/Drizzle 连接生命周期、配置读写、统一时间函数 |
| `server/dbSchema.ts` | MySQL 建表 SQL |
| `server/email.ts` | SMTP 配置读取和邮件发送 |
| `server/payment.ts` | 支付配置、下单、回调和支付方式查询 |
| `server/_core` | tRPC、上下文、cookie、系统版本、面板日志等基础设施 |
| `drizzle/schema.ts` | Drizzle 类型化 schema |
| `agent/main.go` | Go Agent 主程序 |
| `scripts` | 面板/Agent 安装升级脚本、Agent release 构建脚本 |
| `docs` | 运维、架构和支付说明 |

## tRPC API

`server/routers.ts` 只组合各业务 router，前端调用路径保持稳定：

- `setup.ts`：首次 MySQL 配置、连接测试、首个管理员创建。
- `auth.ts`：登录、注册、邮箱验证码、个人资料。
- `dashboard.ts`：首页统计、全局流量和延迟曲线。
- `users.ts`：用户、流量、权限、开关。
- `hosts.ts`：主机管理、指标观察、Agent 升级。
- `rules.ts`：转发规则、端口检查、自测、规则流量和延迟。
- `tunnels.ts`：隧道管理、隧道链路测试。
- `plans.ts`：套餐、商店、用户订阅。
- `billing.ts`：余额、账单、兑换码、折扣码。
- `announcements.ts`：登录公告和普通公告。
- `agentTokens.ts`：Agent Token 和安装脚本。

## Agent API

`server/agentRoutes.ts` 处理 Agent HTTP 通道：

- `GET /api/agent/events`：SSE 长连接，用于刷新和升级。
- `POST /api/agent/register`：Agent 注册。
- `POST /api/agent/heartbeat`：Agent 心跳并拉取动作。
- `POST /api/agent/rule-status`：规则/隧道状态回报。
- `POST /api/agent/traffic`：流量统计上报。
- `POST /api/agent/tcping`：延迟统计上报。
- `GET /api/agent/install.sh`：返回安装脚本入口。

Agent POST 接口要求加密信封，逻辑在 `server/agentCrypto.ts`。SSE 状态在 `server/agentEvents.ts`，脚本生成在 `server/agentInstallScripts.ts`。

## 数据库约定

- MySQL 是唯一数据源，备份/恢复由用户在 MySQL 侧维护。
- 时间字段以 Unix epoch 秒保存，应用层映射为 `Date`。
- 金额以分为单位保存，流量以字节为单位保存。
- 统计类查询中进入 `sql.raw` 的 bucket 参数必须先 clamp。
- 首次初始化只创建缺失表，不会重置已有管理员和业务数据。

## Agent 行为

Agent 主循环：

1. 读取 `/etc/forwardx/agent/config.json`。
2. 注册或心跳到面板。
3. 保持 SSE 事件连接，收到刷新/升级事件后加速心跳。
4. 执行动作：iptables、realm、socat、gost 或 ForwardX 隧道。
5. 定期上报主机指标、流量和 TCPing 结果。

Agent 本地状态主要在：

- `/var/lib/forwardx-agent/port_<port>.rule`
- `/var/lib/forwardx-agent/target_<port>.info`
- `/var/lib/forwardx-agent/traffic_<port>.prev`

流量统计依赖 iptables mangle 计数链。`realm/socat/gost` 这类本机监听进程统计相对直接；纯 `iptables` DNAT 的回包统计需要更谨慎，因为回包端口可能已经不是入口端口。

## 继续拆分建议

- `server/routers/rules.ts` 仍然偏大，可以继续拆成端口校验、自测、流量统计、规则 CRUD。
- `server/agentRoutes.ts` 仍包含较多 Agent 动作生成逻辑，可以继续拆成 heartbeat action builder、traffic reporter、tcping reporter。
- 支付和套餐功能已经较多，后续可把支付回调、余额流水、兑换码、折扣码拆成更细的领域模块。
