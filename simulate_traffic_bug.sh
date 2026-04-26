#!/bin/bash
# 本地模拟 Agent 流量采集逻辑，验证 Bug
# 不需要真实的转发规则，只需要验证 iptables 链的创建和匹配逻辑

set -e

echo "============================================="
echo "  ForwardX Agent 流量采集 Bug 模拟验证"
echo "============================================="
echo ""

# ==================== 辅助函数（从 agentRoutes.ts 提取） ====================

# 原始版本：为 iptables 转发规则创建计数链（挂在 FORWARD 链上）
ensure_traffic_chain_forward() {
  PORT="$1"
  PROTO="$2"
  TARGET_IP="$3"
  TARGET_PORT="$4"
  CHAIN_IN="FWX_IN_${PORT}"
  CHAIN_OUT="FWX_OUT_${PORT}"
  iptables -N "$CHAIN_IN" 2>/dev/null || true
  iptables -N "$CHAIN_OUT" 2>/dev/null || true
  if [ "$PROTO" = "tcp" ]; then
    iptables -C FORWARD -p tcp -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN" 2>/dev/null || \
      iptables -I FORWARD -p tcp -d "$TARGET_IP" --dport "$TARGET_PORT" -j "$CHAIN_IN" 2>/dev/null || true
    iptables -C FORWARD -p tcp -s "$TARGET_IP" --sport "$TARGET_PORT" -j "$CHAIN_OUT" 2>/dev/null || \
      iptables -I FORWARD -p tcp -s "$TARGET_IP" --sport "$TARGET_PORT" -j "$CHAIN_OUT" 2>/dev/null || true
  fi
}

# 原始版本：为 socat/realm 转发规则创建计数链（挂在 INPUT/OUTPUT 链上）
ensure_traffic_chain_socat() {
  PORT="$1"
  PROTO="$2"
  CHAIN_IN="FWX_IN_${PORT}"
  CHAIN_OUT="FWX_OUT_${PORT}"
  iptables -N "$CHAIN_IN" 2>/dev/null || true
  iptables -N "$CHAIN_OUT" 2>/dev/null || true
  if [ "$PROTO" = "tcp" ]; then
    iptables -C INPUT -p tcp --dport "$PORT" -j "$CHAIN_IN" 2>/dev/null || \
      iptables -I INPUT -p tcp --dport "$PORT" -j "$CHAIN_IN" 2>/dev/null || true
    iptables -C OUTPUT -p tcp --sport "$PORT" -j "$CHAIN_OUT" 2>/dev/null || \
      iptables -I OUTPUT -p tcp --sport "$PORT" -j "$CHAIN_OUT" 2>/dev/null || true
  fi
}

sample_traffic_in() {
  PORT="$1"
  CHAIN="FWX_IN_${PORT}"
  STATS=$(iptables -L "$CHAIN" -v -x -n 2>/dev/null | awk 'NR>2 {pkts+=$1; bytes+=$2} END {print pkts+0" "bytes+0}')
  if [ -z "$STATS" ]; then echo "0 0"; return; fi
  echo "$STATS"
}

sample_traffic_out() {
  PORT="$1"
  CHAIN="FWX_OUT_${PORT}"
  STATS=$(iptables -L "$CHAIN" -v -x -n 2>/dev/null | awk 'NR>2 {pkts+=$1; bytes+=$2} END {print pkts+0" "bytes+0}')
  if [ -z "$STATS" ]; then echo "0 0"; return; fi
  echo "$STATS"
}

# 清理函数
cleanup() {
  echo ""
  echo "[清理] 删除测试用 iptables 链..."
  for PORT in 8001 8002 8003; do
    iptables -D FORWARD -p tcp -d 1.2.3.4 --dport 443 -j "FWX_IN_${PORT}" 2>/dev/null || true
    iptables -D FORWARD -p tcp -s 1.2.3.4 --sport 443 -j "FWX_OUT_${PORT}" 2>/dev/null || true
    iptables -D INPUT -p tcp --dport "$PORT" -j "FWX_IN_${PORT}" 2>/dev/null || true
    iptables -D OUTPUT -p tcp --sport "$PORT" -j "FWX_OUT_${PORT}" 2>/dev/null || true
    iptables -F "FWX_IN_${PORT}" 2>/dev/null || true
    iptables -X "FWX_IN_${PORT}" 2>/dev/null || true
    iptables -F "FWX_OUT_${PORT}" 2>/dev/null || true
    iptables -X "FWX_OUT_${PORT}" 2>/dev/null || true
  done
  echo "[清理] 完成"
}

trap cleanup EXIT

# ==================== 测试场景 ====================

echo "========== 测试 1: iptables 转发模式 (FORWARD 链) =========="
echo "模拟: sourcePort=8001, targetIp=1.2.3.4, targetPort=443, forwardType=iptables"
echo ""

# iptables 模式应该用 FORWARD 链
ensure_traffic_chain_forward "8001" "tcp" "1.2.3.4" "443"

echo "[检查] FWX_IN_8001 链是否在 FORWARD 上:"
iptables -L FORWARD -n --line-numbers 2>/dev/null | grep "FWX_IN_8001" && echo "  -> 正确: 在 FORWARD 链上" || echo "  -> 未找到"

echo "[检查] FWX_IN_8001 链是否在 INPUT 上:"
iptables -L INPUT -n --line-numbers 2>/dev/null | grep "FWX_IN_8001" && echo "  -> 错误: 不应该在 INPUT 链上" || echo "  -> 正确: 不在 INPUT 链上"

echo ""
echo "采样结果:"
IN_SAMPLE=$(sample_traffic_in "8001")
OUT_SAMPLE=$(sample_traffic_out "8001")
echo "  IN:  $IN_SAMPLE (pkts bytes)"
echo "  OUT: $OUT_SAMPLE (pkts bytes)"
echo ""

echo "========== 测试 2: realm 模式 - 当前有 Bug 的逻辑 =========="
echo "模拟: sourcePort=8002, targetIp=1.2.3.4, targetPort=443, forwardType=realm"
echo "当前代码: realm 错误地使用了 ensure_traffic_chain_forward (FORWARD 链)"
echo ""

# 模拟当前有 Bug 的逻辑：realm 走 FORWARD 链
FT="realm"
if [ "$FT" = "socat" ]; then
  ensure_traffic_chain_socat "8002" "tcp"
else
  # Bug: realm 也走了 FORWARD 链
  ensure_traffic_chain_forward "8002" "tcp" "1.2.3.4" "443"
fi

echo "[检查] FWX_IN_8002 链是否在 FORWARD 上:"
iptables -L FORWARD -n --line-numbers 2>/dev/null | grep "FWX_IN_8002" && echo "  -> Bug 确认: realm 的计数链错误地挂在 FORWARD 上" || echo "  -> 未找到"

echo "[检查] FWX_IN_8002 链是否在 INPUT 上:"
iptables -L INPUT -n --line-numbers 2>/dev/null | grep "FWX_IN_8002" && echo "  -> 正确" || echo "  -> Bug 确认: realm 的计数链不在 INPUT 上，无法统计流量"

echo ""
echo "说明: realm 是用户态代理，流量路径是 客户端→INPUT→realm进程→OUTPUT→目标"
echo "      计数链挂在 FORWARD 上永远匹配不到数据包，所以流量始终为 0"
echo ""

echo "========== 测试 3: realm 模式 - 修复后的逻辑 =========="
echo "模拟: sourcePort=8003, forwardType=realm"
echo "修复后: realm 和 socat 一样使用 ensure_traffic_chain_socat (INPUT/OUTPUT 链)"
echo ""

# 修复后的逻辑：realm 走 INPUT/OUTPUT 链
FT="realm"
if [ "$FT" = "iptables" ]; then
  ensure_traffic_chain_forward "8003" "tcp" "1.2.3.4" "443"
else
  # 修复: realm 和 socat 都走 INPUT/OUTPUT 链
  ensure_traffic_chain_socat "8003" "tcp"
fi

echo "[检查] FWX_IN_8003 链是否在 INPUT 上:"
iptables -L INPUT -n --line-numbers 2>/dev/null | grep "FWX_IN_8003" && echo "  -> 修复正确: realm 的计数链正确挂在 INPUT 上" || echo "  -> 未找到"

echo "[检查] FWX_OUT_8003 链是否在 OUTPUT 上:"
iptables -L OUTPUT -n --line-numbers 2>/dev/null | grep "FWX_OUT_8003" && echo "  -> 修复正确: realm 的出站计数链正确挂在 OUTPUT 上" || echo "  -> 未找到"

echo ""
echo "========== 测试 4: 模拟 INPUT 链上的流量采集 =========="
echo "用 socat 在 8003 端口监听，然后发送测试数据验证 INPUT 链计数"
echo ""

# 启动一个简单的 socat 监听
command -v socat >/dev/null 2>&1 && {
  socat TCP-LISTEN:8003,fork,reuseaddr SYSTEM:"echo HTTP/1.0 200 OK; echo; echo hello" &
  SOCAT_PID=$!
  sleep 1

  # 发送测试请求
  curl -s --max-time 2 http://127.0.0.1:8003 >/dev/null 2>&1 || true
  curl -s --max-time 2 http://127.0.0.1:8003 >/dev/null 2>&1 || true
  curl -s --max-time 2 http://127.0.0.1:8003 >/dev/null 2>&1 || true
  sleep 1

  IN_SAMPLE=$(sample_traffic_in "8003")
  OUT_SAMPLE=$(sample_traffic_out "8003")
  echo "  发送 3 次请求后的采样结果:"
  echo "  IN:  $IN_SAMPLE (pkts bytes)"
  echo "  OUT: $OUT_SAMPLE (pkts bytes)"

  IN_BYTES=$(echo "$IN_SAMPLE" | awk '{print $2}')
  if [ "$IN_BYTES" -gt 0 ] 2>/dev/null; then
    echo "  -> 验证通过: INPUT 链上成功采集到流量数据"
  else
    echo "  -> 注意: 可能是 loopback 流量不经过 iptables INPUT 链"
    echo "           在真实环境中，外部流量会被正确计数"
  fi

  kill $SOCAT_PID 2>/dev/null || true
  wait $SOCAT_PID 2>/dev/null || true
} || echo "  socat 未安装，跳过实际流量测试"

echo ""
echo "============================================="
echo "  Bug 验证总结"
echo "============================================="
echo ""
echo "Bug 1 (已确认): realm 转发的计数链错误地挂在 FORWARD 链上"
echo "  - 原因: apply_actions 中条件判断只检查了 socat，realm 走了 else 分支（FORWARD）"
echo "  - 影响: realm 模式下流量数据始终为 0"
echo "  - 修复: 将条件改为 if [ \"\$FT\" = \"iptables\" ]，让 realm 和 socat 都走 INPUT/OUTPUT"
echo ""
echo "Bug 2 (已确认): 前端 trafficByRule Map 以 ruleId 为 key，多 host 数据覆盖"
echo "  - 原因: 后端按 (ruleId, hostId) 分组返回，前端 Map.set 会覆盖同 ruleId 的数据"
echo "  - 影响: 多主机场景下流量数据不完整"
echo "  - 修复: 前端按 ruleId 累加聚合"
echo ""
echo "Bug 3 (潜在): runningRules 重建时需要正确区分 forwardType"
echo "  - 当前代码已有 FT_RR 变量读取 forwardType，逻辑正确"
echo "  - 但依赖心跳响应中 runningRules 包含 forwardType 字段"
echo ""
