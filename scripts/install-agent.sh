#!/bin/bash
# ForwardX Agent 管理脚本（GitHub 入口）
#
# 该脚本是 ForwardX Agent 的 GitHub 官方入口。
# 安装/升级时从面板拉取与版本配套的安装脚本（含 Token 嵌入、注册逻辑等）。
# 卸载时本地执行，不依赖面板。
#
# 用法：
#   # 安装
#   curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
#     PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_TOKEN
#
#   # 卸载（完全本地，不依赖面板）
#   curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
#     bash -s -- uninstall
#
#   # 升级
#   curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
#     PANEL_URL="http://your-panel:3000" bash -s -- upgrade
#

set -e

ACTION="${1:-}"
TOKEN="${2:-}"

SERVICE_NAME="forwardx-agent"
GO_AGENT_BIN="/usr/local/bin/forwardx-agent"
FXP_BIN="/usr/local/bin/forwardx-fxp"
CONFIG_DIR="/etc/forwardx-agent"
LOG_DIR="/var/log/forwardx-agent"
STATE_DIR="/var/lib/forwardx-agent"

show_help() {
  cat <<EOF
======================================
  ForwardX Agent 管理（GitHub 入口）
======================================

用法：
  安装 Agent：
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \\
      PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_TOKEN

  卸载 Agent：
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \\
      bash -s -- uninstall

  升级 Agent：
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \\
      PANEL_URL="http://your-panel:3000" bash -s -- upgrade

参数：
  install   <TOKEN>  安装 Agent（需要环境变量 PANEL_URL）
  upgrade   [TOKEN]  升级 Agent；默认复用现有配置
  uninstall          完全卸载 Agent（不依赖面板）

EOF
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[错误] 请使用 root 权限运行此脚本"
    exit 1
  fi
}

read_existing_config() {
  if [ -f "$CONFIG_DIR/config.json" ]; then
    EXISTING_PANEL_URL=$(jq -r ".panelUrl // empty" "$CONFIG_DIR/config.json" 2>/dev/null || true)
    EXISTING_TOKEN=$(jq -r ".token // empty" "$CONFIG_DIR/config.json" 2>/dev/null || true)
  fi
}

# 从面板下载自包含安装脚本并执行
run_panel_installer() {
  local token="$1"
  local timeout="${2:-60}"
  local tmp_script
  tmp_script=$(mktemp /tmp/forwardx-install.XXXXXX)

  PANEL_URL="${PANEL_URL%/}"
  local url="${PANEL_URL}/api/agent/install.sh?token=${token}"

  echo "[信息] 从面板获取安装脚本: $PANEL_URL"
  if ! curl -fsSL --max-time "$timeout" "$url" -o "$tmp_script"; then
    rm -f "$tmp_script"
    return 1
  fi
  if [ ! -s "$tmp_script" ]; then
    rm -f "$tmp_script"
    return 1
  fi
  chmod 700 "$tmp_script"
  if bash "$tmp_script" </dev/null; then
    rm -f "$tmp_script"
    return 0
  fi
  local rc=$?
  rm -f "$tmp_script"
  return "$rc"
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

  echo "======================================"
  echo "  ForwardX Agent 安装（GitHub 入口）"
  echo "======================================"
  echo "面板地址: $PANEL_URL"
  echo "Token: ${AGENT_TOKEN:0:8}***"
  echo ""

  echo "[信息] 正在从面板获取安装脚本..."
  if ! run_panel_installer "$AGENT_TOKEN" 60; then
    echo ""
    echo "[错误] 无法从面板获取安装脚本"
    echo "       请检查面板地址是否正确、网络是否通畅"
    echo "       也可以直接从面板安装："
    echo "       curl -sL $PANEL_URL/api/agent/install.sh | bash -s -- install YOUR_TOKEN"
    exit 1
  fi
}

do_upgrade() {
  require_root
  OVERRIDE_TOKEN="$1"

  read_existing_config
  PANEL_URL="${PANEL_URL:-${EXISTING_PANEL_URL:-}}"
  AGENT_TOKEN="${OVERRIDE_TOKEN:-${EXISTING_TOKEN:-}}"

  if [ -z "$PANEL_URL" ]; then
    echo "[错误] 未找到面板地址。请设置 PANEL_URL："
    echo "       PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh upgrade"
    exit 1
  fi

  if [ -z "$AGENT_TOKEN" ]; then
    echo "[错误] 未找到 Agent Token。请传入 Token 或重新安装："
    echo "       PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh upgrade YOUR_TOKEN"
    exit 1
  fi

  PANEL_URL="${PANEL_URL%/}"

  echo "======================================"
  echo "  ForwardX Agent 升级程序"
  echo "======================================"
  echo "面板地址: $PANEL_URL"
  echo "Token: ${AGENT_TOKEN:0:8}***"
  echo ""

  echo "[信息] 正在从面板获取最新安装脚本..."
  if ! run_panel_installer "$AGENT_TOKEN" 60; then
    echo ""
    echo "[错误] 升级失败：无法从面板获取安装脚本"
    echo "       请检查面板地址和网络连接"
    exit 1
  fi
}

do_uninstall() {
  require_root
  echo "======================================"
  echo "  ForwardX Agent 卸载程序（本地）"
  echo "======================================"
  echo ""

  echo "[步骤 1/5] 停止 Agent 服务..."
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME"
    echo "[信息] 服务已停止"
  else
    echo "[信息] 服务未在运行"
  fi

  echo "[步骤 2/5] 禁用并删除 systemd 服务..."
  if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    echo "[信息] 服务文件已删除"
  fi

  echo "[步骤 3/5] 清理二进制和配置..."
  rm -f "$GO_AGENT_BIN" "$FXP_BIN"
  rm -rf "$CONFIG_DIR"
  echo "[信息] Go Agent 文件已删除"

  echo "[步骤 4/5] 清理转发进程和 iptables 规则..."
  pkill -f "/usr/local/bin/forwardx-fxp" 2>/dev/null || true
  pkill -f "realm -l" 2>/dev/null || true
  pkill -f "socat.*LISTEN" 2>/dev/null || true
  for SVC in /etc/systemd/system/forwardx-socat-*.service /etc/systemd/system/forwardx-realm-*.service /etc/systemd/system/forwardx-gost-*.service; do
    if [ -f "$SVC" ]; then
      SVCNAME=$(basename "$SVC" .service)
      systemctl stop "$SVCNAME" 2>/dev/null || true
      systemctl disable "$SVCNAME" 2>/dev/null || true
      rm -f "$SVC"
      echo "[信息] 已删除服务: $SVCNAME"
    fi
  done
  systemctl daemon-reload 2>/dev/null || true

  # 清理 mangle 表中的 FWX 计数链
  for CH in $(iptables -t mangle -L 2>/dev/null | awk '/^Chain FWX_/ {print $2}'); do
    for P in tcp udp; do
      iptables -t mangle -D PREROUTING -p $P -j "$CH" 2>/dev/null || true
      iptables -t mangle -D POSTROUTING -p $P -j "$CH" 2>/dev/null || true
      iptables -t mangle -D INPUT -p $P -j "$CH" 2>/dev/null || true
      iptables -t mangle -D OUTPUT -p $P -j "$CH" 2>/dev/null || true
      iptables -t mangle -D FORWARD -p $P -j "$CH" 2>/dev/null || true
    done
    iptables -t mangle -F "$CH" 2>/dev/null || true
    iptables -t mangle -X "$CH" 2>/dev/null || true
    echo "[信息] 已清理 mangle 计数链: $CH"
  done

  # 清理 FWX_LIMIT 链
  for CH in $(iptables -L 2>/dev/null | awk '/^Chain FWX_LIMIT_/ {print $2}'); do
    iptables -D INPUT -p tcp -j "$CH" 2>/dev/null || true
    iptables -D FORWARD -p tcp -j "$CH" 2>/dev/null || true
    iptables -F "$CH" 2>/dev/null || true
    iptables -X "$CH" 2>/dev/null || true
    echo "[信息] 已清理连接限制链: $CH"
  done

  # 清理 nat 表中的 DNAT/MASQUERADE 规则
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
  echo "[信息] iptables 规则已清理"

  echo "[步骤 5/5] 清理日志和状态文件..."
  rm -rf "$LOG_DIR" 2>/dev/null || true
  rm -rf "$STATE_DIR" 2>/dev/null || true
  echo "[信息] 日志和状态文件已删除"

  echo ""
  echo "======================================"
  echo "  ForwardX Agent 卸载完成!"
  echo "======================================"
}

case "$ACTION" in
  install)
    do_install "$TOKEN"
    ;;
  upgrade|update)
    do_upgrade "$TOKEN"
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

exit 0
