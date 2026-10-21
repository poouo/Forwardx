# ForwardX BBR 管理

管理员按主机读取、修改和还原 Linux TCP / BBR 参数。安装和启用插件仅同步管理程序，不会自动修改内核参数。

## 使用

1. 在官方插件商店安装并启用「ForwardX BBR 管理」，按提示授权 Agent 读写。
2. 进入插件使用页，选择在线主机，等资源同步完成后读取参数。
3. 点击编辑，使用图形化表单或切换「高级文本」粘贴 sysctl 配置；两种模式共用一份文本，保留自定义参数与注释。
4. 点击保存并确认后下发。也可直接点击「应用 BBR + FQ」，替换为下述两项配置。
5. 出现问题时点击「还原原参数」，恢复插件首次修改各参数前的值。

```conf
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
```

图形化字段的「不修改」表示不纳入本次配置；之前已由插件托管但本次被移除的参数会恢复原值。高级文本可添加内核支持的 `net.ipv4.tcp_*` 及受支持的 `net.core` 参数。列表显示运行值，编辑器按运行值填充已保存配置中的参数；编辑框下方可对照完整运行参数与已保存原文。

## 前置条件与限制

- Linux，Agent 以 root 运行，安装 Python 3.8+ 与 `sysctl`（procps / procps-ng）。可选 `tc` 用于查看现有网卡队列。
- 内核必须支持所选参数和算法；会尝试加载系统已有 `tcp_bbr` / `sch_fq` 等模块，但不安装内核、不重启、不下载第三方脚本。不支持或权限不足时返回错误，不伪报成功。
- BBR 影响主机发出的 **TCP** 连接，新连接采用新默认算法；不会直接优化 UDP、用户态 WireGuard 或修复转发程序自身瓶颈，也不保证任何线路吞吐提升。
- `net.core.default_qdisc=fq` 仅改变默认队列。已存在的网卡队列可能仍为其他类型；插件单独展示现有队列，**不会运行 `tc qdisc replace` 打断网络**。
- 预设不包含激进缓冲区或万能调优值，额外参数需根据主机内存和线路调整。
- 每行采用 `参数 = 值`，允许空行及 `#` / `;` 注释；禁止重复键、命令、include 和通配符，最多 12000 UTF-8 字节。配置只作为数据解析，不作为 Shell / Python 执行。
- 受支持的 `net.core` 参数：`default_qdisc`、`somaxconn`、`rmem_max`、`wmem_max`、`rmem_default`、`wmem_default`、`optmem_max`、`netdev_max_backlog`、`netdev_budget`、`netdev_budget_usecs`。

## 保存与恢复

- 持久化文件：`/etc/sysctl.d/90-forwardx-bbr.conf`。
- 首次原值及原插件文件备份：`/var/lib/forwardx-agent/plugin-state/bbr-manager/original.json`，不随插件资源升级覆盖。
- 写入前校验所有目标键，应用后逐项核验；失败尝试回滚本次运行值和文件，若回滚失败保留备份并明确报错，便于重试还原。
- 不执行 `sysctl --system`，不覆盖 `/etc/sysctl.conf` 或其他 sysctl.d 文件。其他配置文件、调优服务仍可能在启动时覆盖插件值；发现列表提示运行值与保存值有差异时，应检查冲突来源。
- 停用或卸载插件不会擅自恢复主机参数；如需恢复，请在停用前执行「还原原参数」。强制终止任务或主机关机中断写入时，可在恢复连接后通过该入口恢复。

## 许可

ForwardX 原创管理程序和 Logo，遵循项目的 AGPL-3.0-only 许可证；无第三方调优脚本。
