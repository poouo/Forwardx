# 本地开发

源码开发与生产部署是两套流程。需要正式服务时使用 [Docker](./deploy-docker.md) 或 [本地发布包](./deploy-local.md)，不要向公网开放开发自动登录模式。

## 准备

安装 Node.js 22+，使用与 CI 一致的 pnpm 版本（当前为 10.28.1）。进入项目根目录：

~~~bash
pnpm install
pnpm dev:panel
~~~

dev:panel 启动真实页面、路由和组件，使用项目 .dev 目录中的隔离开发数据，并提供开发管理员自动登录。

| 项目 | 默认值 |
| --- | --- |
| 网页地址 | http://127.0.0.1:5173/ |
| 公开主机监控 | http://127.0.0.1:5173/dev |
| 后端端口 | 3000 |
| SQLite 数据库 | .dev/forwardx-dev.db |
| 数据库配置 | .dev/database.json |
| 开发登录密钥 | .dev/jwt.secret |
| 开发管理员 | dev.admin@forwardx.local / forwardx-dev |

以终端实际打印的地址为准。按 Ctrl+C 停止。开发库会保留上一次数据，不是每次启动重新清空。

演示数据仅在开发库首次初始化时填充，自动重载不会重建工单、规则等调试数据。如需重新生成演示数据，先停止服务并备份、移走 `.dev` 开发库，再启动；不要对生产数据库执行此操作。

端口冲突时可设置 FORWARDX_DEV_SERVER_PORT / FORWARDX_DEV_CLIENT_PORT 后重新启动；保持回环访问，不要将 HOST 改为公网地址后继续使用自动登录。

## pnpm dev 的区别

pnpm dev 直接启动 server/index.ts，不是隔离数据、自动登录的开发启动器。它会按实际环境及数据库配置运行后端，需要自己管理数据库和登录；不要用生产数据库随意测试。

首次测试页面建议使用 pnpm dev:panel。代理出现 ECONNREFUSED / ECONNRESET 时，检查后端是否启动成功、端口是否冲突以及终端前面的异常；不要仅屏蔽代理日志而忽略后端退出或连接被重置。

## 接口更新与加载排障

开发模式会按模块加载源码和热更新依赖，Network 的资源体积不能直接当作线上包体积；正式构建会压缩并按页面拆包。进入页面仅加载当前页，菜单悬停、键盘聚焦或触摸时预取目标页，切页保留导航，慢速网络仅在内容区显示占位。

排查加载耗时时，查看单条请求的“时间 / 计时”和 Performance 中的实际页面呈现。Network 顶部时间轴表示请求何时发起，不是单条请求耗时；底部“完成”会被后续轮询延长，开发热更新 WebSocket 长期“待处理”也是正常的。比较首屏时使用无扩展窗口、相同缓存和网络条件，不将 `chrome-extension://` 资源计入面板。

前端通过 Vite 热更新；`dev:panel` 的后端使用 Node 文件监听，修改已加载的后端路由、Repository 或共享模块后会自动重启，代理跟随实际端口。重启期间短暂的接口连接重置属于预期，启动完成后重试即可。修改启动脚本、环境变量或数据库配置后，仍需在原终端按 Ctrl+C 停止，再运行 `pnpm dev:panel`；不需要清空 `.dev` 数据。更新到此监听机制前已经启动的旧开发进程，也需先手动重启一次。

页面持续转圈或加载后空白时，在浏览器开发者工具 Network 中检查 `/api/trpc/` 请求：

- `404 / No procedure found`：优先核对前后端是否来自同一份代码、旧后端是否已停止及代理目标端口。
- `401/403`：检查运行模式、登录和账号权限，不当作数据库性能问题处理。
- `5xx`：结合后端终端和日志查看错误。
- 成功但慢：分开测量接口、数据库查询与页面渲染；批量请求可能等待同批其他接口，失败重试也会延长表面加载时间。本地数据并不意味着可以跳过接口诊断。

自动选择备用端口时，以启动日志显示的后端及页面地址为准，避免浏览器仍访问另一个旧开发实例。

## 文档截图

使用本地 `dev:panel` 的真实页面和隔离开发数据截图；不要连接生产数据库或真实商户账号。先确认后端已加载当前代码，等待数据完成加载，关闭弹窗和错误提示后再截取需要说明的区域。

- 图片放在 `docs/guide/images/`，用功能命名，例如 `operations-finance.png`、`billing-ledger.png`；Markdown 使用相对路径并写清图意。
- 运维看板截图选择相同日期及用户范围，支付图表注明币种；移动端布局另用窄屏截图，不把桌面截图强行缩窄。
- Token、商户密钥、证书私钥、兑换码、用户联系方式和真实来源 IP 不能出现在公开图片中。界面必须有值时只使用明确的演示数据。
- 只裁切和脱敏，不修改截图中的数值或拼接成不存在的功能；截图注明为本地开发演示，不能证明线上已发布或真实业务通过。
- 添加图片后执行 `pnpm docs:build`，核对链接和最终页面。截图工具不可用时保留文字教程与待补清单，不添加不存在的图片链接。

### 截图素材与待补清单

`2.3.285` 已收录用户提供的本地开发截图，只做裁切，未拼接或修改业务数值。待补素材不插入图片链接：

| 文件名 | 状态与内容 |
| --- | --- |
| `operations-filters.png` | 已收录：看板日期、用户及自动刷新档位 |
| `operations-finance.png` | 已收录：账务环形图，支付币种 CNY |
| `billing-ledger.png` | 已收录：账单列表上部 |
| `host-notifications.png` | 已收录：其他配置中的上下线通知开关 |
| `entry-group-overview.png` | 已收录：入口组成员、状态和流量概览，不能代替节点诊断图 |
| `billing-pagination.png` | 已收录：账单列表底部的总数、页码与上一页/下一页 |
| `user-selector.png` | 已收录：展开的用户选择器，包含搜索、部分用户及翻页入口 |
| `port-entry-nodes.png` | 已收录：「节点详情」独立弹窗，示例为两台入口暂无启用规则（0/2、0/0）；不是运行失败示例 |

## Agent 自动发现接口

新机器不再先创建 Token 或批量注册卡片。管理员在「添加主机」获取同一条通用安装指令，每台机器先领取独立 Token，再沿用现有 Agent 加密注册协议上线；无需修改旧 Agent 协议。

| 接口 | 认证与参数 | 返回 |
| --- | --- | --- |
| `agentTokens.configureDiscovery`（tRPC mutation） | 仅有效管理员；`{ enabled?: boolean, rotate?: boolean }` | `{ enabled, key }`；首次调用初始化接入密钥，空参数再次调用保留开关状态 |
| `GET /api/agent/discovery.sh` | 无需登录，不携带密钥 | 自包含 Bash 入口；从第一个参数读取接入密钥，支持后续 `--proxy URL`、`--no-proxy`、`--mimic y\|n\|ask`（默认交互询问，安装入口同样支持） |
| `POST /api/agent/discover` | `Authorization: Bearer <key>`；JSON `{ registrationId, hostname }` | `{ token }`，Token 为每台机器独立的 64 位十六进制凭据 |

`registrationId` 为安装端随机生成的 64 位小写十六进制值，不使用 IP、MAC 或主机名标识机器。在发送请求前保存到 `/etc/forwardx/agent/discovery.json`（权限 600）；相同标识的重试返回同一 Token。该文件和 `config.json` 不能复制到另一台新机器复用。后续安装失败保留状态，下次重试继续使用原凭据；安装失败且尚未真正注册的预留记录不展示为主机。

接入密钥只允许领取 Token，不能调用心跳、配置拉取、状态上报等 Agent 接口。关闭发现或轮换密钥不会吊销已签发的独立 Token。请求校验失败返回 400，密钥错误、关闭接入或签发管理员不可用返回 403，限流返回 429（每来源 IP 每分钟 60 次），已迁移面板返回 410。接口与脚本均返回 `Cache-Control: no-store`，建议通过 HTTPS 使用。

原 `agentTokens.getInstallToken` 仍仅管理员可用，供每个 Agent 终端按钮中的专属安装、升级和卸载弹窗使用；`boundHost` 用于恢复安装前的接管提示。`agentTokens.list` 中新增 `firstOnlineAt`：首次成功注册的服务器上线时间，空值表示尚未上线。重连或恢复安装不覆盖该时间；旧记录依据关联主机首次注册时的创建时间展示。原 `createdAt` 继续保留其 Token 创建时间语义。

专项验证：`node --import tsx --test server/agentDiscovery.test.ts server/agentDiscoveryScript.test.ts server/agentInstallation.test.ts`。

## 流媒体解锁检测接口

主机卡片的检测弹窗使用 `hosts.streamUnlock` tRPC 路由，沿用主机访问权限校验：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `hosts.streamUnlock.start` | `{ hostId, family?: "ipv4" \| "ipv6" \| "both" }`，默认 `both` | 新建任务快照；同一主机已有任务执行时拒绝重复启动 |
| `hosts.streamUnlock.status` | `{ hostId, taskId?: string }` | 指定任务或最近任务快照，无记录时为 `null` |

状态为 `queued`、`running`、`success`、`error`、`timeout`，整轮超时为 180 秒。`providers` 按 `providerId` 和 `family` 区分结果，包含 `status`、可选 `region`、`httpStatus`、`latencyMs`、`detail` 和 `evidence`；`dns` 按域名和协议区分系统与公共 DNS 查询结果。共享类型和平台列表在 `shared/streamUnlock.ts`。

Agent 完整心跳领取 `streamUnlockTasks`，通过 `/api/agent/stream-unlock-progress` 逐项上报，通过 `/api/agent/stream-unlock-result` 完成任务；两者均沿用 Agent 加密认证，提交 `{ result }`。面板按任务保存合并后的快照，前端每 2 秒查询，关闭弹窗不会取消任务。结果暂存内存，最多保留 24 小时，面板重启会清空。

主题应按协议分别展示结果，使用主机有效地址判断 IPv4 / IPv6 选项是否可用；无结果时保留平台行，执行中的未返回项目显示检测中。地区仅在平台响应可识别时提供，不使用主机归属地推测。DNS 解锁基于解析差异和可访问结果推断，可能受 CDN 或分流影响；AI 服务检测使用公开入口，不保证账号登录、订阅或实际对话一定可用。

## 链路测速接口

`linkSpeed` tRPC 路由仅管理员可用，普通用户不显示入口，也不能发起、查询或取消测速：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `linkSpeed.start` | `resourceType: "tunnel" \| "chain"`、`resourceId`、`protocol: "tcp" \| "udp"`（默认 TCP）、`duration`（每方向 3–30 秒，默认 10）、`rateMbps`（UDP 1–1000，默认 100） | 测速状态及任务 `id` |
| `linkSpeed.status` | `id` | 完整状态，前端运行时每 500ms 查询 |
| `linkSpeed.latest` | `resourceType`、`resourceId` | 当前用户最近一次任务，或 `null` |
| `linkSpeed.cancel` | `id` | 取消后的状态 |

状态依次为 `preparing → upload → download → completed`，异常/取消对应 `error`、`cancelled`。`route` 是本次拓扑快照；`samples` 包含方向、阶段内毫秒时间、累计接收字节和区间 Mbps；`upload`/`download` 包含接收字节、时长、平均/峰值 Mbps。UDP 额外包含包数、丢包率和抖动。共享类型位于 `shared/linkSpeed.ts`。

Agent 以约 100ms 的粒度记录接收数据（TCP 随数据到达触发；UDP 上传约每 100ms 查询接收端），每约 500ms 将多个采样点放进 `samples` 数组上报，结束前刷新尾批。每批最多 64 点，每次任务最多保存 800 点，覆盖最长双向各 30 秒。面板仍兼容旧 Agent 的单点 `sample` 上报，并过滤重复、倒序和非法数据；最终平均速度始终按接收字节与实际时长计算。前端保持 500ms 查询，将批内数据按 `elapsedMs` 依次播放，表盘以 100ms 过渡；网络停顿或重新打开窗口时会追赶积压，将播放延迟限制在约 600ms。关闭动画、页面隐藏、取消或失败时直接展示最新数据。主题自定义测速视图也应按采样时间播放，避免将一批采样点同时跳到末点。细粒度数据需要更新 Agent，旧 Agent 仍按原有粒度显示。

Agent 通过完整心跳声明 `linkSpeedSupported: true`，并领取 `linkSpeedTasks`，任务分为 `prepare`、`run`、`stop`。执行前调用 `/api/agent/link-speed-claim`，进度和结果上报 `/api/agent/link-speed-result`；这两个端点沿用现有 Agent 加密认证，不能用作公开测速接口。任务带临时令牌和最长 150 秒的端点租约，取消后过期任务不能再次启动。

结果暂存面板内存，不是持久化业务记录。当前多分支测试选择主路径，不自动汇总或推断未测试分支。

专项验证：`node --import tsx --test server/linkSpeed.test.ts`，以及在 `agent/` 执行 `go test -run TestLinkSpeed ./...`。如需真实运行时集成测试，可设置 `FORWARDX_SPEED_FIXTURES_DIR` 后运行前述服务端测试生成本地回环配置，再设置 `FORWARDX_SPEED_RUNTIME_TEST_BIN`、`FORWARDX_SPEED_FXP_TEST_BIN` 为本机对应二进制路径，执行 Agent 的 `TestLinkSpeedActualRuntimePaths`。

回环集成测试之外，还应在独立主机或网络命名空间中验证双节点、三节点的 TCP/UDP。ForwardX V1/V3 的 UDP 临时入口通过本地中转连接可路由的 FXP 监听器，避免回环绑定的 UDP socket 向远端发包失败；V2 临时配置需补齐 UDP 监听/出口端口后再建立 WireGuard 代理。验证时同时检查实时采样、双向结果、取消后重测、临时端口回收，以及测速数据未计入业务规则和用户套餐。

## 常用验证

~~~bash
pnpm exec tsc --noEmit
pnpm test:server
pnpm build
pnpm docs:build
pnpm check:versions
pnpm test:deployment-docs
~~~

专项测试与移动端构建命令见 package.json 和 GitHub Actions 工作流。修改文档可使用 pnpm docs:dev 预览，提交前执行 docs:build 检查页面与链接。

测试账号和默认开发密码仅用于本地，不能作为生产账号或部署文档中的默认登录凭据。
