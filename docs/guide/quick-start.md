# 快速开始

按下面的顺序部署面板、接入第一台主机并跑通一条规则。正式使用前请配好 HTTPS 和备份。

## 1. 部署面板

用 root 执行 Docker 一键安装，非 root 把管道后的 bash 换成 sudo bash：

~~~bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install --language zh-CN
~~~

安装时按提示选择端口和数据库，完成后访问 http://服务器IP:9810。不用 Docker 见 [本地部署](./deploy-local.md)。

安装后可以在宿主机上输入 `fwxm` 查看状态、日志或重启面板，见 [管理菜单](./ssh-management.md)。提示命令不存在说明是旧版或手工部署，直接用 Docker 或系统服务的方式检查即可，不需要重装。

## 2. 初始化数据库与管理员

打开网页，确认数据库配置（安装脚本可能已经填好），测试连接后完成初始化，再创建管理员。沿用已有数据库时直接用原来的管理员登录。

SQLite 不需要另装数据库。面板在 Docker 里时，MySQL / PostgreSQL 的地址要从容器内能访问，`127.0.0.1` 指向的是容器自己。详见 [数据库配置](./database.md)。

## 3. 配置公开地址

在「系统设置 → 系统配置」填写 Agent 能访问到的面板地址，例如 https://panel.example.com。域名和反向代理见 [HTTPS 配置](./reverse-proxy.md)。

## 4. 接入主机

进入「主机管理 → Token 管理」，为每台主机单独创建 Token，复制安装命令，在被管理的主机上用 root 执行。

~~~bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
~~~

命令以面板生成的为准。执行后回到面板确认主机在线、环境检测正常。每台主机用自己的 Token，不影响它们加入同一个组。详见 [Agent 安装](./agent.md)。

主机需要通过 SOCKS / HTTP 代理访问面板时，下载脚本和执行安装两步都要指定代理，只在管道后加参数不够。完整示例见 [Agent 代理](./agent-proxy-manager.md)。

## 5. 创建链路资源

进入「链路管理 → 端口转发」，选择刚接入的主机和转发工具并保存。也可以创建 [隧道](./tunnels.md) 或 [转发链](./port-chains.md)，第一次建议先用单机转发跑通。

NAT 主机要先在主机配置里填写可用端口范围，规则入口端口和隧道监听端口都必须在服务商实际映射的范围内。

## 6. 创建第一条规则

进入「转发规则 → 添加规则」，选择上一步保存的端口转发资源。

| 配置项 | 示例 |
| --- | --- |
| 规则名称 | 第一条规则 |
| 资源 | 上一步创建的端口转发 |
| 协议 | TCP（按真实服务选择） |
| 入口端口 | 15201（确保可用且已放行） |
| 目标地址 | 你实际服务的 IP 或域名 |
| 目标端口 | 服务真实监听端口 |
| 所属用户 | 默认自己的账户 |

目标服务要能从这台主机访问到，入口端口要在安全组和系统防火墙里放行。

## 7. 验证

等规则显示运行后执行自测，再用真实客户端连接「入口IP:入口端口」。自测的 TCP 连通只说明端口可达，UDP 和具体应用协议要用实际业务确认。

不通时记下时间、规则 ID 和相关日志，按 [故障排查](./troubleshooting.md) 逐跳检查，日志位置见 [目录与日志](./paths-logs.md)。

接下来可以配置 [通知](./notifications.md)、[Google 登录](./google-login.md) 和 [备份](./upgrade-backup.md)。
