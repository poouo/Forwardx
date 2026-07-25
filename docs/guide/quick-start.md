# 快速开始

本页适合第一次部署 ForwardX 的用户。按顺序完成后，你将获得一个可用的面板，并让第一台服务器上线。

## 1. 部署面板

推荐使用 Docker 一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install
```

安装完成后访问面板：

```text
http://服务器IP:9810
```

不使用 Docker 的情况，参考 [部署面板](./deploy-panel.md) 中的 systemd 本地部署方式。

## 2. 初始化面板

首次打开面板后按向导操作：

1. 选择数据库（不确定时选 SQLite）。
2. 测试数据库连接。
3. 创建第一个管理员账号。
4. 登录面板。
5. 在「系统设置」中填写面板公开地址。

> **注意**：使用 Docker 并选择 MySQL/PostgreSQL 时，数据库地址须填写容器内部可访问的地址。日志出现 `getaddrinfo ENOTFOUND` 时，通常是数据库主机名在容器内无法解析。

## 3. 创建 Agent Token

进入面板：

```text
主机管理 -> Token 管理
```

点击「添加」，为即将接入的服务器创建一个 Token。Token 用于让服务器注册到当前面板。

## 4. 安装 Agent

在 Token 管理列表中，点击对应 Token 的「安装命令」，复制面板生成的命令，在需要被管理的 Linux 服务器上执行。命令格式如下：

```bash
# HTTP（未配置域名时）
curl -fsSL http://你的面板IP:9810/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN

# HTTPS（已配置域名时）
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
```

安装完成后进入「主机管理」，看到绿色在线状态即表示 Agent 注册成功。

## 5. 创建第一条转发规则

进入面板：

```text
转发规则 -> 添加规则
```

填写规则信息，例如：

| 配置项   | 示例值    |
| -------- | --------- |
| 规则名称 | 测试规则  |
| 协议     | TCP       |
| 入口端口 | `15201`   |
| 目标地址 | `1.2.3.4` |
| 目标端口 | `5201`    |

保存后，访问 `入口服务器IP:15201` 的流量将被转发到 `1.2.3.4:5201`。

## 6. 链路测试

规则创建后，点击规则列表中的「链路测试」或「自测」按钮，确认转发链路正常后再交付使用。

::: tip 建议
面板部署完成后，请先在「系统设置」中配置面板公开地址。若后续将 IP 改为域名，务必同步更新该设置，否则 Agent 可能继续使用旧地址导致连接异常。
:::
