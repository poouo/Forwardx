# 安装目录、数据与日志

下列是默认路径。若安装时改过目录、容器名、服务名或环境变量，应以实际配置为准。

新版脚本部署可直接运行 `fwxm` 打开 [管理菜单](./ssh-management.md)，用 `fwxm panel info` / `fwxm agent info` 查看记录的配置路径和服务信息，用对应的 `logs` 查看持续日志。

## 面板目录

| 用途 | Docker | 本地安装 |
| --- | --- | --- |
| 宿主机部署目录 | /opt/forwardx-docker | /opt/forwardx-panel |
| 程序目录 | 容器 /app | /opt/forwardx-panel |
| 启动环境 | 部署目录 .env + Compose environment | 安装目录 .env，由服务加载 |
| 数据目录 | 容器 /data，映射命名卷 | /opt/forwardx-panel/data |
| 数据库连接配置 | /data/database.json | /opt/forwardx-panel/data/database.json |
| SQLite 数据库 | /data/forwardx.db | /opt/forwardx-panel/data/forwardx.db |
| 旧 MySQL 配置兼容路径 | /data/mysql.json | /opt/forwardx-panel/data/mysql.json |
| SSH 管理命令（宿主机） | /usr/local/bin/fwxm | /usr/local/bin/fwxm |
| 管理脚本和元数据（宿主机） | /etc/forwardx/manage | /etc/forwardx/manage |

Docker 数据卷通常为 forwardx_forwardx-data，而不是宿主机部署目录的 data 子目录。实际挂载查询：

~~~bash
docker inspect forwardx-panel --format '{{range .Mounts}}{{println .Type .Name .Source .Destination}}{{end}}'
~~~

无缝迁移状态文件 seamless-migration.json 默认位于数据库配置文件所在目录旁，含敏感接管凭据；需要持久化，不能随意删除或公开。

## 面板日志

系统输出：

~~~bash
# Docker
docker logs --tail 300 forwardx-panel

# 本地 systemd
journalctl -u forwardx-panel -n 300 --no-pager
~~~

当天结构化日志为 `panel.jsonl`，跨天后归档为 `panel.YYYY-MM-DD.jsonl`。按面板运行环境时区保留今天、昨天、前天，每天一个文件，启动时及每日零点自动清理过期归档。网页日志、分页、筛选和导出同时覆盖保留的三天。目录按以下顺序确定：

1. 配置了 FORWARDX_LOG_DIR 时使用该目录。
2. 非 Windows 且 /data 存在时使用 /data/logs。
3. 其他情况使用进程工作目录下的 data/logs。

因此 Docker 通常为 /data/logs/panel.jsonl，本地默认通常为 /opt/forwardx-panel/data/logs/panel.jsonl；本地宿主机若已有 /data，则可能写入 /data/logs。可配置 FORWARDX_LOG_DIR 固定位置。

~~~bash
docker exec forwardx-panel tail -n 300 /data/logs/panel.jsonl
~~~

非 systemd 安装还可检查安装目录 data/panel.log。页面可打开时，也可从系统日志页面按时间、级别筛选并导出。

## Agent 路径

| 用途 | 路径 |
| --- | --- |
| 通讯配置 | /etc/forwardx/agent/config.json |
| 日志 | /var/log/forwardx-agent/agent-go.log |
| 自升级安装日志 | /var/log/forwardx-agent/agent-upgrade.log |
| 持久化状态 | /var/lib/forwardx-agent/ |
| 临时运行态 | /run/forwardx-agent/ |
| 独立 Nginx 程序 | /usr/local/bin/forwardx-nginx |
| 独立 Nginx 配置 | /etc/forwardx/nginx/nginx.conf |

~~~bash
tail -n 300 /var/log/forwardx-agent/agent-go.log
journalctl -u forwardx-agent -n 300 --no-pager
~~~

Agent 当天主日志保持为 `agent-go.log`，跨天归档为 `agent-go.YYYY-MM-DD.log`，按 Agent 运行环境时区保留今天、昨天、前天，后台自动清理过期归档，即使没有新日志也会检查。已有的单文件及目录体积保护仍生效，高频日志达到上限时可能提前裁剪；运行时独立日志继续受大小和时长限制。

三天策略针对 ForwardX 自己管理的日志文件。Docker `logs`、systemd journal、安装器重定向的 `panel.log` 等系统输出由部署环境单独管理，不会由应用删除；需要按对应的 Docker/journald/logrotate 配置限制占用。

ForwardX Nginx 与系统 nginx.service 不是同一个服务。临时运行态和监听配置由 Agent 管理，不要把编辑 /run 中的生成文件当成持久化设置。

代理配置保存在 Agent 的 `config.json` 中，代理 URL 可能包含密码。管理目录包含缓存脚本和元数据，权限由安装器限制；不要将其当作可以随意清空的临时目录。

## 排障时提供什么

提供面板/Agent 版本、部署方式、故障时间与时区、受影响资源 ID、操作步骤，以及故障前后的相关日志。数据库异常同时查看数据库自身日志；面板高负载同时检查宿主机和容器资源：

~~~bash
docker stats --no-stream forwardx-panel
free -h
df -h
~~~

开发环境路径见 [本地开发](./development.md)。备份和恢复见 [升级与备份](./upgrade-backup.md)。

分享前隐藏密码、Token、私钥、数据库连接串、Cookie 和迁移凭据；不要公开完整 .env、database.json 或容器环境输出。详细日志仅在排障期间按需开启。
