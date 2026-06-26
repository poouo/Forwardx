# 快速开始

这一页适合第一次部署 ForwardX 的用户。按顺序完成后，你会得到一个可用面板，并让第一台服务器上线。

## 1. 部署面板

普通用户推荐 Docker 部署：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install
```

安装完成后访问：

```text
http://服务器IP:3000
```

如果你不使用 Docker，可以看 [部署面板](./deploy-panel.md) 中的本地 systemd 部署方式。

## 2. 初始化面板

首次打开面板后按向导操作：

1. 选择数据库。
2. 测试数据库连接。
3. 创建第一个管理员账号。
4. 登录面板。
5. 在系统设置中填写面板公开地址。

不确定数据库怎么选时，先用 SQLite。

如果使用 Docker 并选择 MySQL/PostgreSQL，数据库地址要填写面板容器内部能访问到的地址。日志中出现 `getaddrinfo ENOTFOUND` 时，通常是数据库主机名在容器内解析不到。

## 3. 创建 Agent Token

进入：

```text
系统设置 -> Agent Token
```

创建一个 Token。Token 用于让服务器注册到当前面板。

## 4. 安装 Agent

在需要被管理的 Linux 服务器执行：

```bash
curl -fsSL http://你的面板地址:3000/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

如果已经配置 HTTPS 域名：

```bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

安装后进入「主机管理」，看到绿色在线状态就说明成功。

## 5. 创建第一条转发规则

进入：

```text
转发规则 -> 添加规则
```

填写：

| 配置项 | 示例 |
| --- | --- |
| 规则名称 | 测试规则 |
| 协议 | TCP |
| 入口端口 | `15201` |
| 目标地址 | `1.2.3.4` |
| 目标端口 | `5201` |

保存后访问：

```text
入口服务器IP:15201
```

流量会转发到：

```text
1.2.3.4:5201
```

## 6. 做一次链路测试

规则创建后，点击规则中的链路测试或自测按钮。测试通过后再交给用户使用。

::: tip 建议
面板部署完成后先配置面板公开地址。如果后续从 IP 改成域名，也要及时更新后台设置，否则 Agent 可能继续使用旧地址。
:::
