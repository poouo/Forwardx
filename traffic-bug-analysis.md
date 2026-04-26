# Agent 流量采集 Bug 分析

## 已确认的问题

### 问题1：realm 转发流量采集使用了错误的链

realm 是用户态代理，流量路径是：
- 入站：客户端 → INPUT 链 → realm 进程（监听 sourcePort）
- 出站：realm 进程 → OUTPUT 链 → 目标服务器

但 `apply_actions` 中 realm 规则走的是 `ensure_traffic_chain_forward`（FORWARD 链），
而 realm 的流量不经过 FORWARD 链，所以 realm 模式的流量永远为 0。

代码位置（agentRoutes.ts 第1155-1162行）：
```
if [ "$FT" = "socat" ]; then
  ensure_traffic_chain_socat "$SP" "$PR"
else
  # iptables/realm 走 FORWARD 链 ← 这里 realm 不应该走 FORWARD
  ensure_traffic_chain_forward "$SP" "$PR" "$TIP" "$TPT"
fi
```

**修复**：realm 也应该使用 `ensure_traffic_chain_socat`（INPUT/OUTPUT 链），因为 realm 和 socat 一样是用户态代理。

### 问题2：iptables 模式 FORWARD 链计数规则匹配的是目标地址

对于 iptables 转发（DNAT），数据包路径：
- PREROUTING(DNAT: dst 改为 targetIp:targetPort) → FORWARD → POSTROUTING(MASQUERADE)

`ensure_traffic_chain_forward` 中：
```
iptables -I FORWARD -p tcp -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN"
```
这匹配的是 DNAT 后的目标地址，逻辑上是正确的。

但问题是：FORWARD 链上的计数规则需要在 DNAT 规则生效后才能匹配。
如果 DNAT 规则没有正确设置，或者 conntrack 有问题，计数链不会命中。

### 问题3：runningRules 重建计数链时只用了 forward 模式

第1271-1276行：
```
if [ -n "$TIP" ] && [ -n "$TPT" ]; then
  if ! iptables -L "FWX_IN_${SP}" -n 2>/dev/null | grep -q "Chain"; then
    ensure_traffic_chain_forward "$SP" "$PR" "$TIP" "$TPT"
  fi
fi
```
这里不区分 forwardType，全部用 forward 模式重建，socat/realm 规则会被错误处理。

### 问题4：runningRules 响应中缺少 forwardType 字段

心跳响应的 runningRules 数组中没有包含 forwardType，导致 agent 无法区分转发类型来选择正确的计数链。

## 修复方案

1. realm 改用 socat 相同的 INPUT/OUTPUT 计数方式
2. runningRules 中添加 forwardType 字段
3. 重建计数链时根据 forwardType 选择正确的函数
