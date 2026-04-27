#!/bin/bash
# ForwardX Agent 管理脚本（GitHub 入口）
#
# 该脚本是 ForwardX Agent 的 GitHub 官方入口脚本。面板上展示的一键安装/卸载命令
# 第一跳指向此脚本，避免面板暂时不可达时无法获取脚本本身。
#
# 用法：
#   # 安装
#   curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
#     PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_TOKEN
#
#   # 卸载
#   curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
#     bash -s -- uninstall
#
# 设计原则：
#   - 安装阶段：仍需向面板请求与版本配套的"完整安装包"（含密钥、注册、systemd 单元等）
#     这是必要的——加密密钥派生需要 token，systemd 单元也需要确切的 PANEL_URL
#   - 卸载阶段：完全本地化，停止服务、清理 iptables 规则、删除文件，不依赖面板
#   - 容错性：当 GitHub 入口本身不可达时，用户仍可直接 curl 面板的 install.sh 备用
#

set -e

ACTION="${1:-}"
TOKEN="${2:-}"

SERVICE_NAME="forwardx-agent"
INSTALL_DIR="/opt/forwardx-agent"
LOG_DIR="/var/log/forwardx-agent"
STATE_DIR="/var/lib/forwardx-agent"

show_help() {
  cat <<EOF
======================================
  ForwardX Agent 管理脚本（GitHub 入口）
======================================

用法：
  安装 Agent：
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \\
      PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_TOKEN

  卸载 Agent：
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \\
      bash -s -- uninstall

参数：
  install   <TOKEN>  安装 Agent 并注册到面板（需要环境变量 PANEL_URL）
  uninstall          完全卸载 Agent 及相关组件（不依赖面板）

EOF
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[错误] 请使用 root 权限运行此脚本"
    exit 1
  fi
}

do_install() {
  require_root
  AGENT_TOKEN="$1"

  if [ -z "$AGENT_TOKEN" ]; then
    echo "[错误] 安装模式需要提供 Agent Token"
    echo "用法: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh install YOUR_TOKEN"
    exit 1
  fi

  if [ -z "${PANEL_URL:-}" ]; then
    echo "[错误] 缺少 PANEL_URL 环境变量"
    echo "用法: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh install YOUR_TOKEN"
    exit 1
  fi

  # 去除尾部斜杠以保证拼接正确
  PANEL_URL="${PANEL_URL%/}"

  echo "======================================"
  echo "  ForwardX Agent 一键安装（GitHub 入口）"
  echo "======================================"
  echo "面板地址: $PANEL_URL"
  echo "Token: ${AGENT_TOKEN:0:8}***"
  echo ""

  # 安装阶段必须向面板请求完整安装包：因为完整脚本包含 token 注入后的 systemd 单元、
  # 密钥派生逻辑、注册时携带的元数据等，必须由面板按当前会话生成。
  echo "[信息] 正在向面板请求与版本配套的完整安装脚本..."
  if ! curl -fsSL --max-time 60 "$PANEL_URL/api/agent/full-install.sh?token=$AGENT_TOKEN" | bash; then
    echo ""
    echo "[错误] 面板暂时不可达，无法获取完整安装包"
    echo "       请检查面板地址是否正确、网络是否通畅，然后重试"
    exit 1
  fi
}

do_uninstall() {
  require_root
  echo "======================================"
  echo "  ForwardX Agent 卸载程序（本地）"
  echo "======================================"
  echo ""

  echo "[步骤 1/6] 停止 Agent 服务..."
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME"
    echo "[信息] 服务已停止"
  else
    echo "[信息] 服务未在运行"
  fi

  echo "[步骤 2/6] 禁用并删除服务..."
  if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    echo "[信息] 服务文件已删除"
  else
    echo "[信息] 服务文件不存在"
  fi

  echo "[步骤 3/6] 清理 Agent 文件..."
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
    echo "[信息] 安装目录已删除: $INSTALL_DIR"
  else
    echo "[信息] 安装目录不存在"
  fi

  echo "[步骤 4/6] 清理转发进程和服务..."
  pkill -f "realm -l" 2>/dev/null && echo "[信息] 已停止所有 realm 转发进程" || echo "[信息] 无 realm 进程需要停止"
  pkill -f "socat.*LISTEN" 2>/dev/null && echo "[信息] 已停止所有 socat 转发进程" || echo "[信息] 无 socat 进程需要停止"
  for SVC in /etc/systemd/system/forwardx-socat-*.service /etc/systemd/system/forwardx-realm-*.service; do
    if [ -f "$SVC" ]; then
      SVCNAME=$(basename "$SVC" .service)
      systemctl stop "$SVCNAME" 2>/dev/null || true
      systemctl disable "$SVCNAME" 2>/dev/null || true
      rm -f "$SVC"
      echo "[信息] 已删除服务: $SVCNAME"
    fi
  done
  systemctl daemon-reload 2>/dev/null || true

  echo "[步骤 5/6] 清理转发规则和流量计数链..."
  for CH in $(iptables -t mangle -L 2>/dev/null | awk '/^Chain FWX_/ {print $2}'); do
    for P in tcp udp; do
      iptables -t mangle -D PREROUTING -p $P -j "$CH" 2>/dev/null || true
      iptables -t mangle -D POSTROUTING -p $P -j "$CH" 2>/dev/null || true
    done
    iptables -t mangle -F "$CH" 2>/dev/null || true
    iptables -t mangle -X "$CH" 2>/dev/null || true
    echo "[信息] 已清理 mangle 计数链: $CH"
  done
  for CH in $(iptables -L 2>/dev/null | awk '/^Chain FWX_/ {print $2}'); do
    for P in tcp udp; do
      iptables -D FORWARD -p $P -j "$CH" 2>/dev/null || true
      iptables -D INPUT -p $P -j "$CH" 2>/dev/null || true
      iptables -D OUTPUT -p $P -j "$CH" 2>/dev/null || true
    done
    iptables -F "$CH" 2>/dev/null || true
    iptables -X "$CH" 2>/dev/null || true
    echo "[信息] 已清理 filter 计数链: $CH"
  done
  while iptables -t nat -S PREROUTING 2>/dev/null | grep -q "DNAT"; do
    RULE=$(iptables -t nat -S PREROUTING 2>/dev/null | grep "DNAT" | head -1 | sed "s/^-A/-D/")
    [ -z "$RULE" ] && break
    iptables -t nat $RULE 2>/dev/null || break
  done
  while iptables -t nat -S POSTROUTING 2>/dev/null | grep -q "MASQUERADE"; do
    RULE=$(iptables -t nat -S POSTROUTING 2>/dev/null | grep "MASQUERADE" | head -1 | sed "s/^-A/-D/")
    [ -z "$RULE" ] && break
    iptables -t nat $RULE 2>/dev/null || break
  done
  echo "[信息] 转发规则和计数链已清理"

  echo "[步骤 6/6] 清理日志和状态文件..."
  if [ -d "$LOG_DIR" ]; then
    rm -rf "$LOG_DIR"
    echo "[信息] 日志目录已删除: $LOG_DIR"
  fi
  if [ -d "$STATE_DIR" ]; then
    rm -rf "$STATE_DIR"
    echo "[信息] 状态目录已删除: $STATE_DIR"
  fi

  echo ""
  echo "======================================"
  echo "  ForwardX Agent 卸载完成!"
  echo "======================================"
}

case "$ACTION" in
  install)
    do_install "$TOKEN"
    ;;
  uninstall|remove|delete)
    do_uninstall
    ;;
  *)
    show_help
    if [ -n "$ACTION" ]; then
      echo "[提示] 未知操作: $ACTION"
      echo ""
    fi
    exit 1
    ;;
esac
