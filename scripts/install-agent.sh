#!/bin/bash
# ForwardX Agent 安装脚本（GitHub 官方副本）
#
# 该脚本是 Agent 引导脚本（来自面板 /api/agent/install.sh）会"优先尝试"下载的版本。
# 其本身只是一个薄壳：从指定的 PANEL_URL 拉取与该面板版本完全一致的完整安装脚本。
# 这样设计的好处：
#   - 用户从 GitHub 直接获取，能在面板暂时不可达的网络环境下快速预演脚本
#   - 始终与面板版本保持兼容（PANEL_URL 由调用方在环境变量中显式提供）
#
# 用法：
#   PANEL_URL="http://your-panel:3000" AGENT_TOKEN="xxxx" bash install-agent.sh
#
# 也可由引导脚本自动调用：
#   curl -sL PANEL_URL/api/agent/install.sh | PANEL_URL="..." bash -s -- install AGENT_TOKEN
#

set -e

if [ -z "${PANEL_URL:-}" ]; then
  echo "[错误] 缺少 PANEL_URL 环境变量"
  echo "用法: PANEL_URL=\"http://your-panel:3000\" AGENT_TOKEN=\"xxxx\" bash install-agent.sh"
  exit 1
fi

if [ -z "${AGENT_TOKEN:-}" ]; then
  echo "[错误] 缺少 AGENT_TOKEN 环境变量"
  echo "用法: PANEL_URL=\"http://your-panel:3000\" AGENT_TOKEN=\"xxxx\" bash install-agent.sh"
  exit 1
fi

if [ "$(id -u)" != "0" ]; then
  echo "[错误] 请使用 root 权限运行此脚本"
  exit 1
fi

echo "======================================"
echo "  ForwardX Agent 一键安装（GitHub 入口）"
echo "======================================"
echo "面板地址: $PANEL_URL"
echo "Token: ${AGENT_TOKEN:0:8}***"
echo ""

# 直接将面板生成的完整安装脚本管道执行
echo "[信息] 正在向面板请求与版本配套的完整安装脚本..."
curl -fsSL --max-time 60 "$PANEL_URL/api/agent/full-install.sh?token=$AGENT_TOKEN" | bash
