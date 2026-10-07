# 升级和备份

## 升级前建议

先备份并查看 [GitHub Release](https://github.com/poouo/Forwardx/releases) 或项目更新日志，确认面板、Agent 和移动客户端的兼容要求。升级可能变更数据库结构，不要将“替换旧镜像”视为完整回退方案。

同时保存 .env、Compose/服务配置、证书和数据库连接配置。备份含密码和私钥，应限制读取并加密保存；备份完成后验证能够恢复。

### 面板加密导出

网页可用时，在「系统设置 → 备份恢复」生成加密备份，妥善保存备份和密码。应用导出不能替代外部证书、反向代理文件与自定义服务配置的备份。

### 备份 SQLite（本地部署）

**不要在数据库正在写入时，仅复制 forwardx.db 主文件**；WAL 中可能还有未合并的数据，导致备份不完整。

安装了 sqlite3 命令时，可以使用 SQLite 在线备份 API，以下按默认路径演示；目标备份名应使用新的、不覆盖已有文件的路径：

~~~bash
sqlite3 -readonly /opt/forwardx-panel/data/forwardx.db ".backup '/root/forwardx-sqlite-backup.db'"
sqlite3 /root/forwardx-sqlite-backup.db "PRAGMA quick_check;"
~~~

另一种方式是停止面板写入后，备份完整 data 目录与 .env，再启动服务。确认没有其他进程写入同库；不要忽略 -wal / -shm 文件，不要在线手动删除它们。

### Docker 数据目录备份

在维护窗口执行，短暂停止面板后复制完整 /data，使用新建目录保存。以下操作不删除数据卷：

~~~bash
backup_dir="$(mktemp -d /root/forwardx-backup.XXXXXX)"
docker stop forwardx-panel
docker cp forwardx-panel:/data "$backup_dir/data"
docker start forwardx-panel
~~~

逐条确认结果；复制失败也应按计划恢复服务。另行保存宿主机部署目录中的 .env 和 Compose 文件。外部 MySQL/PostgreSQL 的业务表不在此数据卷中，需要单独备份数据库。

### 备份 MySQL

~~~bash
mysqldump --single-transaction -h 127.0.0.1 -u forwardx -p forwardx > forwardx.sql
~~~

替换实际连接参数；使用新的文件名，避免覆盖旧备份。--single-transaction 适用于事务表，备份期间避免 DDL 变更，其他表引擎按数据库运维方案处理。

### 备份 PostgreSQL

~~~bash
pg_dump -h 127.0.0.1 -U forwardx -d forwardx -Fc -f forwardx.dump
~~~

使用与服务器兼容的 pg_dump 版本和新的文件名。不要将密码写进命令行。以上备份包含应用库，不包含数据库服务器全部角色、配置与外部文件。

## 面板升级

原地升级会重建容器或重启面板服务，管理页面可能短暂不可用；不要将它与 [无缝迁移](./migration.md) 混为一谈。升级后检查实际版本、数据库状态、Agent 在线状态，并测试实际业务。

::: tip 权限说明
安装、升级和卸载面板通常需要 root 权限。使用一键脚本时可以用 root 执行，也可以在命令中保留 `sudo`。
:::

### Docker 部署

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade
```

指定版本升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | sudo env FORWARDX_TARGET_VERSION=vX.Y.Z bash -s -- upgrade
```

升级会保留数据卷与脚本识别的核心配置，但会重新生成 Compose 和 `.env`，不会原样保留所有手动新增项。升级前备份并核对自定义网络、挂载和环境变量。如果目标镜像尚未构建完成，脚本会提示稍后重试并保留旧容器运行。手动 Compose 部署请继续按 [手动升级流程](./deploy-docker.md#手动-compose-部署) 操作，避免混用安装器。

升级完成后不要只看镜像拉取提示，可核对运行容器实际使用的镜像和程序版本：

```bash
docker inspect --format '{{.Config.Image}} {{.Image}}' forwardx-panel
docker exec forwardx-panel node -p "require('./package.json').version"
```

第一项是镜像标签和镜像 ID，第二项是容器内程序版本。如果仍显示旧版本，检查是否操作了同名的另一套 compose 项目、脚本是否复用了旧部署目录，以及目标 Release 镜像是否已构建完成。

### 本地 systemd 部署

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

指定版本升级：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | sudo env FORWARDX_TARGET_VERSION=vX.Y.Z bash -s -- upgrade
```

本地部署升级会保留 `data`、数据库配置和已有数据，并重新生成 `.env`；脚本只保留其识别的核心项，自定义环境与服务配置需提前备份并在升级后核对。如果面板程序包尚未上传到 GitHub Release，脚本会提示等待 GitHub Actions 构建完成。

### GitHub 加速升级

一键脚本可为 Docker 和本地 systemd 升级指定 GitHub 加速站：

```bash
# Docker
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh" \
  | bash -s -- upgrade --github-accelerator "https://mirror.example.com"

# 本地 systemd
curl -fsSL "https://mirror.example.com/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh" \
  | bash -s -- upgrade --github-accelerator "https://mirror.example.com"
```

脚本会把加速地址保存到部署 `.env`，后续升级可继续使用。加速请求失败会自动回退直连 GitHub，不需要手动切换命令。

面板内可前往「系统设置 -> 系统配置 -> GitHub 下载加速」，填写加速站并开启「面板更新使用加速站」。开启后，面板的版本检查、Release 信息、安装包检测、版本回退和升级命令会优先使用加速站；关闭后仍使用原始 GitHub 地址。

GitHub 加速不会作用于 `ghcr.io` Docker 镜像。需要更换镜像源时，请通过 `FORWARDX_IMAGE` 或 `FORWARDX_IMAGE_REPO` 单独配置。

## Agent 升级

可以在面板中选择主机批量升级 Agent，也可以单独选择某台主机升级。

如果 Agent 因面板地址变化而失联，可在 Agent 主机重新执行安装或升级命令，并指定当前正确的面板地址。

查看 Agent 日志：

```bash
tail -n 300 /var/log/forwardx-agent/agent-go.log
journalctl -u forwardx-agent -n 300 --no-pager
```

## 浏览器未保存已生成的加密备份

Safari 等浏览器可能在服务器已经完成加密导出后，因站点下载权限或浏览器策略阻止本地保存。这种情况不会导致服务器持续生成备份，也不需要重新开始导出：

1. 保持当前“系统设置 → 备份恢复”页面打开。
2. 允许该站点下载文件。
3. 点击页面中的“再次保存已生成备份”。

只有页面明确提示服务器导出失败时才重新导出。导出期间 CPU 短时升高通常来自数据库读取、裁剪和加密；浏览器保存失败发生在生成完成之后，不会让服务器继续加密。若任务结束后面板宿主机仍持续满载，使用 `docker stats forwardx-panel` 和 `ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head` 确认实际占用，再结合面板日志排查。

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

## 在线迁移面板

完整操作、接管验证及失败恢复见 [迁移到新面板](./migration.md)。

### 无缝模式（默认选择）

Agent 保持旧面板 URL，旧面板转交请求；迁移不主动停止或重建业务转发。要求同版本、同数据库类型和单实例，必须持续保留旧地址与转交服务，不能迁移后直接卸载旧面板。此模式不承诺主机或网络故障时连接不断。

### 普通模式（关闭无缝开关）

会切换 Agent 的面板地址，可能重建运行时，不保证现有连接不中断。旧数据保留，接管成功并验证稳定后再处理旧服务。

## 更新日志

升级前建议查看 [GitHub Release](https://github.com/poouo/Forwardx/releases) 或项目更新日志，确认是否包含面板、Agent 或移动客户端更新。

## 卸载

如果需要卸载面板或 Agent，请先确认是否需要保留数据库、配置和转发规则，再参考 [卸载 ForwardX](./uninstall.md)。
