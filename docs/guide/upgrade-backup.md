# 升级和备份

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

## 更新日志

升级前建议查看 GitHub Release 或项目更新日志，确认是否包含面板、Agent 或 Android 客户端更新。

## 卸载

如果需要卸载面板或 Agent，请先确认是否需要保留数据库、配置和转发规则，再参考 [卸载 ForwardX](./uninstall.md)。
