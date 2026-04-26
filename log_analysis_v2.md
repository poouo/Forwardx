# 日志分析 v2 - mangle 方案仍然为0

## 关键信息

规则: ruleId=6, sourcePort=5201, targetIp=45.129.9.159, targetPort=5201, forwardType=iptables, protocol=tcp

mangle 计数链 FWX_IN_5201 已存在（跳过重建），但采样始终为 pkts=0 bytes=0。

## 关键观察

心跳中 networkIn/networkOut 在持续变化（每30秒约50MB增量），说明机器确实有大量流量：
- 12:15:25: networkIn=2240523148, networkOut=2493427193
- 12:15:57: networkIn=2337677962, networkOut=2590738730 (差值约97MB/97MB)
- 12:16:30: networkIn=2385578557, networkOut=2638787658 (差值约48MB/48MB)
- 12:17:02: networkIn=2434092538, networkOut=2687444625 (差值约49MB/49MB)

但 mangle PREROUTING 上的 FWX_IN_5201 计数链 pkts=0 bytes=0。

## 可能原因

1. **nftables 后端问题**：现代 Linux（Debian 11+, Ubuntu 22+）默认使用 nftables 后端。
   `iptables` 命令可能是 `iptables-nft` 的别名，在 nftables 后端下，mangle 表的行为可能不同。
   特别是：iptables-nft 创建的 mangle 链可能不会被内核真正挂载到 netfilter 钩子上。

2. **iptables-nft 的计数器问题**：iptables-nft 后端的计数器可能需要特殊处理。

3. **这台机器可能用的是 nftables 原生规则做转发**，而不是 iptables-legacy。

## 解决方案

放弃 iptables 计数链方案，改用 **conntrack** 或 **ss/proc** 方案：

### 方案A: conntrack 统计（推荐）
- `conntrack -L -p tcp --dport 5201` 可以列出所有经过 5201 端口的连接
- conntrack 有 bytes 计数器：`conntrack -L -p tcp --dport 5201 -o extended` 
- 不依赖 iptables 表/链，直接读取内核连接跟踪表

### 方案B: /proc/net/nf_conntrack
- 直接读取 /proc/net/nf_conntrack 文件
- 解析每行的 bytes= 字段

### 方案C: ss -i 统计
- `ss -tnpi sport = :5201` 可以列出所有使用 5201 端口的连接及其字节数
- 但只能统计 TCP，且只能统计当前活跃连接
