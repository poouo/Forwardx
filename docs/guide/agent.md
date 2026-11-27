# 安装与维护 Agent

Agent 安装在负责转发的 Linux 主机上。安装后可在面板「主机管理」查看在线状态和检测结果，也可通过 SSH 管理 Agent。

## 首次安装

在面板进入「主机管理 → 添加主机」，复制安装命令并在目标 Linux 主机以 root 执行。安装成功后主机会自动出现在列表中，每台主机使用独立 Token。

首次安装需要 Linux 主机、root 权限，以及主机能够访问面板和软件/下载源。Agent 不支持安装在 Windows 上。

安装后在主机列表确认状态为在线。若未上线，先检查面板地址和网络连通性，再查看 Agent 日志：

```bash
fwxm agent status
fwxm agent logs
```

## 恢复已有主机

换机或覆盖安装时，在「Agent 管理」找到原主机，使用终端按钮中的专属安装命令。它会沿用原 Token 和主机身份。需要新增一台机器时，请从「添加主机」获取通用安装命令，不要复用其他主机的 Token。

接管和换机不会自动迁移云服务商的 NAT、防火墙或网卡设置。更换机器后请确认这些网络配置仍然适用。

## 通过 SSH 管理

新版安装器提供 `fwxm` 管理命令。登录 Agent 主机后运行：

```bash
fwxm
```

同一台机器同时安装面板和 Agent 时，先选择 Agent；也可以直接运行 `fwxm agent`。没有安装 Agent 时，可以运行安装脚本打开菜单：

```bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | sudo bash
```

无参数运行会进入交互菜单，不会直接开始安装或升级。菜单提供 Agent 安装、状态与日志查看、启动/停止/重启、升级、修复和卸载。

菜单中的「配置面板地址和 Token」用于修改 Agent 本机连接的面板地址及 Token。Token 输入留空时沿用现有值，保存后会重启 Agent。若切换面板，请填写目标面板为该主机提供的 Token。

「代理设置」可以查看当前代理（凭据会隐藏）、设置 HTTP/SOCKS 代理或切回直连。更详细的代理使用方法见[代理配置](./agent-proxy-manager.md)。

「转发环境」可查看 Realm、GOST、iptables、nftables、socat、Nginx 和 Mimic 的检测结果及路径。缺少某个组件时，在该菜单选择安装，或执行：

```bash
fwxm agent tools install
```

随后从列表选择要补装的组件。也可以指定名称，例如 `fwxm agent tools install nginx`。这会单独安装所选工具，不需要重新安装 Agent。检测到工具文件只说明程序存在，不代表规则或转发链路已正常工作。

完整命令列表和菜单说明见 [SSH 管理](./ssh-management.md)。

## 修改单台主机的面板入口

需要让某台主机通过独立域名或端口连接面板时，在「主机管理 → 编辑主机 → 其他配置」开启「Agent 面板连接地址」，填写指向同一面板的 HTTP/HTTPS 地址。

该设置只影响所选主机的 Agent 通信，不会改变用户访问面板或业务转发的地址。反向代理需由管理员配置，并正确支持 Agent API 和持续连接。

如果设置错误导致 Agent 离线，先修正面板中的主机设置，再通过 SSH 修改 `/etc/forwardx/agent/config.json` 中的 `panelUrl`，最后重启 Agent：

```bash
sudo fwxm agent restart
```

## 升级与修复

可在主机管理页面升级，也可以登录 Agent 主机执行：

```bash
fwxm agent upgrade
```

升级会沿用本机保存的面板地址、Token 和代理配置。若只是缺少某个转发工具，请使用上面的「转发环境」安装入口补装。

Agent 无法正常运行时，可运行 `fwxm agent repair` 重新安装当前可用版本并保留配置。升级和修复可能重启 Agent 或转发运行时，已有连接可能短暂中断。

## 卸载

```bash
fwxm agent uninstall
```

卸载前会要求确认，并停止 Agent 管理的转发服务。卸载后如需重新接入，请从面板获取对应的安装命令。

## 常用路径

| 用途 | 路径 |
| --- | --- |
| 面板地址、Token 和代理配置 | `/etc/forwardx/agent/config.json` |
| Agent 日志 | `/var/log/forwardx-agent/agent-go.log` |
| 升级日志 | `/var/log/forwardx-agent/agent-upgrade.log` |
| 管理命令辅助文件 | `/etc/forwardx/manage/` |

配置文件包含 Agent Token 和代理凭据，请勿公开或发送给他人。优先使用 `fwxm agent info` 查看信息，输出会隐藏敏感字段。
