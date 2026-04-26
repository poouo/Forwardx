# 流量统计方案分析

## 当前问题根因

从日志看，iptables 计数链创建成功且挂载位置正确（FORWARD 链），但流量始终为 0。
可能原因：
1. iptables 转发目标是自身 IP（DNAT 到自己不走 FORWARD）
2. nftables 后端兼容问题（部分系统 iptables 是 nft 后端，计数器行为不同）
3. 确实无外部流量

## 方案对比

### 方案1: TC (Traffic Control)
- **原理**: 在网卡上创建 tc filter，用 u32 匹配端口，统计字节/包数
- **优点**: 工作在网卡层面，不依赖 iptables 链路径，无论 FORWARD/INPUT/OUTPUT 都能统计
- **缺点**: 
  - TC 只能统计单方向（ingress 或 egress），需要在网卡上分别配置
  - TC 的 u32 匹配比较复杂，且不同内核版本行为有差异
  - TC 统计需要 ingress qdisc，可能与已有 tc 限速规则冲突
  - 对于 iptables 转发（DNAT），入站包的 dport 在 PREROUTING 后已变为目标端口

### 方案2: ss/conntrack 连接级统计
- **原理**: 通过 conntrack 或 ss 统计每个连接的字节数
- **优点**: 精确到连接级别
- **缺点**: 需要 conntrack 模块，UDP 无状态连接难以统计

### 方案3: iptables 统一用 INPUT/OUTPUT 链（推荐）
- **原理**: 
  - 对于 iptables 转发：在 PREROUTING 之前（即 raw 表或 mangle 表的 PREROUTING）匹配原始 sourcePort
  - 或者：所有类型统一用 conntrack 的 connbytes 模块
  - 最简单：对 iptables 转发也在 INPUT 链上用 --dport sourcePort 匹配（因为 DNAT 前的包也经过 INPUT 的 conntrack）
  
  实际上不对 —— iptables 转发的包不经过 INPUT，只经过 FORWARD。

### 方案4: iptables mangle PREROUTING（推荐）
- **原理**: 在 mangle 表的 PREROUTING 链上匹配 --dport sourcePort（DNAT 之前），此时包的目标端口还是原始的 sourcePort
- **优点**: 
  - 在 DNAT 之前匹配，所以用 sourcePort 就能匹配到
  - 所有类型（iptables/socat/realm）都经过 PREROUTING
  - 出站用 mangle OUTPUT 或 POSTROUTING 匹配 --sport sourcePort
- **缺点**: mangle 表操作需要更多权限

### 方案5: 混合方案 - iptables 保持 FORWARD + 补充 conntrack（推荐度中等）

## 最终推荐：方案4 - iptables mangle PREROUTING/POSTROUTING

统一所有转发类型的流量统计：
- 入站：mangle PREROUTING -p tcp/udp --dport $SOURCE_PORT -j FWX_IN_$PORT
- 出站：mangle POSTROUTING -p tcp/udp --sport $SOURCE_PORT -j FWX_OUT_$PORT

这样无论是 iptables 转发、socat 还是 realm，都能在同一个位置统计到流量。
