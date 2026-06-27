# 卸载 ForwardX

本页说明如何卸载面板和 Agent。卸载前请先确认是否需要备份数据库、配置和日志。

::: warning 先备份
卸载可能删除服务、程序目录、容器或数据卷。生产环境建议先导出面板备份，或手动备份数据库文件。
:::

## 卸载前确认

建议先确认：

- 是否还需要保留用户、主机、规则、套餐和订单数据。
- 是否还需要保留 Agent 主机上的转发规则。
- 是否使用 Docker 数据卷保存 SQLite 数据。
- 是否使用外部 MySQL/PostgreSQL。

如果只是暂时停用，不建议直接卸载，可以先停止服务。

## Docker 面板卸载

如果面板使用 Docker 安装，执行：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- uninstall
```

常用检查命令：

```bash
docker ps -a | grep forwardx
docker volume ls | grep forwardx
```

如果你需要彻底删除 Docker 数据卷，请确认已经备份后再删除对应数据卷。

::: warning 数据卷
Docker 部署的数据通常保存在 Docker volume 中。删除容器不一定删除数据卷，删除数据卷会删除 SQLite 数据库和持久化配置。
:::

## 本地 systemd 面板卸载

如果面板使用本地 systemd 安装，执行：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-local.sh | bash -s -- uninstall
```

常用检查命令：

```bash
systemctl status forwardx-panel
ls -la /opt/forwardx-panel
```

如果脚本保留了数据目录，你可以在确认不再需要后手动删除。

## Agent 卸载

在 Agent 所在服务器执行：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | bash -s -- uninstall
```

检查服务是否还存在：

```bash
systemctl status forwardx-agent
```

检查配置目录：

```bash
ls -la /etc/forwardx
ls -la /var/lib/forwardx-agent
```

如果只是重新绑定到新面板，通常不需要卸载，重新执行当前面板提供的 Agent 安装或升级命令即可。

## 卸载后清理转发规则

正常卸载 Agent 时会尝试清理它维护的转发规则。如果你怀疑仍有残留，可以检查：

```bash
nft -a list table inet forwardx
iptables -t nat -S | grep -i forwardx
ip6tables -t nat -S | grep -i forwardx
```

如果使用的是 nftables，确认没有业务依赖后，可删除 ForwardX 表：

```bash
nft delete table inet forwardx
```

::: danger 谨慎操作
不要随意清空整台机器的 iptables 或 nftables 规则，服务器防火墙、Docker、面板和其他业务可能也在使用这些规则。
:::

## 保留数据后重新安装

如果你保留了数据库和配置，重新安装时注意：

- 面板公开地址要填写当前可访问的域名或 IP。
- 如果使用 HTTPS 反代，公开地址也要写 `https://`。
- Agent 失联时，在 Agent 主机重新执行当前面板提供的安装或升级命令。
- 外部数据库地址要从面板运行环境能访问，Docker 环境不要把 `127.0.0.1` 当成宿主机数据库。
