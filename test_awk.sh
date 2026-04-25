#!/bin/bash
# 模拟 ping 输出的最后一行
PING_RESULT="rtt min/avg/max/mdev = 1.234/5.678/10.123/2.345 ms"
echo "Input: $PING_RESULT"

# 测试 awk 解析
LAT=$(echo "$PING_RESULT" | awk -F "/" "NR==1{printf \"%d\", \$5}" 2>/dev/null || echo 0)
echo "Parsed latency: ${LAT}ms"

# 实际 ping 测试
echo ""
echo "Real ping test to 8.8.8.8:"
REAL_RESULT=$(ping -c 3 -W 2 "8.8.8.8" 2>/dev/null | tail -1)
echo "Raw: $REAL_RESULT"
if echo "$REAL_RESULT" | grep -q "avg"; then
  REAL_LAT=$(echo "$REAL_RESULT" | awk -F "/" "NR==1{printf \"%d\", \$5}" 2>/dev/null || echo 0)
  echo "Parsed: ${REAL_LAT}ms"
else
  echo "ping unreachable"
fi
