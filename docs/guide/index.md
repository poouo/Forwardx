# 文档目录

ForwardX 通过 Agent 管理 Linux 主机上的转发资源、业务规则、用户权限、流量和延迟。实际版本以「系统设置 → 系统配置」、主机上报与 [GitHub Releases](https://github.com/poouo/Forwardx/releases) 为准；文档不单独维护版本号清单。

## 第一次使用

[部署前准备](./preparation.md) → [选择部署方式](./deploy-panel.md) → [首次初始化](./first-setup.md) → [安装 Agent](./agent.md) → 创建链路资源 → [添加规则](./rules.md)。

只想先跑通一条规则，直接阅读 [快速开始](./quick-start.md)。

## 面板部署与配置

| 文档 | 内容 |
| --- | --- |
| [部署总览](./deploy-panel.md) | Docker、本地安装与开发模式的选择 |
| [Docker 部署](./deploy-docker.md) | 一键安装、手动 Compose、数据卷和加速 |
| [本地部署](./deploy-local.md) | Linux 服务、发布包与运行环境 |
| [数据库配置](./database.md) | SQLite / MySQL / PostgreSQL、容器网络和连接故障 |
| [HTTPS 与反向代理](./reverse-proxy.md) | 证书、SSE、可信代理和缓存 |
| [环境变量](./env-vars.md) | 启动配置、生效方式和安装器参数 |
| [首次初始化](./first-setup.md) | 语言、数据库、管理员、公开地址与 Token |

## Agent、链路与转发

| 文档 | 内容 |
| --- | --- |
| [安装 Agent](./agent.md) | 每主机独立 Token、安装与升级 |
| [主机管理](./hosts.md) | 主机状态、端口限制及资源监控 |
| [转发规则](./rules.md) | 引用链路、批量操作、管理员单规则限额 |
| [流量和延迟](./traffic-latency.md) | 用量、探测、自测和图表 |
| [隧道链路](./tunnels.md) | GOST、ForwardX V1/V2、Nginx Stream |
| [端口转发链](./port-chains.md) | 固定的入口、中转和出口多跳路径 |
| [转发组、入口组与出口组](./groups.md) | 资源复用、多入口与故障转移 |
| [DDNS 和故障转移](./ddns.md) | DNS 自动更新和切换 |
| [PROXY Protocol](./proxy-protocol.md) | 传递客户端地址及兼容条件 |

链路资源在「链路管理」创建，业务入口端口、目标和协议在「转发规则」配置。端口转发是单机路径；隧道提供跨主机传输；转发链是固定多跳；转发组管理入口集合与故障转移。不要把这些资源当成同一种配置。

## 账户与系统功能

| 文档 | 内容 |
| --- | --- |
| [用户、套餐和权限](./users-billing.md) | 用户授权、额度与计费 |
| [Telegram / Discord 和通知](./notifications.md) | 渠道选择、邮件、绑定、提醒和交互差异 |
| [AI 助手](./ai-assistant.md) | 模型配置、自然语言操作、确认和持久待办 |
| [Google 账户登录](./google-login.md) | OAuth 配置、绑定、注册及登录排障 |
| [移动客户端](./mobile-app.md) | Android APK、iOS 未签名 IPA 与自行签名 |

## 运维与排障

| 文档 | 内容 |
| --- | --- |
| [安装目录、数据与日志](./paths-logs.md) | Docker、本地、Agent 路径和诊断信息 |
| [管理员账号恢复](./account-recovery.md) | 容器内与本地交互式密码重置 |
| [升级与备份](./upgrade-backup.md) | 一致备份、升级、兼容格式转换 |
| [迁移到新面板](./migration.md) | 无缝转交与普通迁移，旧面板保留条件 |
| [常见问题排查](./troubleshooting.md) | 从面板、Agent 到规则和链路逐层定位 |
| [卸载与数据保留](./uninstall.md) | 卸载范围与不可逆数据删除 |

## 开发与扩展

- [本地开发](./development.md)：隔离 SQLite 数据、自动登录和验证命令。
- [插件与扩展开发](./plugins.md)：插件清单、权限、Agent 动作和动态资源。
- [架构参考](../ARCHITECTURE_CN.md)：项目模块与数据流。
- [支付接入参考](../PAYMENT_CN.md)：支付相关配置与接入说明。

截图可能随界面更新略有差异，以当前页面和业务校验提示为准。
