# 流量采集为 0 + UDP 转发问题分析

## 问题 1：流量采集数据始终为 0

### 根因

流量计数链 `ensure_traffic_chain()` 在 **INPUT 链** 上挂钩：
```bash
iptables -I INPUT -p tcp --dport "$PORT" -j "$CHAIN"
```

但 iptables 转发的数据包走的是 **FORWARD 链**，不经过 INPUT 链。
PREROUTING(DNAT) → FORWARD → POSTROUTING(MASQUERADE)

INPUT 链只处理发往本机的数据包，转发流量根本不会命中 INPUT 上的计数规则，所以永远是 0。

### 修复方案

将计数链挂到 FORWARD 链上：
```bash
iptables -I FORWARD -p tcp --dport "$PORT" -d "$TARGET_IP" -j "$CHAIN"
```

对于 realm 转发（用户态代理），流量经过 INPUT/OUTPUT，但 realm 自身不走 iptables 计数。
需要改用 `/proc/net/dev` 差值或 realm 的连接统计来采集。

更好的方案：统一使用 iptables 的 FORWARD 链 + mangle 表来做流量统计，
或者改用 `iptables -t mangle` 在 PREROUTING 阶段计数（DNAT 前），这样能同时捕获入站流量。

最佳方案：
- iptables 转发：在 FORWARD 链上挂计数规则（按 dport 匹配 DNAT 后的目标）
- realm 转发：realm 本身是用户态代理，需要在 INPUT（入站到 realm）和 OUTPUT（realm 出站到目标）上分别计数

## 问题 2：UDP 转发

### iptables 模式

当 protocol="both" 时，代码逻辑：
```js
const proto = rule.protocol === "both" ? "tcp" : rule.protocol;
```
先添加 tcp 规则，然后 if (protocol === "both") 再单独添加 udp 规则。
当 protocol="udp" 时，proto="udp"，只添加 udp 规则。

iptables UDP 转发本身不需要监听特定网卡，PREROUTING 是全局的。
但 FORWARD 链的放行规则对 UDP 没有加 `--state ESTABLISHED,RELATED`（UDP 无状态），
当前代码第 127 行只有：
```
FORWARD -p udp -s ${rule.targetIp} --sport ${rule.targetPort} -j ACCEPT
```
这是正确的，UDP 回包不依赖 conntrack state。

### realm 模式

realm 命令：`/usr/local/bin/realm -l 0.0.0.0:PORT -r TARGET_IP:TARGET_PORT --udp`
监听 0.0.0.0 即所有网卡，这是正确的。
但 realm 的 `--udp` 参数在新版本中已改为 `-u` 或需要配置文件方式。
需要确认 realm v2.6.0 的正确 UDP 参数。

### 网卡选择

当前 tc 限速硬编码 `eth0`，如果服务器主网卡不是 eth0（如 ens3、ens33、enp0s3 等），限速不生效。
realm 监听 0.0.0.0 不受网卡影响。
iptables PREROUTING/FORWARD 也不受网卡影响（除非指定 -i 参数）。

需要网卡选择的场景：
1. tc 限速需要指定正确的网卡
2. 用户可能想限制只在某个网卡上监听（安全需求）
3. realm 可以绑定特定 IP 而非 0.0.0.0

## 修复计划

1. 流量采集：改用 FORWARD 链计数（iptables 模式）+ /proc/net/dev 或 iptables INPUT 计数（realm 模式）
2. UDP 转发：确认 realm --udp 参数正确性，iptables 模式 UDP 逻辑看起来正确
3. 网卡选择：
   - 数据库 hosts 表添加 `networkInterface` 字段
   - 前端主机管理添加网卡选择输入框
   - tc 限速和 iptables -i 参数使用用户选择的网卡
   - realm 绑定到指定网卡的 IP
