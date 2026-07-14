# 隧道链路

隧道适合入口机器和目标出口机器不同的场景。

常见路径：

```text
用户 -> 入口机 -> 隧道 -> 出口机 -> 目标服务
```

进入：

```text
链路管理 -> 隧道链路
```

可以创建：

- GOST 隧道。
- ForwardX 自定义加密隧道。
- Nginx Stream 隧道。
- Nginx TLS 隧道。

## 什么时候需要隧道

适合这些情况：

- 入口服务器和落地服务器不是同一台。
- 目标服务只能由出口机器访问。
- 希望入口到出口之间加密。
- 需要多级链路。
- 需要出口组或负载均衡。

## 配置建议

- 入口机选择用户访问质量较好的机器。
- 出口机选择目标服务所在地区或能访问目标的机器。
- 如果机器支持 IPv6，并希望隧道走 IPv6，可以开启 IPv6 转发选项。
- 需要多个入口时，可以先创建入口组，再在隧道中选择入口组。
- 创建后使用链路测试查看每段延迟。

## 隧道类型

| 类型 | 说明 |
| --- | --- |
| GOST 隧道 | 使用 GOST 提供的隧道能力，适合需要兼容 GOST 协议的场景 |
| ForwardX 自定义加密隧道 | 可选 V1 原版或 V2 WireGuard，由 ForwardX Agent 建立并统一管理入口到出口的加密链路 |
| Nginx Stream 隧道 | 使用 Nginx Stream 做四层链路中转，支持 TCP、UDP 和 TCP+UDP，适合配合出口组做负载均衡 |
| Nginx TLS 隧道 | 使用 Nginx TLS Stream 做 TCP 链路中转，适合需要 TLS 包裹的 TCP 场景 |

如果不确定选哪个，优先使用当前业务已经验证稳定的方式。

## ForwardX V1 与 V2

ForwardX 自定义隧道可在新增或编辑时选择传输版本：

| 版本 | 说明 |
| --- | --- |
| V1 原版 | 保留原有 FXP 加密传输，已有隧道升级后仍默认使用 V1，不会自动切换 |
| V2 WireGuard | 外层使用 Agent 内置的 userspace WireGuard，内层继续使用 FXP，流量特征和握手由真实 WireGuard 实现 |

V2 不依赖系统安装的 `wg` 命令，不会创建系统 WireGuard 网卡，也不会修改系统路由。每个隧道在每台 Agent 上只运行一套共享 WireGuard 环境，转发规则通过本机回环连接复用它。

V2 支持 V1 已有的单跳、多跳、入口组、多出口、TCP/UDP、限速、PROXY Protocol 和链路测试。使用时需要注意：

- 链路内所有 Agent 必须升级到 `2.2.154` 或更高版本。
- WireGuard 外层通过 UDP 传输，IDC、防火墙和安全组需要允许对应 UDP 端口。
- UDP 端口可以手动指定；留空时由面板为每个接收节点自动分配。
- V2 只改变入口到下一跳之间的隧道承载方式，不改变规则目标地址、目标端口和计费倍率等现有配置。

## 高级设置

隧道新增和编辑表单中的链路级参数会放在高级设置中，默认收起，减少误操作。

常见高级设置包括：

- PROXY Protocol。
- TCP Fast Open。
- zero-copy。
- 流量倍率。
- 出站策略。
- ForwardX 自定义隧道的传输优化或 mimic UDP 混淆。

不同隧道类型支持的高级设置不同，界面只会展示当前类型可用的配置项。
启用 mimic UDP 混淆前，需要在参与链路的 Agent 主机安装 mimic/mimic-dkms；Agent 安装脚本会作为可选项提示是否安装，默认 `n`，只有输入 `Y` 才会执行。

mimic 仅工作在物理网卡的 XDP/TC 层。V1 下它处理 FXP 的 UDP 承载流量；V2 下默认由内置 WireGuard 使用 UDP 承载，如同时启用 mimic，则处理对应的 WireGuard 外层 UDP 端口。拨号侧按下一跳地址生成 `remote=` filter，监听侧按本机网卡真实地址和承载端口生成 `local=` filter；多跳和额外出口会分别配置。


## Nginx 隧道注意事项

- Nginx Stream 隧道适合 TCP/UDP 四层中转和出口组负载均衡。
- Nginx TLS 隧道只适合 TCP；UDP 场景请使用 Nginx Stream 或 ForwardX 自定义加密隧道。
- Nginx 隧道不会默认监听 80 端口；运行时监听端口来自隧道的出口监听端口，转发规则入口仍使用规则入口端口。
- 如填写自定义证书 PEM 和私钥 PEM，证书会下发到出口机的 ForwardX Nginx 运行目录，TCP 的入口到出口段会使用 TLS；UDP 仍保持 Stream 四层转发。
- Nginx 隧道依赖 Agent 主机可用的 Nginx Stream 运行环境；不可用时应先升级或重新安装 Agent 运行组件。
- 如果需要 ForwardX 自定义加密、mimic UDP 混淆或更完整的规则级能力，优先使用 ForwardX 自定义加密隧道。
