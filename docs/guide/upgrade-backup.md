# 升级和备份

## 跨兼容边界升级

ForwardX 后续版本只读取当前数据格式，不在面板和 Agent 的日常运行路径中长期保留旧格式分支。跨越兼容边界升级时，先使用一次性迁移工具转换旧数据；迁移不会随面板启动或安装脚本自动执行。

当前迁移工具会处理：

- 隧道中的旧 Nginx 模式名称，转换为当前 Nginx Stream。
- 转发协议设置中的旧 Nginx 键；如果新旧键同时存在，保留新键的值。
- 用户表中无法按当前格式读取的旧会话缓存；auth_sessions 中的当前有效登录记录不受影响。
- Agent 插件清单中的旧 pluginVersion 字段，原子转换为 version。

默认命令仅预检并显示待迁移数量。只有显式增加 **--apply** 才会写入；重复执行是安全的。执行写入前必须停止面板并备份数据库。

### Docker 面板

先升级到包含迁移工具的目标镜像，然后执行：

~~~bash
cd /opt/forwardx-docker
docker compose stop forwardx
docker compose run --rm --no-deps forwardx node dist/migrate-legacy.js
docker compose run --rm --no-deps forwardx node dist/migrate-legacy.js --apply
docker compose up -d forwardx
~~~

使用旧版 docker-compose 命令的环境，将上面的 **docker compose** 替换为 **docker-compose**。脚本会读取容器原有的数据库配置和数据卷，支持 SQLite、MySQL、PostgreSQL。

### systemd 面板

~~~bash
sudo systemctl stop forwardx-panel
cd /opt/forwardx-panel
set -a
. ./.env
set +a
node dist/migrate-legacy.js
node dist/migrate-legacy.js --apply
sudo systemctl start forwardx-panel
~~~

数据库设置损坏、表结构缺失或迁移未完成时，写入命令会失败且事务回滚，不会写入完成标记。处理提示的问题后可直接重试。

### Agent 插件清单

在安装过插件的 Agent 主机先预检，再确认执行：

~~~bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/migrate-agent-legacy.sh | bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/migrate-agent-legacy.sh | bash -s -- --apply
~~~

该脚本不会升级或重启 Agent。迁移后仍需把 Agent 升级到 2.2.151 或更高版本，并在插件管理中重新同步 Agent；损坏或完全缺少版本的清单必须通过重新同步恢复。

## Docker 升级

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade
```

指定版本升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo env FORWARDX_TARGET_VERSION=vX.Y.Z bash -s -- upgrade
```

Docker 部署升级会保留 `.env`、部署目录数据和 Docker 数据卷。如果 `latest` 镜像尚未构建到目标版本，脚本会提示稍后重试并保留旧容器运行。

## systemd 升级

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

指定版本升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo env FORWARDX_TARGET_VERSION=vX.Y.Z bash -s -- upgrade
```

本地 systemd 部署升级会保留 `.env`、`data` 目录、数据库配置和已有数据。如果面板程序包尚未上传到 GitHub Release，脚本会提示等待 GitHub Actions 构建完成。

::: tip 权限说明
安装、升级和卸载面板通常需要 root 权限。使用一键脚本时可以用 root 执行，也可以在命令中保留 `sudo`。
:::

## 升级前建议

升级前建议备份数据库。

SQLite 本地部署常见备份：

```bash
cp /opt/forwardx-panel/data/forwardx.db /root/forwardx.db.bak
```

Docker 部署建议备份 Docker 数据卷，或先导出数据库。

MySQL：

```bash
mysqldump -h 127.0.0.1 -u forwardx -p forwardx > forwardx.sql
```

PostgreSQL：

```bash
pg_dump -h 127.0.0.1 -U forwardx forwardx > forwardx.sql
```

## Agent 升级

可以在面板中选择主机升级 Agent。

如果 Agent 因为面板地址变化失联，可以在 Agent 主机重新执行安装或升级命令，并指定当前正确面板地址。

查看 Agent 日志：

```bash
journalctl -u forwardx-agent -n 300 --no-pager
```

## 在线迁移面板

迁移前先将新旧面板升级到支持安全迁移的同一版本，并确认旧面板中的在线 Agent 可以正常心跳。

1. 在旧面板的系统设置中生成迁移码。
2. 在新面板初始化向导或系统设置中填写旧面板地址、迁移码和新面板访问地址。
3. 回到旧面板，核对目标地址后批准迁移请求。
4. 等待新面板完成数据校验、公开地址验证、Agent 预切换和原运行规则恢复检查。
5. 页面显示迁移完成后，使用旧面板账号登录新面板检查业务。

只有新面板地址确实指向当前面板、原在线 Agent 已回连，并且迁移前运行的规则和隧道重新运行后，旧面板才会停止控制 Agent。任何检查失败都会取消接管，Agent 会回到旧面板。

旧面板数据库和所有业务记录不会被自动删除。确认新面板稳定运行后，再由用户手动停止或删除旧面板及其数据。

## 更新日志

升级前建议查看 GitHub Release 或项目更新日志，确认是否包含面板、Agent 或 Android 客户端更新。

## 卸载

如果需要卸载面板或 Agent，请先确认是否需要保留数据库、配置和转发规则，再参考 [卸载 ForwardX](./uninstall.md)。
