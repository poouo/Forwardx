# ForwardX Agent 流量监控上报异常 - 排查与修复报告

## 一、问题排查过程

### 项目结构说明

项目中存在两份代码树：

| 代码树 | 品牌 | 状态 |
|--------|------|------|
| 根目录 `/project/agentRoutes.ts` 等 | PortFlow（旧版） | 包含原始 Bug |
| `/project/forwardx_src/forwardx/` | ForwardX（新版） | 实际构建目标，大部分 Bug 已修复 |

### 本地模拟验证

通过在 sandbox 中使用 iptables 创建计数链并验证挂载位置，确认了以下事实：

1. **realm 模式的计数链错误挂在 FORWARD 链上**：通过 `iptables -L FORWARD` 和 `iptables -L INPUT` 对比验证，确认 realm 的 `FWX_IN_*` 链出现在 FORWARD 而非 INPUT 上。
2. **修复后 realm 计数链正确挂在 INPUT/OUTPUT 上**：将条件从 `if [ "$FT" = "socat" ]` 改为 `if [ "$FT" = "iptables" ]` 后，realm 的计数链正确出现在 INPUT 和 OUTPUT 链上。
3. **前端 trafficByRule 覆盖问题**：通过 Node.js 模拟验证，当同一 ruleId 对应多个 host 时，修复前 `bytesIn=2000`（被覆盖），修复后 `bytesIn=3000`（正确累加）。

## 二、发现的 Bug 及修复

### Bug 1：realm 转发的流量计数链挂错位置（核心 Bug）

**根因**：realm 是用户态代理（和 socat 一样），流量路径为 `客户端 → INPUT → realm 进程 → OUTPUT → 目标服务器`。但旧版代码中，`apply_actions()` 的条件判断只检查了 `socat`，导致 realm 走了 `else` 分支，计数链被挂在了 **FORWARD 链**上。realm 的流量根本不经过 FORWARD 链，所以计数永远为 0。

**影响**：realm 模式下所有转发规则的流量数据始终显示为 0。

**修复**：

| 文件 | 修改前 | 修改后 |
|------|--------|--------|
| `agentRoutes.ts` apply_actions | `if [ "$FT" = "socat" ]` 走 INPUT/OUTPUT，else 走 FORWARD | `if [ "$FT" = "iptables" ]` 走 FORWARD，else（socat/realm）走 INPUT/OUTPUT |

```bash
# 修复前（旧版 - 有 Bug）
if [ "$FT" = "socat" ]; then
  ensure_traffic_chain_socat "$SP" "$PR"
else
  # realm 错误地走了这里
  ensure_traffic_chain_forward "$SP" "$PR" "$TIP" "$TPT"
fi

# 修复后
if [ "$FT" = "iptables" ]; then
  # 仅 iptables 走 FORWARD 链
  ensure_traffic_chain_forward "$SP" "$PR" "$TIP" "$TPT"
else
  # socat/realm 都是用户态代理，走 INPUT/OUTPUT 链
  ensure_traffic_chain_socat "$SP" "$PR"
fi
```

### Bug 2：runningRules 响应缺少 forwardType 字段（旧版）

**根因**：心跳响应的 `runningRules` 数组中没有包含 `forwardType` 字段，导致 agent 重启后重建计数链时无法区分转发类型。

**修复**：在 `runningRules.push()` 中添加 `forwardType: rule.forwardType`。

### Bug 3：runningRules 重建计数链不区分 forwardType（旧版）

**根因**：agent 重启后通过 runningRules 重建计数链时，全部使用 `ensure_traffic_chain_forward`，不区分转发类型。

**修复**：读取 `forwardType` 字段，根据值选择正确的计数链函数。

### Bug 4：前端 trafficByRule Map 覆盖问题

**根因**：后端 `getTrafficSummaryByRule` 按 `(ruleId, hostId)` 分组返回数据。前端使用 `Map.set()` 直接覆盖，当同一 `ruleId` 对应多个 host 的数据行时，后面的行会覆盖前面的，导致流量数据不完整。

**影响**：多主机场景下，规则列表中显示的"近 24h 流量"数据不完整。

**修复**：将 `Map.set()` 改为累加聚合逻辑。

```typescript
// 修复前（覆盖）
m.set(Number(t.ruleId), { bytesIn, bytesOut, connections });

// 修复后（累加）
const rid = Number(t.ruleId);
const prev = m.get(rid);
if (prev) {
  prev.bytesIn += Number(t.bytesIn) || 0;
  prev.bytesOut += Number(t.bytesOut) || 0;
  prev.connections += Number(t.connections) || 0;
} else {
  m.set(rid, { bytesIn, bytesOut, connections });
}
```

### Bug 5：realm 删除时只清理 FORWARD 链（旧版）

**根因**：realm 规则删除时，只清理 FORWARD 链上的计数规则，没有清理 INPUT/OUTPUT 链上的规则。

**修复**：先清理 INPUT/OUTPUT 链上的规则，再兼容清理旧版 FORWARD 链上的规则。

### 修正：注释错误

**问题**：agent 脚本中的注释 `# iptables/realm 转发：数据包走 FORWARD 链` 具有误导性，realm 不走 FORWARD 链。

**修复**：改为 `# iptables 转发：数据包走 FORWARD 链` 和 `# socat/realm 转发：数据包走 INPUT 链`。

## 三、新增功能：版本号显示

在 `DashboardLayout.tsx` 的侧边栏底部（用户信息上方）添加了版本号 `v1.0.0` 的显示：

- 展开状态下显示 `v1.0.0`，使用 10px 淡色文字，不影响整体布局
- 折叠状态下自动隐藏（通过 `group-data-[collapsible=icon]:hidden`）
- 版本号后续修改时用户手动告知即可

## 四、修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `forwardx_src/forwardx/server/agentRoutes.ts` | 修正流量采集注释（realm 不走 FORWARD） |
| `forwardx_src/forwardx/client/src/pages/Rules.tsx` | 修复 trafficByRule 聚合逻辑（累加替代覆盖） |
| `forwardx_src/forwardx/client/src/components/DashboardLayout.tsx` | 新增版本号 v1.0.0 显示 |
| `agentRoutes.ts`（根目录旧版） | 修复 realm 计数链选择、runningRules forwardType、重建逻辑、删除清理、注释 |

## 五、部署建议

1. **已部署的 agent 需要重新安装**：修复后的 agent 脚本需要重新下发到所有主机，旧版 agent 仍会使用错误的计数链。
2. **已有的 realm 规则需要重新应用**：先禁用再启用规则，让新 agent 重新创建正确的计数链。
3. **旧版计数链会自动兼容清理**：删除规则时会同时清理 FORWARD 和 INPUT/OUTPUT 链上的旧规则。
