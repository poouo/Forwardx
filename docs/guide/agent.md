# 安装 Agent

Agent 是安装在被管理服务器上的程序，负责执行转发规则、上报主机状态、统计流量和执行链路测试。

## 创建 Agent Token

进入：

```text
主机管理 -> Token 管理
```

点击“添加主机”或创建新的 Agent Token。Token 用来允许服务器注册到当前面板。

建议一个 Token 只绑定一台被控主机。Token 泄露后，请在 Token 管理中删除或禁用旧 Token，再重新创建。

## 在服务器安装 Agent

在 Token 管理中点击对应 Token 的“安装命令”，复制面板生成的命令，然后在被控 Linux 主机上用 root 权限执行。

安装命令与具体 Token 绑定，推荐始终复制面板生成的命令。命令格式类似：

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

如果使用 HTTPS 域名：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

安装完成后，进入：

```text
主机管理
```

如果主机状态为绿色在线，说明 Agent 已经正常连接面板。

## 升级 Agent

可以在面板的主机管理中点击升级，也可以在 Token 管理的安装命令弹窗中复制升级命令后到服务器执行。命令格式类似：

```bash
curl -fsSL http://你的面板地址:9810/api/agent/install.sh | bash -s -- upgrade YOUR_AGENT_TOKEN
```

如果面板地址变化导致 Agent 离线，可以重新执行带正确面板地址的安装或升级命令。

## 卸载 Agent

卸载命令也可以在 Token 管理的安装命令弹窗中获取。通用卸载命令如下：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | bash -s -- uninstall
```

## 查看 Agent 状态

```bash
systemctl status forwardx-agent
journalctl -u forwardx-agent -n 300 --no-pager
```

查看 Agent 配置：

```bash
cat /etc/forwardx/agent/config.json
```

Agent 常用文件位置：

- Agent 通讯配置：`/etc/forwardx/agent/config.json`
- Agent 日志：`/var/log/forwardx-agent/agent-go.log`
- Agent 本地状态：`/var/lib/forwardx-agent`
- GOST/隧道运行时配置：`/etc/forwardx/runtime`

新版 Agent 会把自己的配置和运行时配置统一放在 `/etc/forwardx` 下。旧版本留下的 `/etc/forwardx-agent`、`/etc/forwardx-runtime`、`/etc/forwardx-tunnel-runtime`、`/etc/forwardx-gost`、`/etc/forwardx-tunnels` 属于历史路径，升级时会优先迁移到新目录，后续不会再继续新增这些分散目录。

重点确认：

- 面板地址是否正确。
- 是否仍然是旧 IP。
- 如果面板已经改成 HTTPS 域名，Agent 是否也使用 HTTPS 域名。
