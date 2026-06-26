# 升级和备份

## Docker 升级

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- upgrade
```

## systemd 升级

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- upgrade
```

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

