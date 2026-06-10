#!/bin/bash
set -euo pipefail

# ForwardX Agent GitHub 入口脚本
# install/upgrade: 从面板获取安装脚本并自动执行
# uninstall: 本地清理，不依赖面板

ACTION="${1:-}"
TOKEN="${2:-}"

GITHUB_ACCELERATOR_URL="${GITHUB_ACCELERATOR_URL:-https://git.poouo.com}"
GITHUB_ACCELERATOR_ENABLED="${GITHUB_ACCELERATOR_ENABLED:-false}"
FORWARDX_AGENT_PANEL_FIRST="${FORWARDX_AGENT_PANEL_FIRST:-false}"

SERVICE_NAME="forwardx-agent"
GO_AGENT_BIN="/usr/local/bin/forwardx-agent"
FXP_BIN="/usr/local/bin/forwardx-fxp"
CONFIG_DIR="/etc/forwardx-agent"
LOG_DIR="/var/log/forwardx-agent"
STATE_DIR="/var/lib/forwardx-agent"

show_help() {
  cat <<'EOF'
======================================
  ForwardX Agent 管理工具
======================================

用法:
  安装 Agent:
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
      PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_TOKEN

  卸载 Agent:
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
      bash -s -- uninstall

  升级 Agent:
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
      PANEL_URL="http://your-panel:3000" bash -s -- upgrade [YOUR_TOKEN]

参数:
  install   <TOKEN>  安装 Agent 并注册到面板
  upgrade   [TOKEN]  升级 Agent，默认复用现有配置
  uninstall          完全卸载 Agent 及相关服务
EOF
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[错误] 请使用 root 权限运行"
    exit 1
  fi
}

is_systemd_host() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

remove_service_by_name() {
  local name="$1"
  if is_systemd_host; then
    systemctl stop "$name" 2>/dev/null || true
    systemctl disable "$name" 2>/dev/null || true
    rm -f "/etc/systemd/system/$name.service"
    systemctl daemon-reload 2>/dev/null || true
  fi
  if command -v rc-service >/dev/null 2>&1; then
    rc-service "$name" stop 2>/dev/null || true
  fi
  if command -v rc-update >/dev/null 2>&1; then
    rc-update del "$name" default 2>/dev/null || true
  fi
  if [ -x "/etc/init.d/$name" ]; then
    "/etc/init.d/$name" stop 2>/dev/null || true
  fi
  command -v update-rc.d >/dev/null 2>&1 && update-rc.d -f "$name" remove >/dev/null 2>&1 || true
  command -v chkconfig >/dev/null 2>&1 && chkconfig "$name" off >/dev/null 2>&1 || true
  rm -f "/etc/init.d/$name"
}

read_existing_config() {
  EXISTING_PANEL_URL=""
  EXISTING_TOKEN=""
  if [ -f "$CONFIG_DIR/config.json" ] && command -v jq >/dev/null 2>&1; then
    EXISTING_PANEL_URL="$(jq -r '.panelUrl // empty' "$CONFIG_DIR/config.json" 2>/dev/null || true)"
    EXISTING_TOKEN="$(jq -r '.token // empty' "$CONFIG_DIR/config.json" 2>/dev/null || true)"
  fi
}

run_panel_installer() {
  local mode="$1"
  local token="$2"
  local timeout="${3:-20}"
  local tmp_script

  if [ -z "${PANEL_URL:-}" ]; then
    echo "[错误] 缺少 PANEL_URL"
    return 1
  fi

  PANEL_URL="${PANEL_URL%/}"
  tmp_script="$(mktemp /tmp/forwardx-install.XXXXXX)"

  local url="${PANEL_URL}/api/agent/install.sh"

  echo "[信息] 正在从面板获取安装脚本: ${PANEL_URL}"
  if ! curl -fsSL --max-time "$timeout" "$url" -o "$tmp_script"; then
    rm -f "$tmp_script"
    return 1
  fi

  if [ ! -s "$tmp_script" ]; then
    rm -f "$tmp_script"
    return 1
  fi

  chmod 700 "$tmp_script"

  if GITHUB_ACCELERATOR_ENABLED="$GITHUB_ACCELERATOR_ENABLED" \
    GITHUB_ACCELERATOR_URL="$GITHUB_ACCELERATOR_URL" \
    FORWARDX_AGENT_PANEL_FIRST="$FORWARDX_AGENT_PANEL_FIRST" \
    bash "$tmp_script" "$mode" "$token" </dev/null; then
    rm -f "$tmp_script"
    return 0
  fi

  local rc=$?
  rm -f "$tmp_script"
  return "$rc"
}

do_install() {
  require_root
  local agent_token="$1"

  if [ -z "$agent_token" ]; then
    echo "[错误] install 需要 Agent Token"
    echo "用法: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh install YOUR_TOKEN"
    exit 1
  fi

  if [ -z "${PANEL_URL:-}" ]; then
    echo "[错误] 缺少 PANEL_URL"
    echo "用法: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh install YOUR_TOKEN"
    exit 1
  fi

  echo "======================================"
  echo "  ForwardX Agent 安装程序（GitHub 入口）"
  echo "======================================"
  echo "Panel URL: ${PANEL_URL}"
  echo "Token: ${agent_token:0:8}***"
  echo ""

  echo "[信息] 正在从面板获取安装脚本..."
  if ! run_panel_installer "install" "$agent_token" 20; then
    echo ""
    echo "[错误] 无法从面板获取安装脚本"
    echo "       请检查面板地址和网络连接"
    exit 1
  fi
}

do_upgrade() {
  require_root
  local override_token="$1"

  read_existing_config
  PANEL_URL="${PANEL_URL:-${EXISTING_PANEL_URL:-}}"
  local agent_token="${override_token:-${EXISTING_TOKEN:-}}"

  if [ -z "${PANEL_URL:-}" ]; then
    echo "[错误] 未找到 PANEL_URL"
    echo "用法: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh upgrade [YOUR_TOKEN]"
    exit 1
  fi

  echo "======================================"
  echo "  ForwardX Agent 升级程序"
  echo "======================================"
  echo "Panel URL: ${PANEL_URL}"
  if [ -n "$agent_token" ]; then
    echo "Token: ${agent_token:0:8}***"
  else
    echo "Token: (使用面板脚本或现有配置)"
  fi
  echo ""

  echo "[信息] 正在从面板获取最新安装脚本..."
  if ! run_panel_installer "upgrade" "$agent_token" 20; then
    echo ""
    echo "[错误] 升级失败：无法从面板获取安装脚本"
    exit 1
  fi
}

do_uninstall() {
  require_root
  echo "======================================"
  echo "  ForwardX Agent 卸载程序（本地）"
  echo "======================================"

  remove_service_by_name "$SERVICE_NAME"

  for pid in $(pgrep -f "[/]usr/local/bin/forwardx-fxp" 2>/dev/null || true); do
    if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi
    kill "$pid" 2>/dev/null || true
  done
  for pid in $(pgrep -f "[r]ealm -l" 2>/dev/null || true); do
    if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi
    kill "$pid" 2>/dev/null || true
  done
  for pid in $(pgrep -f "[s]ocat.*LISTEN" 2>/dev/null || true); do
    if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then continue; fi
    kill "$pid" 2>/dev/null || true
  done

  for SVC in /etc/systemd/system/forwardx-socat-*.service /etc/systemd/system/forwardx-realm-*.service /etc/systemd/system/forwardx-gost-*.service; do
    if [ -f "$SVC" ]; then
      SVCNAME="$(basename "$SVC" .service)"
      remove_service_by_name "$SVCNAME"
    fi
  done
  for SVC in /etc/init.d/forwardx-socat-* /etc/init.d/forwardx-realm-* /etc/init.d/forwardx-gost-* /etc/init.d/forwardx-tunnels; do
    if [ -f "$SVC" ]; then
      SVCNAME="$(basename "$SVC")"
      remove_service_by_name "$SVCNAME"
    fi
  done

  rm -f "$GO_AGENT_BIN" "$FXP_BIN"
  rm -rf "$CONFIG_DIR" "$LOG_DIR" "$STATE_DIR"

  echo "[完成] Agent 已卸载"
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
      echo ""
      echo "[信息] 未知操作: $ACTION"
    fi
    exit 1
    ;;
esac

exit 0
