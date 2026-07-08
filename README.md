# ForwardX 转发管理面板

> 面向多台 Linux 服务器的端口转发、加密隧道、链路编排、用户权限、套餐与流量计费统一管理面板。

ForwardX 是一套中文化的多主机转发管理系统。它通过轻量 Agent 管理服务器入口、隧道链路、端口转发规则、端口转发链、入口组/出口组、DDNS 故障转移、用户权限、套餐订阅、余额和流量统计，适合把多台服务器统一组织成可观测、可切换、可授权、可计费的网络入口平台。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.3.221-brightgreen.svg)](https://github.com/poouo/Forwardx/releases)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

## 社群与下载

- 在线教程：https://poouo.github.io/Forwardx/
- TG 群组：https://t.me/ForwardX_panel
- Android APK 最新下载：https://github.com/poouo/Forwardx/releases/download/v2.3.221/forwardx-android-v2.3.79.apk
- GitHub Releases：https://github.com/poouo/Forwardx/releases

## 项目定位

ForwardX 不只是一个端口转发工具。更贴切的定位是：

**ForwardX 转发管理面板**

它把端口转发、隧道链路、端口转发链、入口组/出口组、转发组、DDNS 故障转移、用户配额和流量统计放在同一个控制面里管理。你可以把它理解为一个轻量的多机器网络入口与链路编排面板。

## 功能概览

- 多主机 Agent 管理，无需在面板保存 SSH 密钥。
- 支持 TCP、UDP、TCP+UDP 转发规则。
- 支持 `iptables`、`nftables`、`realm`、`socat`、`gost`、`nginx` 等转发方式，并在规则界面提示内核 NAT 与用户态转发的 IPv4/IPv6 跨协议族风险。
- 支持手动入口 IP、主机 DDNS 域名、自动检测 IPv4/IPv6 入口地址展示，IPv6 入口可单独复制。
- 支持 GOST 隧道、ForwardX 自定义加密隧道、Nginx Stream 隧道和 Nginx TLS 隧道，支持原生 UDP 加密转发、多跳链路、入口组、出口组和多出口负载均衡。
- ForwardX 自定义加密隧道可选 mimic UDP 混淆；UDP 仍走数据报通道，不再通过 TCP 承载，适合游戏、语音、直播等实时 UDP 场景。
- 支持端口转发链，把多台主机按顺序串成入口、中转和出口路径，也可以复用入口组作为多入口统一入口。
- 支持转发组，把多个主机入口作为一个高可用入口使用；隧道多入口场景可通过入口组复用。
- 支持主机、转发规则、隧道、端口转发、转发链、转发组、入口组和出口组拖动排序，默认按高优先级到低优先级故障转移。
- 支持 DDNS 故障转移，当前支持 Cloudflare、华为云、阿里云、腾讯云 DNSPod 和 Webhook 服务商。
- 支持入口组 DDNS 自动解析，也支持关闭自动解析后手动维护域名记录。
- 支持服务恢复后自动切回原入口，也可以关闭切回等待当前入口故障后再切换。
- 支持转发规则统一搜索，可按端口、入口/目标 IP 或域名、备注、主机、用户、隧道和链路名称快速筛选。
- 支持转发规则链路自测、TCPing 延迟探测、链路图、多入口延迟展示、流量统计、最近趋势、系统日志和 DDNS 事件记录。
- 支持用户到期时间、流量额度、端口数、规则数、端口转发、隧道、转发链、转发组资源权限和接入限制管理。
- 支持开放注册开关，关闭后只能由管理员新增用户。
- 支持套餐、余额、兑换码、折扣码、商店开关和支付方式配置。
- 支持邮件验证码、套餐到期提醒、流量不足提醒和 Telegram 机器人。
- 支持面板、Agent 和 Android 客户端版本检测与在线升级。

## 转发模型

ForwardX 里常用的入口方式有四类：

| 模式 | 适用场景 | 说明 |
| --- | --- | --- |
| 端口转发 | 入口和目标都可以由单台主机直接处理 | 先在链路管理中创建端口转发资源，再在转发规则中引用 |
| 隧道转发 | 入口机和出口机不同，或需要加密链路 | 先创建 GOST、ForwardX 或 Nginx 隧道，再在转发规则中选择隧道 |
| 端口转发链 | 需要把 IPv4/IPv6 入口、中转机和落地出口按固定顺序串起来 | 在链路管理中创建端口转发链，可绑定入口组提供多入口，再在转发规则中引用该链 |
| 转发组 | 多台机器对同一目标提供同一服务入口 | 在转发组中维护成员和 DDNS 策略，在转发规则中选择转发组生成成员规则 |

转发规则仍然是最终业务入口：入口端口、协议、目标 IP 和目标端口都在「转发规则」中配置。端口转发、隧道、端口转发链和转发组负责提供不同的入口或链路能力，同一条链路资源可以被多条规则复用。

入口地址展示会按优先级选择：用户手动设置的入口 IP/域名优先，其次是主机或入口组 DDNS 域名，最后回退到自动检测的公网 IP。存在 IPv6 入口时会保留 IPv6 展示；端口转发链绑定入口组并配置入口组 DDNS 时，规则卡片会优先只展示入口组域名，避免多入口场景信息过载。

## 链路管理与故障转移

「链路管理」统一管理隧道链路、端口转发链、转发组、入口组和出口组：

- 隧道链路：适合入口机和出口机不同，或需要 ForwardX/GOST 加密链路的场景。
- 端口转发链：适合多台服务器按顺序转发，例如多入口 -> 中转 -> 落地出口。
- 转发组：适合多台主机为同一目标提供高可用入口。
- 入口组：把多台入口主机收敛到一个入口域名，供隧道或端口转发链复用。
- 出口组：把多个出口主机作为隧道出口资源，便于统一编排。

转发组用于解决多机器同时转发和入口高可用问题：

1. 在「链路管理 -> 转发组」中创建转发组。
2. 添加多个入口成员，并通过鼠标拖动调整优先级。
3. 配置 DDNS 域名、记录类型、故障转移时间和是否恢复后切回。
4. 在「转发规则」中选择转发组，填写入口端口、协议和目标地址。
5. ForwardX 会为组内成员生成同一目标的真实转发规则，并根据 TCPing 健康数据执行故障转移。

端口转发链用于解决固定路径转发问题：

1. 可先创建入口组，把多台入口服务器绑定到同一个入口域名。
2. 创建端口转发链，选择是否引用入口组，再按顺序添加中转和出口主机。
3. 在链路成员中选择公网、内网或 IPv6 连接地址。
4. 在「转发规则」中选择端口转发链，填写入口端口、协议和最终目标地址。
5. 自测会展示链路节点、入口汇聚、多入口延迟和每段探测结果，便于排查实际流量路径。

故障转移默认从高优先级成员切到低优先级成员。开启「恢复后切回」后，高优先级成员恢复可用时会主动切回；关闭后会保持当前成员，直到当前成员再次故障才触发下一次切换。

DDNS 操作会写入系统日志和转发组/入口组事件，包括跳过、当前记录一致、开始更新、切换成功和更新失败，便于追踪域名入口变化。

## 数据库

首次部署时可以选择 SQLite、MySQL 或 PostgreSQL：

- SQLite 适合单机轻量部署，默认数据文件为 `/data/forwardx.db` 或本地安装目录下的 `data/forwardx.db`。
- MySQL 适合生产环境、长期运维和跨机器迁移。
- PostgreSQL 适合已有 PostgreSQL 运维体系或偏好 PostgreSQL 的生产环境。
- 首次打开面板会进入初始化向导，先选择数据库，再选择新面板或从旧面板迁移。
- 如果连接的是已有数据库，且里面已经存在管理员账户，会直接进入登录流程。
- 原地升级会保留已有配置和数据；Docker 部署会保留数据卷，本地 systemd 部署会保留安装目录下的 `data` 目录。
- 数据库备份建议由用户在 SQLite 文件、MySQL 或 PostgreSQL 侧自行维护。

MySQL 和 PostgreSQL 默认连接池按约 30 台 Agent 主机的常规生产使用量配置：最大连接数 `50`、空闲连接 `10`、连接最长生命周期 `30` 分钟、空闲回收 `5` 分钟、连接超时 `6000` 毫秒。小规模部署（例如 7-8 台主机）可降到 `DATABASE_MAX_OPEN_CONNS=20`、`DATABASE_MAX_IDLE_CONNS=5`；30 台左右建议先使用默认值；更大规模或多管理员高频查看时再逐步提高到 `80-100` 最大连接和 `20-40` 空闲连接。

这些参数通过环境变量调整，MySQL 和 PostgreSQL 共用同一组连接池变量；SQLite 不使用连接池参数。调整时要同时确认数据库服务端的连接上限：PostgreSQL 的 `max_connections`、MySQL 的 `max_connections` 应大于所有 ForwardX 实例 `DATABASE_MAX_OPEN_CONNS` 的总和，并预留运维、备份和其他程序连接余量。Docker 部署可在部署目录 `.env` 中增加变量后重启容器；本地 systemd 部署可在服务环境变量或安装目录环境配置中增加变量后重启 `forwardx-panel.service`。

## 快速部署

首次部署时，面板默认访问端口为 `9810`。Docker 部署默认映射宿主机 `9810` 到容器内 `3000`；升级会读取已有端口配置，不影响已部署实例。

以下命令请以 `root` 用户执行；如果当前不是 `root`，把命令中的 `bash` 替换为 `sudo bash`。

### 本地 systemd 部署

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- install
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- uninstall
```

默认路径：

| 项目 | 路径 |
| --- | --- |
| 安装目录 | `/opt/forwardx-panel` |
| 服务名称 | `forwardx-panel.service` |
| 数据库配置 | `/opt/forwardx-panel/data/database.json` |
| SQLite 数据文件 | `/opt/forwardx-panel/data/forwardx.db` |

### Docker Compose 部署

安装：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- uninstall
```

Docker 部署默认会把数据库配置保存到数据卷中的 `/data/database.json`，SQLite 数据文件保存在 `/data/forwardx.db`。
默认拉取 `ghcr.io/poouo/forwardx:latest` 预编译镜像，不会在用户服务器上重新构建镜像。
安装和升级会保留 `.env`、Docker 数据卷和部署目录内的 `data/` 数据；只有执行卸载脚本并输入 `y` 后才会删除部署目录和 Docker 数据卷。


## 首次初始化

1. 访问 `http://服务器IP:9810`。
2. 选择 SQLite、MySQL 或 PostgreSQL，并完成连接检测。
3. 选择作为新面板使用，或输入旧面板地址和管理员账户发起迁移。
4. 如果是新库，注册第一个管理员账户；如果是旧库或迁移完成，直接使用原管理员账户登录。
5. 登录后建议在系统设置中配置面板公开地址、Agent Token、邮件、开放注册和 DDNS 服务商。

## 安装 Agent

在面板「系统设置 -> Agent Token」中创建 Token，然后在被管理的 Linux 主机上执行：

如果已配置面板公开域名，Agent Token 的安装命令弹窗会默认使用公开域名；需要 IP+端口直连时，可用 IP+端口打开面板后在弹窗中选择“当前访问地址”。

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

升级 Agent：

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- upgrade YOUR_AGENT_TOKEN
```

卸载 Agent：

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- uninstall
```

## 基本使用流程

1. 部署 ForwardX 面板并完成数据库初始化。
2. 在「系统设置」中创建 Agent Token。
3. 在被控服务器安装 Agent。
4. 在「主机管理」中确认 Agent 在线。
5. 在「链路管理」中创建需要的 GOST/ForwardX 隧道、端口转发链、入口组、出口组或转发组。
6. 按需为链路配置 DDNS、成员优先级、入口组域名和故障转移策略。
7. 在「转发规则」中选择端口转发、隧道、端口转发链或转发组创建真实转发。
8. 在规则自测、链路延迟、系统日志和 DDNS 事件中观察转发路径、故障转移和规则同步状态。

## 隧道说明

ForwardX 支持这些隧道：

- GOST 隧道：使用 GOST 提供的 TLS、WSS、TCP、MTLS、MWSS、MTCP 等模式。
- ForwardX 自定义加密隧道：由 ForwardX Agent 建立入口到出口的加密链路，支持 TCP/UDP、按规则流量统计和用户限速。
- Nginx Stream 隧道：使用 Nginx Stream 做四层中转，支持 TCP、UDP 和 TCP+UDP，适合出口组负载均衡。
- Nginx TLS 隧道：使用 Nginx TLS Stream 做 TCP 链路中转，仅支持 TCP；UDP 场景请使用 Nginx Stream。

自定义加密隧道可以在入口和出口 Agent 下方指定连接地址。不填写时默认走公网入口；填写内网 IP 或 IPv6 地址时，会优先使用指定地址作为链路连接目标。隧道也可以引用入口组提供多入口，或配置多个出口节点用于出口负载均衡。

需要绕过 UDP 识别或限制时，可以在 ForwardX 隧道规则中开启 mimic UDP 混淆。该功能要求相关 Agent 主机已安装 mimic/mimic-dkms，并在主机管理中配置正确网卡名；面板只下发 filter 配置，mimic 负责透明混淆，ForwardX 继续负责加密转发。

## Telegram 机器人

1. 在 Telegram 找到 `@BotFather` 创建机器人并复制 Bot Token。
2. 在面板「系统设置 -> 系统信息 -> Telegram 机器人」填写 Token 并启用；也可以通过环境变量 `TELEGRAM_BOT_TOKEN` 配置。
3. 用户登录面板后，在右下角用户菜单点击「绑定 Telegram」，再点击「使用 Telegram 绑定」。
4. Telegram 会打开机器人并携带一次性绑定码，点击 Start 即可完成绑定；也可以手动发送 `/bind 绑定码`。

绑定后可使用：

- `/usage`：查询自己的流量、到期时间、规则/端口配额。
- `/rules`：查看自己的转发规则。
- `/enable 规则ID`、`/disable 规则ID`：启用或停用自己的规则。
- `/login`：生成 5 分钟有效的一次性网页登录链接。
- `/unbind`：解除当前 Telegram 绑定。

管理员绑定 Telegram 后还可使用 `/users` 查看用户流量概览，使用 `/reset 用户ID` 重置指定用户流量。机器人采用 Telegram 长轮询，不需要配置 webhook；服务器需要能访问 `api.telegram.org`。

## 用户、套餐与支付

管理员可以：

- 控制访客是否开放注册，关闭后只能由管理员新增用户。
- 创建用户并设置总开关、到期时间、流量额度、规则数、端口数、连接数和 IP 接入限制。
- 分配可用端口转发、隧道、转发链和转发组。
- 创建套餐并配置价格、周期、流量、端口数和权限范围。
- 开启或关闭商店功能。
- 配置支付接口。商店开启后，用户在购买时选择管理员已启用的支付方式。
- 生成余额兑换码、套餐兑换码和折扣码。

商店默认关闭。关闭时，管理员可以手动给用户充值、分配套餐或调整权限。

## 流量与限制

- 流量按 Agent 上报的规则增量累计。
- 首页趋势图默认按 30 分钟聚合展示。
- TCPing 默认用于链路健康探测、链路自测和延迟趋势展示。
- GOST 和 ForwardX 自定义加密隧道支持用户限速。
- `iptables`、`nftables`、`realm`、`socat`、`nginx` 当前主要用于转发和统计，不作为限速主路径。`iptables`/`nftables` 属于内核 NAT/防火墙规则，跨 IPv4/IPv6 入口和目标时应改用 `realm`、`socat`、`gost`、`nginx` 等用户态转发或统一协议族。
- 连接数限制主要针对 TCP 生效；隧道转发按隧道维度聚合，端口转发按主机维度聚合。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9810` | 面板监听端口；Docker Compose 中通常是宿主机访问端口，容器内仍监听 `3000` |
| `DATABASE_CONFIG_PATH` | `/data/database.json` | 面板保存数据库连接配置的位置 |
| `SQLITE_PATH` | `/data/forwardx.db` | SQLite 默认数据文件路径 |
| `DATABASE_TYPE` / `DB_TYPE` | 空 | 可选，强制指定 `mysql`、`postgresql` 或 `sqlite` |
| `DATABASE_MAX_OPEN_CONNS` / `DB_MAX_OPEN_CONNS` | `50` | MySQL/PostgreSQL 连接池最大连接数，默认按约 30 台 Agent 主机配置 |
| `DATABASE_MAX_IDLE_CONNS` / `DB_MAX_IDLE_CONNS` | `10` | MySQL/PostgreSQL 连接池最大空闲连接数，不能超过最大连接数 |
| `DATABASE_CONN_MAX_LIFETIME_MINUTES` / `DB_CONN_MAX_LIFETIME_MINUTES` | `30` | MySQL/PostgreSQL 连接最长生命周期，`0` 表示不主动按生命周期回收 |
| `DATABASE_CONN_MAX_IDLE_TIME_MINUTES` / `DB_CONN_MAX_IDLE_TIME_MINUTES` | `5` | MySQL/PostgreSQL 空闲连接回收时间 |
| `DATABASE_CONNECT_TIMEOUT_MS` / `DB_CONNECT_TIMEOUT_MS` | `6000` | MySQL/PostgreSQL 建立连接超时时间，单位毫秒 |
| `MYSQL_CONFIG_PATH` | `/data/mysql.json` | 兼容旧版 MySQL 配置文件路径 |
| `MYSQL_URL` | 空 | 可选，通过环境变量直接提供 MySQL 连接串 |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | 空 | 可选，通过环境变量提供 MySQL 连接信息 |
| `MYSQL_SSL` | `false` | MySQL 是否启用 SSL |
| `POSTGRES_URL` / `POSTGRESQL_URL` / `PG_URL` | 空 | 可选，通过环境变量直接提供 PostgreSQL 连接串 |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DATABASE` | 空 | 可选，通过环境变量提供 PostgreSQL 连接信息 |
| `POSTGRES_SSL` | `false` | PostgreSQL 是否启用 SSL |
| `JWT_SECRET` | `change-me-to-a-random-string` | 登录签名密钥，生产环境必须修改 |
| `TELEGRAM_BOT_TOKEN` | 空 | Telegram 机器人 Token |
| `FORWARDX_IMAGE` | `ghcr.io/poouo/forwardx:latest` | Docker 部署使用的预编译镜像 |
| `FORWARDX_TARGET_VERSION` | 空 | 本地非 Docker 部署可指定安装或升级版本，例如 `v2.3.12`；Docker 部署固定使用 `latest` 镜像 |

## 手动 Docker Compose

```bash
git clone https://github.com/poouo/Forwardx.git
cd Forwardx
docker compose -p forwardx pull forwardx
docker compose -p forwardx up -d
```

Docker Compose 默认会拉取 GitHub Packages 上的预编译镜像 `ghcr.io/poouo/forwardx:latest`，服务器本地不需要再执行镜像编译。
手动升级时重新拉取 `latest` 并重启容器即可，数据卷会保留：

```bash
git fetch --force --prune origin "+refs/heads/*:refs/remotes/origin/*" "+refs/tags/*:refs/tags/*"
git checkout main
docker compose -p forwardx pull forwardx
docker compose -p forwardx up -d --remove-orphans
```

## 本地开发

```bash
pnpm install
pnpm dev
```

构建与版本校验：

```bash
pnpm build
pnpm check:versions
```

## Android APK

ForwardX Android 客户端用于手机端访问面板，登录时填写面板地址、账号和密码即可。

下载地址：
https://github.com/poouo/Forwardx/releases/download/v2.3.221/forwardx-android-v2.3.79.apk

常用命令：

```bash
pnpm mobile:sync:android
pnpm mobile:apk
```

## 安全建议

- 使用强密码注册管理员账户。
- 生产环境关闭不需要的开放注册。
- 设置随机 `JWT_SECRET`。
- 使用 MySQL 或 PostgreSQL 时建议设置独立账号，并只授予 ForwardX 所需数据库权限。
- 定期备份 MySQL/PostgreSQL 数据库或 SQLite 数据文件。
- 使用防火墙或反向代理限制面板访问范围。
- 妥善保存 Agent Token，泄露后应立即禁用并重新生成。
- DDNS Token 建议只授予目标域名所需的最小权限。

## V我50喝咖啡

USDT：
TRON ：`TGCVssNj5v58JPHxPZLLVQXsphQzLqQ3fK`

Solana ：`8XvFdKNmESquSSJqhYepqqPJkWUqtBXn4jgeDjXyhzHU`

BNB Smart Chain ：`0x44543FE6C5569Efe2b0Dc13454D4008378c92fE3`


## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).

## Star 趋势

[![Star History Chart](https://api.star-history.com/svg?repos=poouo/Forwardx&type=Date)](https://www.star-history.com/#poouo/Forwardx&Date)
