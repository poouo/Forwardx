# ForwardX 架构说明

本文面向开发与排障，说明当前代码结构、数据流和运行边界。

## 系统组成

ForwardX 由四部分组成：

- Web 面板：React + Vite，负责管理界面和数据展示。
- 面板服务端：Express + tRPC，负责鉴权、资源管理、Agent 指令、支付和统计。
- Agent：Go 程序，运行在受控 Linux 主机上，负责转发运行时、主机指标、探测、流量计数和升级。
- 发布与安装脚本：构建并安装面板、Agent、Android 客户端和可选运行组件。

简化数据流：

```text
Browser -> tRPC / HTTP -> Panel Server -> SQLite / MySQL / PostgreSQL
Panel Server -> SSE event -> Agent wakes immediately
Agent -> heartbeat -> desired state / actions
Agent -> status / traffic / latency / self-test reports
Agent -> iptables / nftables / realm / socat / gost / ForwardX / nginx runtimes
```

## 数据库

ForwardX 支持 SQLite、MySQL 和 PostgreSQL：

- `server/dbRuntime.ts` 读取数据库配置，创建对应连接或连接池，并初始化 Drizzle。
- `server/dbCompat.ts` 统一标识符、布尔值、时间、分页和统计表达式的方言差异。
- `server/dbSchema.ts` 创建缺失表、列和索引。
- `server/db.ts` 负责启动初始化、一次性 backfill 和仓储 facade。
- `server/databaseSwitch.ts` 与 `server/migration.ts` 处理数据库切换和面板迁移。
- `server/routers/setup.ts` 提供首次配置、连接测试和管理员初始化接口。

没有有效数据库配置时，服务端仍可启动并显示初始化页。连接已有数据库且存在管理员时，初始化流程不会再次创建管理员。

数据库约定：

- 时间字段以 Unix epoch 秒保存，应用层映射为 `Date`。
- 金额以分为单位，流量以字节为单位。
- 原始 SQL 必须通过 `dbCompat` 处理数据库方言差异。
- 启动 backfill 使用设置标记保证幂等，不应在每次启动重复扫描全部历史数据。
- SQLite 文件、MySQL 实例和 PostgreSQL 实例分别由部署方备份。

## 请求与加载

列表页面采用服务端分页，避免一次读取和序列化完整数据集：

- 常规列表使用 `COUNT + LIMIT/OFFSET`，筛选条件在数据库执行。
- 地图等需要逐步扩展的数据使用游标分批加载。
- 下拉选择器使用轻量 options 接口，不返回证书、密钥或完整配置。
- 实时状态、流量和性能数据只补充当前页。
- 编辑、自测、批量导出等操作在用户触发时读取完整对象或完整筛选结果。

分页 DTO 和页码边界逻辑位于 `shared/pagination.ts`。Repository 负责筛选、计数和分页，Router 负责鉴权与输入校验，前端不再对完整集合做分页切片。

## 服务端目录

| 路径 | 职责 |
| --- | --- |
| `client/src` | 页面、布局、UI 组件和 tRPC client |
| `server/index.ts` | Express 启动、静态资源和路由挂载 |
| `server/routers.ts` | tRPC 根路由组合 |
| `server/routers/*` | 鉴权、输入校验和业务入口 |
| `server/repositories/*` | 数据查询、聚合和持久化 |
| `server/services/*` | 跨仓储业务流程 |
| `server/agentRoutes.ts` | Agent HTTP API 组合入口 |
| `server/agentHeartbeatRoute.ts` | Agent 心跳、期望状态和动作生成 |
| `server/agentReportRoutes.ts` | Agent 状态、流量和探测上报 |
| `server/agentEvents.ts` | Agent SSE 唤醒和升级事件 |
| `server/agentActionCommands.ts` | 端口转发运行命令生成 |
| `server/keyedTaskDispatcher.ts` | 同键有序、不同键受控并发 |
| `server/scheduler.ts` | 到期、流量、探测、通知和清理任务 |
| `server/payment.ts` | 支付配置、下单、回调和权益发放 |
| `server/plugin*.ts` | 插件 API、任务、清单和权限 |
| `server/ai/*` | AI Provider、审计和 Telegram Skill |
| `drizzle/schema.ts` | Drizzle 类型化 schema |
| `shared/*` | 前后端共用类型和纯函数 |

## Agent 通信

Agent 使用 Token 鉴权。敏感 POST 请求使用 `server/agentCrypto.ts` 定义的加密信封，SSE 用于立即唤醒，心跳负责取得期望状态和动作。

主要接口由 `server/agentRoutes.ts` 及其子路由注册：

- 注册与心跳。
- SSE 事件连接。
- 规则和隧道运行状态。
- 流量与累计计数。
- 规则、隧道和服务延迟。
- 链路自测。
- 插件任务与同步。
- Agent 安装包、升级和迁移指令。

SSE 不是唯一正确性来源。连接中断时，周期心跳仍会收敛期望状态；面板重启、Agent 重启或动作失败后，期望状态对账会补发缺失配置。

## 并发模型

规则和探测数量较大时，不能由一个全局串行队列处理：

- 同一主机、端口或资源的冲突动作保持顺序，避免旧动作覆盖新配置。
- 不同资源通过有限并发 worker 执行，避免单个慢任务阻塞全局。
- 心跳使用合并和互斥控制，避免同一 Agent 重复构建期望状态。
- 状态、流量和延迟上报按资源键有序，不同资源并行落库。
- Agent 共享运行时先完成同步，再并行处理可独立的端口动作。
- 每个动作携带版本、时间或资源身份，迟到结果不能覆盖较新的期望状态。

增加并发时必须保留同资源顺序和全局上限；直接无上限启动 goroutine 或 Promise 会把排队问题转成 CPU、文件描述符或数据库连接耗尽。

Web 转发规则的批量写入单独采用受限内存队列（`server/ruleTaskQueue.ts`），一次执行一项、不同任务轮转，削平集中写入峰值；它不接管 Agent 心跳、上报及部署 worker。任务只保留用户 ID / 会话 ID，执行前重新鉴权并复用原 CRUD 权限、库存及审计路径，不缓存权限或重放结果不明的写入。每用户最多 3 个未完成任务，全局最多 100 个任务、20,000 项及 8 MiB 待执行载荷，单次最多 5,000 项 / 2 MiB；完成结果最多保留 15 分钟。进程重启不恢复未执行任务，前端通过实例 ID 和任务 ID 识别丢失状态，提示核对而不是自动重新提交。此队列不是多实例共享的持久队列；多进程部署需会话粘滞，或另外实现共享任务存储。

### 展示查询缓存

- `server/displayQueryCache.ts` 为规则列表/汇总、主机列表/状态/指标、链路流量提供进程内短缓存。同键并发请求只执行一次加载，按用户、角色、查询范围和筛选条件隔离。
- 列表缓存 2 秒、不返回过期列表；非关键指标缓存 2 秒，随后最多 8 秒可先返回旧值并合并后台刷新。主机物理指标可在已授权查看者之间复用，授权检查仍在每次请求中执行。
- 修改前后清理受影响用户及管理员展示缓存，管理员修改清理全部展示缓存；切换数据库时清空。失效前启动的查询不能回填旧缓存。`hosts.watchMetrics` 仅续订指标订阅，不清理缓存。
- 新展示缓存最多 2,000 键、24 MiB 序列化数据；该值不是 Node.js 进程内存上限。首页/运维汇总保留原有独立缓存和后台刷新频率。
- 上述展示加载与首页/运维汇总共享 8 个加载槽，最多排队 64 项、排队最多 1.5 秒，超限返回“服务繁忙，请稍后重试”。限制的是加载任务，不是全站 HTTP 请求数或数据库连接数；已经执行的 SQL 不会因排队超时而提前释放槽位。
- 用户与有效会话通过一次联合查询读取，鉴权读取独立限制为 8 个并发、256 项排队、最长等待 2 秒。只限制积压，不缓存鉴权结果；数据库繁忙或查询失败不清除登录凭证，也不跳过鉴权。主要实时页面轮询失败后退避至 5/10/20/30 秒，成功后恢复原间隔。
- 主机指标、流量与指标订阅批量读取主机及权限，避免对每台可见主机重复查库；保留所有权、手动授权与有效套餐授权校验，每次请求实时检查，不缓存权限。
- 鉴权、禁用/注销、授权判定、余额校验、扣费、兑换及流量限制执行不使用这些展示缓存。优化不依赖数据库方言，SQLite、MySQL、PostgreSQL 均适用；压测结果见 `reports/local-cache-load-test-2026-10-23.md`。

## Agent 运行时

Agent 主流程：

1. 读取 `/etc/forwardx/agent/config.json`。
2. 注册并建立 SSE 连接。
3. 通过心跳取得完整或增量期望状态。
4. 对共享 GOST、隧道、Nginx、WireGuard 和 mimic 运行时进行对账。
5. 执行端口规则动作。
6. 上报监听状态、流量、延迟、自测和主机指标。

主要文件：

| 路径 | 内容 |
| --- | --- |
| `agent/main.go` | Agent 主程序、动作调度和运行态对账 |
| `agent/actions.go` | 动作执行与并发阶段 |
| `agent/metrics.go` | 流量、延迟和主机指标 |
| `agent/wireguard_runtime.go` | ForwardX V2 userspace WireGuard |
| `agent/plugin_tasks.go` | 插件任务执行和结果 |
| `agent/panel_migration.go` | 面板迁移切换保护 |

持久状态主要位于 `/var/lib/forwardx-agent`，日志默认位于 `/var/log/forwardx-agent`。托管服务和配置使用 `/etc/forwardx`、`forwardx-*.service` 及独立运行时二进制。

## 兼容与迁移

面板和 Agent 的日常运行路径只读取当前格式，已经取消的旧格式由独立迁移工具一次性转换，不再长期保留旧解析分支。旧服务清理、数据库 schema backfill 和转发组当前数据字段仍属于升级可靠性或现行模型，不能仅凭名称带有 `legacy` 就删除。

跨兼容边界时按[升级和备份](./guide/upgrade-backup.md#跨兼容边界升级)先预检再手动迁移；迁移默认只读，只有明确传入 `--apply` 才写入。

## 维护边界

- Router 不应重新实现 Repository 已有筛选和分页。
- 前端列表不应通过“先取全部再切页”规避分页接口。
- Agent 运行态判断必须区分配置已启用、进程已监听和健康探测可用。
- 支付回调必须先校验签名、商户、金额、币种和通道，再执行幂等发放。
- 插件高权限 API 必须同时通过清单声明、管理员信任和服务端权限检查。
- 新 backfill 需要幂等标记、失败日志和可重复执行策略。
