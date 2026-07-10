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
| ForwardX 自定义加密隧道 | 由 ForwardX Agent 建立入口到出口的加密链路，适合面板统一管理 |
| Nginx Stream 隧道 | 使用 Nginx Stream 做四层链路中转，支持 TCP、UDP 和 TCP+UDP，适合配合出口组做负载均衡 |
| Nginx TLS 隧道 | 使用 Nginx TLS Stream 做 TCP 链路中转，适合需要 TLS 包裹的 TCP 场景 |

如果不确定选哪个，优先使用当前业务已经验证稳定的方式。

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

mimic 仅工作在物理网卡的 XDP/TC 层，ForwardX 隧道本身仍由 FXP 原生 UDP 承载。拨号侧按下一跳 FXP 地址生成 `remote=` filter，监听侧按本机网卡真实地址和 FXP 监听端口生成 `local=` filter；多跳和额外出口会分别配置。此流程不使用 WireGuard。


## Nginx 隧道注意事项

- Nginx Stream 隧道适合 TCP/UDP 四层中转和出口组负载均衡。
- Nginx TLS 隧道只适合 TCP；UDP 场景请使用 Nginx Stream 或 ForwardX 自定义加密隧道。
- Nginx 隧道不会默认监听 80 端口；运行时监听端口来自隧道的出口监听端口，转发规则入口仍使用规则入口端口。
- 如填写自定义证书 PEM 和私钥 PEM，证书会下发到出口机的 ForwardX Nginx 运行目录，TCP 的入口到出口段会使用 TLS；UDP 仍保持 Stream 四层转发。
- Nginx 隧道依赖 Agent 主机可用的 Nginx Stream 运行环境；不可用时应先升级或重新安装 Agent 运行组件。
- 如果需要 ForwardX 自定义加密、mimic UDP 混淆或更完整的规则级能力，优先使用 ForwardX 自定义加密隧道。
