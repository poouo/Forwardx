# 部署面板

本页是部署入口。先选择部署方式，再完成数据库初始化、公开地址设置和 Agent 接入。面板负责管理，实际业务转发由 Linux 主机上的 Agent 与转发运行时执行。

## 部署方式

| 方式 | 适用场景 | 下一步 |
| --- | --- | --- |
| Docker 一键安装 | 希望由安装脚本管理容器、镜像和数据卷 | [Docker 部署](./deploy-docker.md) |
| Docker 手动 Compose | 已有容器管理流程，需要自行维护配置 | [手动 Compose](./deploy-docker.md#手动-compose-部署) |
| 本地安装 | 不使用 Docker，由宿主机服务管理进程 | [本地部署](./deploy-local.md) |
| 源码开发 | 修改代码、验证页面和接口；不用于公网生产 | [本地开发](./development.md) |

正式部署推荐单面板实例。数据库支持 SQLite、MySQL 和 PostgreSQL；使用外部数据库不会自动获得多副本部署能力。

## 推荐顺序

1. 阅读 [部署前准备](./preparation.md)，规划端口、防火墙和数据库。
2. 按所选方式安装面板；脚本可预先询问数据库类型。
3. 访问面板并完成 [首次初始化](./first-setup.md)，确认数据库和管理员。
4. 配置 [域名、HTTPS 和反向代理](./reverse-proxy.md)，填写 Agent 实际可访问的公开地址。
5. 在「主机管理 → Token 管理」为每台主机创建 Token，按页面命令 [安装 Agent](./agent.md)。
6. 先创建链路资源，再 [创建转发规则](./rules.md)。

## Docker 一键部署

完整安装命令、数据卷和升级方式见 [Docker 部署](./deploy-docker.md)。默认宿主机端口为 9810，容器内端口为 3000。

## Docker 手动部署

见 [手动 Compose 部署](./deploy-docker.md#手动-compose-部署)。手动部署与脚本管理使用不同的配置维护方式，避免混用升级流程。

## 本地 systemd 一键部署

见 [本地部署](./deploy-local.md)。默认目录为 /opt/forwardx-panel；systemd 环境的服务名为 forwardx-panel.service，安装脚本也适配 OpenRC / SysV。

## 本地 systemd 手动部署

见 [手动维护发布包](./deploy-local.md#手动维护发布包)。生产部署使用 Release 发布包，不要使用开发模式代替正式服务。

## 重置管理员密码

见 [管理员账号恢复](./account-recovery.md)。无需删除数据库，也不要通过重新安装来重置已有管理员。

## 使用 GitHub 加速站安装和升级

两个安装脚本均支持 --github-accelerator；首次下载脚本本身也需使用可信加速前缀。完整示例见 [Docker 部署](./deploy-docker.md#github-下载加速) 和 [升级与备份](./upgrade-backup.md#github-加速升级)。该参数不加速 ghcr.io 镜像拉取。

## 配置域名和 HTTPS

见 [HTTPS 与反向代理](./reverse-proxy.md)。必须完整转发 API 和 SSE，不缓存 Agent 认证、报告与事件流。

## 首次进入面板

见 [首次初始化](./first-setup.md)。复用已有数据库时使用原管理员账号，不会因重装自动生成新管理员。

## 配置与运维索引

- [数据库配置与连接排查](./database.md)
- [环境变量及生效方式](./env-vars.md)
- [安装目录、数据与日志](./paths-logs.md)
- [升级与备份](./upgrade-backup.md)
- [迁移到新面板](./migration.md)
- [卸载与数据保留](./uninstall.md)
