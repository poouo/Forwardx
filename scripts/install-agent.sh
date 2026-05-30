#!/bin/bash
set -euo pipefail

# ForwardX Agent GitHub entry script
# install/upgrade: fetch panel installer and run non-interactively
# uninstall: local fallback uninstall (no panel dependency)

ACTION="${1:-}"
TOKEN="${2:-}"

SERVICE_NAME="forwardx-agent"
GO_AGENT_BIN="/usr/local/bin/forwardx-agent"
FXP_BIN="/usr/local/bin/forwardx-fxp"
CONFIG_DIR="/etc/forwardx-agent"
LOG_DIR="/var/log/forwardx-agent"
STATE_DIR="/var/lib/forwardx-agent"

show_help() {
  cat <<'EOF'
======================================
  ForwardX Agent Manager
======================================

Usage:
  Install Agent:
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
      PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_TOKEN

  Uninstall Agent:
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
      bash -s -- uninstall

  Upgrade Agent:
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
      PANEL_URL="http://your-panel:3000" bash -s -- upgrade [YOUR_TOKEN]

Args:
  install   <TOKEN>  Install Agent and register to panel
  upgrade   [TOKEN]  Upgrade Agent, reuse existing config by default
  uninstall          Fully uninstall Agent and related services
EOF
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[ERROR] Please run as root"
    exit 1
  fi
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
  local timeout="${3:-60}"
  local tmp_script

  if [ -z "${PANEL_URL:-}" ]; then
    echo "[ERROR] PANEL_URL is required"
    return 1
  fi

  PANEL_URL="${PANEL_URL%/}"
  tmp_script="$(mktemp /tmp/forwardx-install.XXXXXX)"

  local url="${PANEL_URL}/api/agent/install.sh"
  if [ -n "$token" ]; then
    url="${url}?token=${token}"
  fi

  echo "[INFO] Fetching installer from panel: ${PANEL_URL}"
  if ! curl -fsSL --max-time "$timeout" "$url" -o "$tmp_script"; then
    rm -f "$tmp_script"
    return 1
  fi

  if [ ! -s "$tmp_script" ]; then
    rm -f "$tmp_script"
    return 1
  fi

  chmod 700 "$tmp_script"

  # pass both argv and env for compatibility with different panel script versions
  if ACTION="$mode" TOKEN="$token" bash "$tmp_script" "$mode" "$token" </dev/null; then
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
    echo "[ERROR] install requires Agent token"
    echo "Usage: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh install YOUR_TOKEN"
    exit 1
  fi

  if [ -z "${PANEL_URL:-}" ]; then
    echo "[ERROR] PANEL_URL is required"
    echo "Usage: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh install YOUR_TOKEN"
    exit 1
  fi

  echo "======================================"
  echo "  ForwardX Agent Install (GitHub Entry)"
  echo "======================================"
  echo "Panel URL: ${PANEL_URL}"
  echo "Token: ${agent_token:0:8}***"
  echo ""

  echo "[INFO] Fetching install script from panel..."
  if ! run_panel_installer "install" "$agent_token" 60; then
    echo ""
    echo "[ERROR] Failed to fetch installer from panel"
    echo "       Please check panel URL and network connectivity"
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
    echo "[ERROR] PANEL_URL not found"
    echo "Usage: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh upgrade [YOUR_TOKEN]"
    exit 1
  fi

  echo "======================================"
  echo "  ForwardX Agent Upgrade"
  echo "======================================"
  echo "Panel URL: ${PANEL_URL}"
  if [ -n "$agent_token" ]; then
    echo "Token: ${agent_token:0:8}***"
  else
    echo "Token: (use panel script / existing config)"
  fi
  echo ""

  echo "[INFO] Fetching latest install script from panel..."
  if ! run_panel_installer "upgrade" "$agent_token" 60; then
    echo ""
    echo "[ERROR] Upgrade failed: cannot fetch installer from panel"
    exit 1
  fi
}

do_uninstall() {
  require_root
  echo "======================================"
  echo "  ForwardX Agent Uninstall (Local)"
  echo "======================================"

  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload 2>/dev/null || true

  pkill -f "/usr/local/bin/forwardx-fxp" 2>/dev/null || true
  pkill -f "realm -l" 2>/dev/null || true
  pkill -f "socat.*LISTEN" 2>/dev/null || true

  for SVC in /etc/systemd/system/forwardx-socat-*.service /etc/systemd/system/forwardx-realm-*.service /etc/systemd/system/forwardx-gost-*.service; do
    if [ -f "$SVC" ]; then
      SVCNAME="$(basename "$SVC" .service)"
      systemctl stop "$SVCNAME" 2>/dev/null || true
      systemctl disable "$SVCNAME" 2>/dev/null || true
      rm -f "$SVC"
    fi
  done
  systemctl daemon-reload 2>/dev/null || true

  rm -f "$GO_AGENT_BIN" "$FXP_BIN"
  rm -rf "$CONFIG_DIR" "$LOG_DIR" "$STATE_DIR"

  echo "[DONE] Agent has been uninstalled"
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
      echo "[INFO] Unknown action: $ACTION"
    fi
    exit 1
    ;;
esac

exit 0