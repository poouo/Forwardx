# 安装 Agent

Agent 是安装在被管理服务器上的程序，负责执行转发规则、上报主机状态、统计流量和执行链路测试。

## 创建 Agent Token

进入：

```text
系统设置 -> Agent Token
```

创建一个 Token。Token 用来允许服务器注册到当前面板。

## 在服务器安装 Agent

复制面板中的安装命令，或按下面格式执行：

```bash
curl -fsSL http://你的面板地址:3000/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
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

可以在面板的主机管理中点击升级，也可以在服务器执行：

```bash
curl -fsSL http://你的面板地址:3000/api/agent/install.sh | bash -s -- upgrade YOUR_AGENT_TOKEN
```

如果面板地址变化导致 Agent 离线，可以重新执行带正确面板地址的安装或升级命令。

## 卸载 Agent

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
cat /etc/forwardx-agent/config.json
```

重点确认：

- 面板地址是否正确。
- 是否仍然是旧 IP。
- 如果面板已经改成 HTTPS 域名，Agent 是否也使用 HTTPS 域名。

