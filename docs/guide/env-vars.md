# 环境变量

ForwardX 大多数设置都可以在后台页面中配置。环境变量主要用于容器启动、数据库连接、登录密钥、机器人 Token 和升级命令这类“启动前就要确定”的配置。

## 修改后如何生效

本地安装的 .env 由服务环境加载，修改后重启 forwardx-panel。Docker 的 .env 主要用于 Compose 插值，**只有 environment / env_file 明确传入的变量才会出现在容器中**。

仓库 Compose 只映射部分变量。例如额外设置可信代理时，要在 forwardx 服务的 environment 下添加 FORWARDX_TRUST_PROXY 映射，并在 .env 填写真实可信代理范围；不要把整份 .env 无差别暴露给容器。

在已有的 `services.forwardx.environment` 中追加，而不是覆盖其他变量：

~~~yaml
FORWARDX_TRUST_PROXY: ${FORWARDX_TRUST_PROXY:-loopback}
~~~

再在 `.env` 中设置 `FORWARDX_TRUST_PROXY` 为真实反代的可信 IP/子网。不要直接照抄不属于自己网络的地址。

修改 Docker 环境配置后，在实际部署目录执行：

~~~bash
docker compose up -d --force-recreate forwardx
~~~

仅 docker restart 不会更新容器环境。本地修改 systemd 单元后需要 daemon-reload，再重启服务；仅修改 EnvironmentFile 内容通常只需重启。

安装脚本升级会重新生成环境/Compose 文件，保留其识别的核心项，不保证原样保留手动追加项。自定义配置必须备份并在升级后核对。

## 环境、页面设置和安装器参数

数据库、登录密钥和启动网络配置使用进程环境；SMTP、Google OAuth、AI 和大多数业务开关在网页中配置，保存到数据库。不要自行猜测 SMTP_HOST、GOOGLE_CLIENT_ID 等变量会生效。

FORWARDX_IMAGE 等镜像变量主要由 Compose/安装器读取，不是容器里的业务开关。文中 /data 路径是容器或程序默认值；本地安装器会覆盖为安装目录下的 data，详见 [目录与日志](./paths-logs.md)。

## 基础变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9810` | 面板对外访问端口。本地部署时是面板监听端口；Docker Compose 中通常是宿主机端口，容器内仍监听 `3000`。 |
| `NODE_ENV` | `production` | 运行模式，正式部署保持 `production`。 |
| `FORWARDX_SETUP_LANGUAGE` | 空 | 首次部署向导默认语言：`zh-CN` / `en`；空或 `auto` 按浏览器 / IP。安装脚本的 `--language` 参数会保存此项，手动选择优先，初始化完成后不覆盖正常语言检测。 |
| `JWT_SECRET` | 安装器安全随机生成；手动部署可留空 | 登录签名密钥。一键安装生成 256 位随机值；留空时应用自动生成并持久保存，Docker 默认 `/data/jwt.secret`。不要使用固定示例值，升级保持不变并备份密钥。 |
| `FORWARDX_JWT_SECRET_PATH` | 空 | 未配置 `JWT_SECRET` 时，面板保存自动生成登录密钥的路径。 |
| `DATABASE_CONFIG_PATH` / `DB_CONFIG_PATH` | `/data/database.json` | 面板保存数据库连接配置的位置。 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 数据文件路径。 |
| `FORWARDX_TRUST_PROXY` | `loopback` | Express 可信代理 IP/子网或跳数；仅信任真实反代，勿无条件信任公网。 |
| `FORWARDX_SEAMLESS_MIGRATION_STATE_PATH` | 数据库配置目录旁的 `seamless-migration.json` | 无缝迁移状态和私密接管凭据文件，需持久化保护。 |
| `FORWARDX_PANEL_TIME_SYNC` | `true` | 启动并定期校准旧版 Agent/FXP 加密协议使用的面板时钟；不会修改宿主机或 Docker 的系统时间。 |
| `FORWARDX_PANEL_TIME_SOURCES` | 内置多个 HTTPS 来源 | 可选，使用逗号分隔的可信 HTTPS 地址覆盖默认校时来源。 |
| `FORWARDX_PANEL_TIME_ALLOW_SINGLE_SOURCE` | `false` | 是否允许仅一个 HTTPS 来源可用时校准；单源无法交叉验证，仅建议在可信内网时间服务场景开启。 |

::: tip JWT_SECRET 为什么重要
`JWT_SECRET` 变化后，已登录用户会需要重新登录，使用该密钥加密的商家接口配置也可能需要重新配置。一键安装自动生成并保留随机值；手动部署留空时需要持久保存并备份 `/data/jwt.secret`，后续不要改成另一个环境变量值。
:::

::: tip 管理员密码不由环境变量设置
管理员邮箱和密码在首次初始化向导中创建。`ADMIN_PASSWORD` 不是有效配置，也不会在容器重启或重装时重置管理员密码；需要保留数据时使用原管理员凭据，需要全新初始化时必须确认旧 Docker 数据卷已删除。
:::

::: tip Docker 与时间校准
Docker 容器与宿主机共享系统时钟，不能独立运行一套时间。ForwardX 会使用多个 HTTPS 来源校准旧版 Agent/FXP 加密协议的时间基准；新版 Agent 与 ForwardX FXP 面板上报使用一次性挑战认证，不再依赖双方系统时间。宿主机仍建议开启 NTP。外网受限时，可通过 `FORWARDX_PANEL_TIME_SOURCES` 指向部署方可信且会返回标准 `Date` 响应头的 HTTPS 服务。

官方部署按单面板实例运行。认证挑战、登录流程和其他运行状态涉及进程内存，不能只靠共享数据库或粘性路由就认定支持多副本。正式部署保持单副本，代理设置见 [HTTPS 与反向代理](./reverse-proxy.md)。
:::

## 数据库变量

首次进入面板可以在初始化向导中选择数据库。你也可以用环境变量提前指定数据库连接。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_TYPE` / `DB_TYPE` | 空 | 可选，强制指定 `sqlite`、`mysql` 或 `postgresql`。设置后后台切换数据库不会在重启后生效，除非移除该变量。 |
| `MYSQL_URL` | 空 | MySQL 连接串。配置后优先于分项配置。 |
| `MYSQL_HOST` | 空 | MySQL 地址。Docker 内不要把宿主机数据库写成 `127.0.0.1`。 |
| `MYSQL_PORT` | `3306` | MySQL 端口。 |
| `MYSQL_USER` | 空 | MySQL 用户名。 |
| `MYSQL_PASSWORD` | 空 | MySQL 密码。 |
| `MYSQL_DATABASE` | 空 | MySQL 数据库名。 |
| `MYSQL_SSL` | `false` | MySQL 是否启用 SSL。 |
| `MYSQL_CONFIG_PATH` | `/data/mysql.json` | 兼容旧版本的 MySQL 配置文件路径。 |
| `POSTGRES_URL` / `POSTGRESQL_URL` / `PG_URL` | 空 | PostgreSQL 连接串。配置后优先于分项配置。 |
| `POSTGRES_HOST` / `POSTGRESQL_HOST` / `PGHOST` | 空 | PostgreSQL 地址。 |
| `POSTGRES_PORT` / `POSTGRESQL_PORT` / `PGPORT` | `5432` | PostgreSQL 端口。 |
| `POSTGRES_USER` / `POSTGRESQL_USER` / `PGUSER` | 空 | PostgreSQL 用户名。 |
| `POSTGRES_PASSWORD` / `POSTGRESQL_PASSWORD` / `PGPASSWORD` | 空 | PostgreSQL 密码。 |
| `POSTGRES_DATABASE` / `POSTGRESQL_DATABASE` / `PGDATABASE` | 空 | PostgreSQL 数据库名。 |
| `POSTGRES_SSL` / `POSTGRESQL_SSL` / `PGSSL` | `false` | PostgreSQL 是否启用 SSL。 |

Docker 场景下数据库地址可以按下面判断：

| 场景 | 推荐填写 |
| --- | --- |
| 数据库和面板在同一个 Compose 项目 | 数据库服务名，例如 `postgres`、`mysql` |
| 数据库在宿主机 | 已配置 host-gateway 映射的 `host.docker.internal`，或宿主机内网 IP |
| 数据库在另一台服务器 | 面板容器能访问到的内网 IP、公网 IP 或域名 |

## 数据库连接池

MySQL 和 PostgreSQL 连接池由面板自动管理，不需要配置连接数。面板会按主机数量在 `16/24/32` 的最大连接档位间自动调整。连接按实际并发按需创建，并保留已经建立的池内连接供下一轮心跳复用，避免并发突发后反复建连产生大量 `TIME-WAIT`。

两种数据库均使用有限等待队列，获取连接最多等待 6 秒；超时的排队项会移除，不会继续执行其 SQL。普通 SQL 响应最多等待 30 秒，超时会销毁该请求独占的连接，而非只让页面停止等待；事务的 BEGIN、COMMIT、ROLLBACK 同样受保护，闲置超过 2 分钟的借出连接会回收。正常空闲的池内连接不受这项 2 分钟限制。

初始化、数据回填、数据库切换与建表/索引等维护语句使用单条 SQL 最多 5 分钟的独立预算；不是整轮升级仅允许 5 分钟。维护流程中借出的连接也允许闲置最多 5 分钟，避免等待源库读取时误断开目标库。健康检查使用独立连接，默认 6 秒超时后清理连接，不与业务争用连接池。切换或关闭连接池也有强制断连兜底。

网络超时不能确认写入是否已在数据库提交，因此不会自动重试该写入或提交操作。遇到下单、支付或保存超时，先确认实际结果后再操作。这些保护用于释放未完成请求和连接，不能替代修复慢 SQL、锁等待或数据库网络；V8 可能保留已申请的内存供复用，系统显示的 RSS 不保证立即回落。

### 数据库健康检查

已完成初始化的数据库，短暂网络故障默认需连续 3 次独立探测失败才会将面板整体标为不可用；成功探测会清零失败次数。单条业务 SQL 超时仍返回失败，但不会仅凭它将所有用户切换到数据库故障页。启动失败、认证及证书错误、已识别的存储错误不等待这个次数。持续断网时，确认故障通常需要约 30–60 秒（事件循环严重阻塞时可能更长）；确认前的实际失败请求不会被当作成功。

| 变量 | 默认值 | 范围 / 说明 |
| --- | --- | --- |
| `FORWARDX_DB_HEALTH_INTERVAL_MS` | `15000` | 探测间隔，`5000`–`300000` 毫秒。 |
| `FORWARDX_DB_HEALTH_TIMEOUT_MS` | `6000` | 独立连接建立和探测 SQL 各自的超时预算，`1000`–`60000` 毫秒。 |
| `FORWARDX_DB_HEALTH_FAILURE_THRESHOLD` | `3` | 连续失败确认次数，`1`–`10`；`1` 表示首次失败立即判定。 |

通常无需调整。Docker 自定义时需在 Compose 的 `environment` 显式映射上述变量，再重新创建容器。`[DatabaseHealth] probe delayed` 日志包含失败次数、耗时和事件循环忙碌比例，最多每分钟输出一次；忙碌比例高提示面板可能繁忙，但不等于已确认 CPU 或数据库根因。

## 机器人和通知

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram Bot Token。也可以在后台“系统设置 -> 通知渠道”中填写。 |
| `TELEGRAM_BOT_POLLING` | `true` | 是否启用 Telegram 长轮询。一般保持默认，不需要配置 webhook。 |
| `DISCORD_BOT_TOKEN` | 空 | Discord Bot Token，环境变量优先。通知设置中选择 Discord 并启用后生效；也可直接在后台配置。 |

如果通过环境变量配置 `TELEGRAM_BOT_TOKEN`，后台会显示 Token 来源为环境变量，普通页面中不能直接删除该 Token。需要停用时请移除环境变量并重启面板。

## AI 助手配置

AI 助手目前建议在后台页面配置：

```text
系统设置 -> 通知渠道 -> AI 助手模型
```

可配置内容包括：

- 供应商：DeepSeek、SiliconFlow 或自定义 OpenAI 兼容接口。
- API Key。
- Base URL。
- 模型名称。
- 最大输出 Tokens。
- 温度。
- 普通用户是否可用 AI 管理。
- AI 相关机器人消息是否自动撤回。

::: tip
AI API Key 不建议写入 Docker `.env`。后台保存后会做脱敏展示，也方便管理员切换供应商和模型。
:::

## 升级和镜像

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_IMAGE` | `ghcr.io/poouo/forwardx:latest` | Docker 部署使用的镜像。 |
| `FORWARDX_IMAGE_REPO` | `ghcr.io/poouo/forwardx` | Docker 一键脚本解析版本镜像时使用的镜像仓库。 |
| `FORWARDX_GITHUB_ACCELERATOR_URL` | 空 | 面板安装或升级使用的 GitHub 加速站，例如 `https://mirror.example.com`。一键脚本通过 `--github-accelerator` 接收后会写入部署 `.env`。 |
| `FORWARDX_TARGET_VERSION` | 空 | 本地部署可指定安装或升级到某个版本，例如 `vX.Y.Z`。Docker 脚本也会用它校验目标镜像是否已经构建完成。 |
| `FORWARDX_UPGRADE_COMMAND` | 空 | 后台一键升级命令。为空时只能检查更新，不能在后台直接执行升级。 |
| `FORWARDX_REPO_URL` | 自动注入 | 升级任务执行时使用的仓库地址，通常不需要手动配置。 |
| `FORWARDX_CURRENT_VERSION` | 自动注入 | 升级任务执行时的当前版本，通常不需要手动配置。 |

`FORWARDX_GITHUB_ACCELERATOR_URL` 使用 `加速站地址/原始 GitHub URL` 的代理格式，供安装和升级脚本读取。面板内的更新功能需另行在「系统设置 -> 系统配置 -> GitHub 下载加速」填写地址并开启「面板更新使用加速站」；开启后，版本检查、Release 信息、安装包检测、回退和升级命令会优先使用该地址，失败时自动回退直连 GitHub。

该变量不加速 `ghcr.io` 镜像拉取。Docker 镜像地址仍由 `FORWARDX_IMAGE` 或 `FORWARDX_IMAGE_REPO` 控制。

## Agent 安装脚本相关变量

这些变量主要在执行 Agent 安装或升级脚本时使用：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_AGENT_RELEASE_VERSION` | 当前面板 Release 标签 | 指定 Agent 安装器下载资产所在的面板 Release，不是 Agent 自身版本号。 |
| `FORWARDX_AGENT_PROXY` | 未指定时读取 Agent 配置 | 安装器的显式代理覆盖，空值表示直连；推荐使用 `--proxy URL` / `--no-proxy`。运行时以 `config.json` 的 `proxyUrl` 为准，不以此环境变量替代配置。 |
| `FORWARDX_REALM_VERSION` | `2.9.4` | Agent 安装器的 Realm 版本，默认兼容版；显式指定其他版本前确认 libc 和系统兼容性。 |
| `FORWARDX_INSTALL_MIMIC` | `ask` | 可选 mimic 安装选择，默认交互询问；普通转发不依赖它。 |
| `FORWARDX_AGENT_PANEL_FIRST` | 面板设置决定 | 优先从面板内置资产下载 Agent 运行时，失败再回退到 GitHub。 |
| `FORWARDX_CURL_CONNECT_TIMEOUT` | `15` | 下载连接超时时间。 |
| `FORWARDX_CURL_LOW_SPEED_LIMIT` | `1024` | 下载低速判断阈值。 |
| `FORWARDX_CURL_ASSET_LOW_SPEED_TIME` | `180` | 下载资产允许低速持续的时间。 |

普通用户通常不需要配置这些变量。只有在 GitHub 访问不稳定、内网镜像分发或排查 Agent 升级问题时才会用到。

`FORWARDX_AGENT_RELEASE_VERSION` 指面板发布的 Release 标签，不等于 Agent 自身版本号。例如面板和 Agent 使用不同版本序列，不要把主机显示的 Agent 版本直接当作面板 Release 标签。代理下载、运行直连和密码保护见 [Agent 代理](./agent-proxy-manager.md)。

## 调试日志变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_VERBOSE_AGENT_EVENTS` | 空 | 开启更详细的 Agent 事件日志。 |
| `FORWARDX_VERBOSE_AGENT_ACTIONS` | 空 | 开启更详细的 Agent 动作下发日志。 |
| `FORWARDX_VERBOSE_AGENT_REPORTS` | 空 | 开启更详细的 Agent 上报日志。 |
| `FORWARDX_LOG_DIR` | 默认日志目录 | 指定面板日志文件目录。 |

这些变量会增加日志量。排查完成后建议关闭，避免长期刷大量无效日志。

## 安装脚本目录参数

以下参数由安装器读取，自定义部署时在每次安装/升级/卸载中使用一致的目录与名称：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| FORWARDX_DOCKER_DIR | /opt/forwardx-docker | Docker 脚本管理目录 |
| FORWARDX_CONTAINER_NAME | forwardx-panel | Docker 容器名 |
| COMPOSE_PROJECT_NAME | forwardx | Compose 项目名，影响默认卷名 |
| FORWARDX_PANEL_DIR | /opt/forwardx-panel | 本地安装目录 |
| FORWARDX_SERVICE_NAME | forwardx-panel | 本地服务名 |

这些不是在网页里更换目录的开关。变更卷名或数据库路径前，先 [备份](./upgrade-backup.md) 并确认实际挂载，避免启动到另一套空数据库。

新版 `fwxm panel` 会沿用安装器记录的上述目录与名称，见 [SSH 管理菜单](./ssh-management.md)。管理命令不代表手工部署会被自动识别或迁移。
