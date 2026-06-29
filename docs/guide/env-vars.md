# 环境变量

ForwardX 大多数设置都可以在后台页面中配置。环境变量主要用于容器启动、数据库连接、登录密钥、Telegram Token 和升级命令这类“启动前就要确定”的配置。

Docker 部署时，环境变量通常写在部署目录的 `.env` 文件中。本地 systemd 部署时，可以写入 systemd 服务的环境配置，或由安装脚本生成的服务配置管理。

::: warning 修改后要重启
环境变量只会在面板进程启动时读取。修改 `.env` 或 systemd 环境配置后，需要重启面板容器或 `forwardx-panel.service`。
:::

## 基础变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9810` | 面板对外访问端口。本地部署时是面板监听端口；Docker Compose 中通常是宿主机端口，容器内仍监听 `3000`。 |
| `NODE_ENV` | `production` | 运行模式，正式部署保持 `production`。 |
| `JWT_SECRET` | 自动生成或示例值 | 登录签名密钥。生产环境建议使用 32 位以上随机字符串，并长期保持不变。 |
| `FORWARDX_JWT_SECRET_PATH` | 空 | 未配置 `JWT_SECRET` 时，面板保存自动生成登录密钥的路径。 |
| `DATABASE_CONFIG_PATH` / `DB_CONFIG_PATH` | `/data/database.json` | 面板保存数据库连接配置的位置。 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 数据文件路径。 |

::: tip JWT_SECRET 为什么重要
`JWT_SECRET` 变化后，已登录用户会需要重新登录。建议 Docker 首次部署时就在 `.env` 中固定一个随机值，后续升级不要更换。
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
| 数据库在宿主机 | `host.docker.internal` 或宿主机内网 IP |
| 数据库在另一台服务器 | 面板容器能访问到的内网 IP、公网 IP 或域名 |

## 数据库连接池

MySQL 和 PostgreSQL 会使用连接池。默认值适合约 30 台 Agent 主机的常规生产使用。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_MAX_OPEN_CONNS` / `DB_MAX_OPEN_CONNS` | `50` | 最大连接数。 |
| `DATABASE_MAX_IDLE_CONNS` / `DB_MAX_IDLE_CONNS` | `10` | 最大空闲连接数，不能超过最大连接数。 |
| `DATABASE_CONN_MAX_LIFETIME_MINUTES` / `DB_CONN_MAX_LIFETIME_MINUTES` | `30` | 单个连接最长生命周期，`0` 表示不按生命周期主动回收。 |
| `DATABASE_CONN_MAX_IDLE_TIME_MINUTES` / `DB_CONN_MAX_IDLE_TIME_MINUTES` | `5` | 空闲连接回收时间。 |
| `DATABASE_CONNECT_TIMEOUT_MS` / `DB_CONNECT_TIMEOUT_MS` | `6000` | 建立数据库连接超时时间，单位毫秒。 |

小规模部署可以使用：

```ini
DATABASE_MAX_OPEN_CONNS=20
DATABASE_MAX_IDLE_CONNS=5
```

如果主机数量很多、管理员多人频繁查看图表和日志，可以逐步提高到 `80-100` 最大连接和 `20-40` 空闲连接。调整时也要确认数据库服务端的 `max_connections` 足够。

## Telegram 和通知

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram Bot Token。也可以在后台“系统设置 -> Telegram”中填写。 |
| `TELEGRAM_BOT_POLLING` | `true` | 是否启用 Telegram 长轮询。一般保持默认，不需要配置 webhook。 |

如果通过环境变量配置 `TELEGRAM_BOT_TOKEN`，后台会显示 Token 来源为环境变量，普通页面中不能直接删除该 Token。需要停用时请移除环境变量并重启面板。

## AI 助手配置

AI 助手目前建议在后台页面配置：

```text
系统设置 -> Telegram -> AI 助手模型
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
| `FORWARDX_TARGET_VERSION` | 空 | 本地部署可指定安装或升级到某个版本，例如 `v2.3.187`。Docker 脚本也会用它校验目标镜像是否已经构建完成。 |
| `FORWARDX_UPGRADE_COMMAND` | 空 | 后台一键升级命令。为空时只能检查更新，不能在后台直接执行升级。 |
| `FORWARDX_REPO_URL` | 自动注入 | 升级任务执行时使用的仓库地址，通常不需要手动配置。 |
| `FORWARDX_CURRENT_VERSION` | 自动注入 | 升级任务执行时的当前版本，通常不需要手动配置。 |

## Agent 安装脚本相关变量

这些变量主要在执行 Agent 安装或升级脚本时使用：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_AGENT_RELEASE_VERSION` | 面板版本对应的 Agent 版本 | 指定 Agent 安装脚本下载的 Agent Release 版本。 |
| `FORWARDX_AGENT_PANEL_FIRST` | 面板设置决定 | 优先从面板内置资产下载 Agent 运行时，失败再回退到 GitHub。 |
| `FORWARDX_CURL_CONNECT_TIMEOUT` | `15` | 下载连接超时时间。 |
| `FORWARDX_CURL_LOW_SPEED_LIMIT` | `1024` | 下载低速判断阈值。 |
| `FORWARDX_CURL_ASSET_LOW_SPEED_TIME` | `180` | 下载资产允许低速持续的时间。 |

普通用户通常不需要配置这些变量。只有在 GitHub 访问不稳定、内网镜像分发或排查 Agent 升级问题时才会用到。

## 调试日志变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FORWARDX_VERBOSE_AGENT_EVENTS` | 空 | 开启更详细的 Agent 事件日志。 |
| `FORWARDX_VERBOSE_AGENT_ACTIONS` | 空 | 开启更详细的 Agent 动作下发日志。 |
| `FORWARDX_VERBOSE_AGENT_REPORTS` | 空 | 开启更详细的 Agent 上报日志。 |
| `FORWARDX_LOG_DIR` | 默认日志目录 | 指定面板日志文件目录。 |

这些变量会增加日志量。排查完成后建议关闭，避免长期刷大量无效日志。
