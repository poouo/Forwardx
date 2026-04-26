# ForwardX 修改说明

## 一、项目重命名：PortFlow → ForwardX

对项目进行了全局品牌重命名，涉及以下所有层面：

| 修改范围 | 旧值 | 新值 |
|---------|------|------|
| 项目名称 (package.json) | `portflow` | `forwardx` |
| 页面标题 (index.html) | `PortFlow - 端口转发管理面板` | `ForwardX - 端口转发管理面板` |
| 登录页 / 侧边栏品牌名 | `PortFlow` | `ForwardX` |
| Docker 镜像/容器/卷名 | `portflow` / `portflow-panel` / `portflow-data` | `forwardx` / `forwardx-panel` / `forwardx-data` |
| 数据库文件名 | `portflow.db` | `forwardx.db` |
| Agent 服务名 / 安装目录 / 状态目录 | `portflow-agent` | `forwardx-agent` |
| realm/socat 服务名 | `portflow-realm-*` / `portflow-socat-*` | `forwardx-realm-*` / `forwardx-socat-*` |
| iptables 计数链前缀 | `PORTFLOW_IN_` / `PORTFLOW_OUT_` | `FWX_IN_` / `FWX_OUT_` |
| 主题存储 key / 配置导出文件名 | `portflow-*` | `forwardx-*` |

## 二、修复 Agent 流量采集 Bug

### 根因分析

流量始终为 0 的核心原因是 **realm 转发的计数链挂错了位置**：

- **realm** 是用户态代理（和 socat 一样），流量路径为 `INPUT → realm 进程 → OUTPUT`
- 但代码将 realm 归类到了 iptables 模式，把计数链挂在了 **FORWARD 链**上
- realm 的流量根本不经过 FORWARD 链，所以计数永远为 0

### 修复内容

| 修改点 | 修改前 | 修改后 |
|-------|--------|--------|
| apply_actions 中建立计数链 | socat 用 INPUT/OUTPUT，其余（含 realm）用 FORWARD | 仅 iptables 用 FORWARD，socat 和 realm 都用 INPUT/OUTPUT |
| runningRules 响应 | 不含 `forwardType` 字段 | 新增 `forwardType` 字段 |
| agent 重启重建计数链 | 全部用 `ensure_traffic_chain_forward` | 根据 `forwardType` 选择 forward 或 socat 模式 |
| realm 删除规则清理 | 只清理 FORWARD 链上的计数规则 | 先清理 INPUT/OUTPUT 链，再兼容清理旧版 FORWARD 链 |

## 三、连通性检测修改

### 去除本机贯穿检测

- **后端判定逻辑**：从 `targetReachable && forwardOk` 改为仅 `targetReachable`
- **Agent 脚本**：自测流程中不再执行 `check_loopback_forward`（127.0.0.1 贯穿检测）
- **前端展示**：SelfTestDialog 中移除了"本机 127.0.0.1 贯穿"检测项

### 增加目标 IP 延迟检测

Agent 自测时新增 **ping 延迟检测**：

```bash
# ping 目标 IP 3次取平均延迟
PING_RESULT=$(ping -c 3 -W 2 "$TIP" 2>/dev/null | tail -1)
# 解析 avg 字段得到延迟毫秒数
LAT=$(echo "$PING_RESULT" | awk -F "/" "NR==1{printf \"%d\", $5}")
```

前端展示延迟值并根据数值着色：

| 延迟范围 | 颜色 |
|---------|------|
| < 50ms | 绿色（优秀） |
| 50-100ms | 蓝色（良好） |
| 100-200ms | 橙色（一般） |
| > 200ms | 红色（较差） |

### 最终自测流程

自测弹窗现在展示以下检测项：

1. **本地监听检测**（仅供参考）— 检查端口是否在监听，不影响判定结果
2. **目标可达** — 检测目标 IP:Port 是否可达，**唯一的连通性判定依据**
3. **目标延迟** — ping 目标 IP 的平均延迟（ms），带颜色标识

## 四、前端流量展示

流量展示功能已全面恢复（之前临时标记为"暂不可用"已撤回）：

- **仪表盘**（Home.tsx）：入站/出站流量 StatCard 恢复正常数据展示
- **规则页面**（Rules.tsx）：
  - 顶部三张流量汇总卡片恢复正常
  - 表格中每条规则的"近 24h 流量"列恢复正常
  - 流量趋势按钮恢复可用
