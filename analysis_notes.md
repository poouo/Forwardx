# Agent 流量监控上报异常 - 完整分析

## 核心问题总结

### Bug 1: realm 转发使用了错误的流量计数链（FORWARD 而非 INPUT/OUTPUT）

**位置**: agentRoutes.ts `apply_actions()` 函数中，约第1164-1173行

**问题**: 代码逻辑是：
```bash
if [ "$FT" = "iptables" ]; then
  ensure_traffic_chain_forward "$SP" "$PR" "$TIP" "$TPT"
else
  # socat/realm 都是用户态代理，流量走 INPUT/OUTPUT
  ensure_traffic_chain_socat "$SP" "$PR"
fi
```

但实际生成的 agent.sh 脚本中，这段代码的条件判断是反的：
```bash
if [ "$FT" = "socat" ]; then
  ensure_traffic_chain_socat "$SP" "$PR"
else
  # iptables/realm 走 FORWARD 链 ← realm 不应该走 FORWARD
  ensure_traffic_chain_forward "$SP" "$PR" "$TIP" "$TPT"
fi
```

realm 是用户态代理（和 socat 一样），流量路径是 INPUT/OUTPUT，不经过 FORWARD 链。
所以 realm 模式下流量计数链挂在 FORWARD 上永远匹配不到数据包，流量始终为 0。

### Bug 2: runningRules 重建计数链时不区分 forwardType

**位置**: agentRoutes.ts `report_status()` 函数中，约第1280-1291行

**问题**: agent 重启后通过 runningRules 重建计数链时：
```bash
if ! iptables -L "FWX_IN_${SP}" -n 2>/dev/null | grep -q "Chain"; then
  if [ "$FT_RR" = "iptables" ]; then
    ensure_traffic_chain_forward "$SP" "$PR" "$TIP" "$TPT"
  else
    ensure_traffic_chain_socat "$SP" "$PR"
  fi
fi
```

这段代码的逻辑是正确的（区分了 iptables 和其他类型），但问题在于：
- 心跳响应的 `runningRules` 数组中已经包含了 `forwardType` 字段
- 但 agent 脚本中读取 `forwardType` 的变量名是 `FT_RR`
- 需要确认 `FT_RR` 是否正确读取到了值

### Bug 3: trafficSummary 前端 Map 以 ruleId 为 key，多 host 场景下数据覆盖

**位置**: Rules.tsx 第156-166行

**问题**: `trafficByRule` 使用 `Map<ruleId, ...>` 存储，但后端 `getTrafficSummaryByRule` 按 `(ruleId, hostId)` 分组返回。
如果同一个 ruleId 对应多个 host 的数据行，后面的会覆盖前面的，导致流量数据不完整。

**修复**: 前端应该按 ruleId 聚合（累加）多个 host 的流量数据，而不是直接 set 覆盖。

### Bug 4: agent 脚本中 ensure_traffic_chain_forward 的 iptables -L 检测逻辑

**位置**: agentRoutes.ts 第1282行

```bash
if ! iptables -L "FWX_IN_${SP}" -n 2>/dev/null | grep -q "Chain"; then
```

`iptables -L "FWX_IN_xxx"` 输出的第一行是 `Chain FWX_IN_xxx ...`，grep "Chain" 能匹配到。
但如果链不存在，iptables 返回错误，stderr 被重定向，stdout 为空，grep 不匹配，条件为 true，会执行重建。
这个逻辑本身是正确的。

## 需要修复的文件

1. **agentRoutes.ts**: 修复 apply_actions 中 realm 的计数链选择逻辑
2. **Rules.tsx**: 修复 trafficByRule Map 的聚合逻辑（累加而非覆盖）
3. **DashboardLayout.tsx**: 新增版本号显示
