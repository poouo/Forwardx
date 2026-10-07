# 快速开始

按顺序部署面板、接入第一台主机并创建一条规则。正式环境请先准备 HTTPS 和备份方案。

## 1. 部署面板

使用 root 执行 Docker 一键安装；非 root 将管道后的 bash 替换为 sudo bash：

~~~bash
curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh | bash -s -- install --language zh-CN
~~~

安装时按提示选择端口和数据库。默认访问 http://服务器IP:9810；不使用 Docker 时参考 [本地部署](./deploy-local.md)。

## 2. 初始化数据库与管理员

打开网页，核对安装脚本可能已预填的数据库配置，测试连接并完成初始化，再创建第一个管理员。使用已有数据库时直接使用原管理员登录。

SQLite 无需另装数据库；Docker 中的 MySQL/PostgreSQL 地址必须从容器内可达，不能将 127.0.0.1 当作宿主机。详见 [数据库配置](./database.md)。

## 3. 配置公开地址

在「系统设置 → 系统配置」填写 Agent 实际能访问的面板地址，例如 https://panel.example.com。域名和反代见 [HTTPS 配置](./reverse-proxy.md)。

## 4. 接入主机

进入「主机管理 → Token 管理」，为每台主机分别创建 Token，复制对应的安装命令，在被管理 Linux 主机上以 root 执行。

~~~bash
curl -fsSL https://panel.example.com/api/agent/install.sh | bash -s -- install YOUR_AGENT_TOKEN
~~~

使用面板实际生成的地址与 Token。确认主机在线及环境检测正常；独立 Token 不影响多个主机加入同一个组。详见 [Agent 安装](./agent.md)。

## 5. 先创建链路资源

进入「链路管理 → 端口转发」，选择刚接入的主机及其支持的转发工具并保存。也可以创建 [隧道](./tunnels.md) 或 [转发链](./port-chains.md)，但第一次建议先验证单机转发。

NAT 主机先在主机配置中限制可用端口范围；业务入口和隧道监听端口必须同时位于供应商实际映射的范围内。

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

目标服务必须能从该主机访问。放行安全组和系统防火墙中的入口端口；不要使用不属于你的示例 IP 作为有效测试目标。

## 7. 验证后交付

等待规则运行确认，执行自测，并用真实客户端访问「入口IP:入口端口」。TCP 可连接只证明对应探测成功，不等于 UDP 或应用协议必然正常。

失败时保留时间、资源 ID 与相关日志，按 [故障排查](./troubleshooting.md) 逐跳检查，日志位置见 [目录与日志](./paths-logs.md)。

后续可配置 [通知](./notifications.md)、[Google 登录](./google-login.md) 和 [备份](./upgrade-backup.md)。
