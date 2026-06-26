# 常见问题排查

## 面板打不开

检查：

```bash
docker ps
docker logs -n 300 forwardx-panel
```

或：

```bash
systemctl status forwardx-panel
journalctl -u forwardx-panel -n 300 --no-pager
```

常见原因：

- 面板服务没有启动。
- 端口没有放行。
- 反向代理配置错误。
- 数据库连接失败。
- Docker 镜像没有拉取成功。

## Agent 离线

检查 Agent 日志：

```bash
journalctl -u forwardx-agent -n 300 --no-pager
```

常见原因：

- 面板公开地址错误。
- Agent 配置中还是旧 IP。
- 反向代理没有正确转发。
- HTTP/HTTPS 配置不一致。
- Token 错误或已删除。
- 服务器无法访问面板。

Agent 配置路径：

```text
/etc/forwardx-agent/config.json
```

如果手动改完又被覆盖，通常说明升级脚本或面板下发仍使用旧的公开地址。应先在面板后台修正公开地址，再重新执行 Agent 升级命令。

## 转发不通

按顺序检查：

1. 规则是否启用。
2. 入口端口是否放行。
3. 目标地址和目标端口是否正确。
4. 目标服务本身是否可访问。
5. Agent 主机日志是否有执行失败。
6. 链路测试是否显示哪一段失败。

常用命令：

```bash
nc -vz 目标地址 目标端口
tcpdump -ni any 'port 入口端口'
```

IPv6：

```bash
ip -6 addr show scope global
ip -6 route
sysctl net.ipv6.conf.all.forwarding
tcpdump -ni any 'ip6 and port 入口端口'
```

## IPv6 检测不到

检查主机是否真的有公网 IPv6：

```bash
ip -6 addr show scope global
```

检查 IPv6 路由：

```bash
ip -6 route
```

测试 IPv6 访问：

```bash
ping -6 -c 4 2606:4700:4700::1111
```

如果服务器只有内网 IPv6 或 IPv6 不可出站，面板可能无法作为可用入口展示。

## 规则显示黄色

黄色通常表示规则正在检测、状态不完整或统计没有正常确认。

建议检查：

```bash
journalctl -u forwardx-agent -n 300 --no-pager
nft -a list table inet forwardx
iptables -t nat -S
ip6tables -t nat -S
```

如果转发能通但状态异常，重点看流量统计规则是否存在、计数是否增长。

## Docker 升级后 Agent 全部离线

优先检查：

- 后台面板公开地址是否填写了正确域名。
- 如果使用反向代理 HTTPS，面板公开地址是否也是 HTTPS。
- Agent 配置是否还在使用旧 IP 或旧端口。
- 反向代理是否正常转发 `/api/agent/*`。

如果面板域名、协议或端口发生变化，应先在面板后台修正公开地址，再重新执行 Agent 升级命令。

