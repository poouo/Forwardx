#!/bin/bash
# ForwardX Agent 绠＄悊鑴氭湰锛圙itHub 鍏ュ彛锛?
#
# 璇ヨ剼鏈槸 ForwardX Agent 鐨?GitHub 瀹樻柟鍏ュ彛銆?
# 瀹夎/鍗囩骇鏃朵粠闈㈡澘鎷夊彇涓庣増鏈厤濂楃殑瀹夎鑴氭湰锛堝惈 Token 宓屽叆銆佹敞鍐岄€昏緫绛夛級銆?
# 鍗歌浇鏃舵湰鍦版墽琛岋紝涓嶄緷璧栭潰鏉裤€?
#
# 鐢ㄦ硶锛?
#   # 瀹夎
#   curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
#     PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_TOKEN
#
#   # 鍗歌浇锛堝畬鍏ㄦ湰鍦帮紝涓嶄緷璧栭潰鏉匡級
#   curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \
#     bash -s -- uninstall
#
#   # 鍗囩骇
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
  ForwardX Agent 绠＄悊锛圙itHub 鍏ュ彛锛?
======================================

鐢ㄦ硶锛?
  瀹夎 Agent锛?
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \\
      PANEL_URL="http://your-panel:3000" bash -s -- install YOUR_TOKEN

  鍗歌浇 Agent锛?
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \\
      bash -s -- uninstall

  鍗囩骇 Agent锛?
    curl -fsSL https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh | \\
      PANEL_URL="http://your-panel:3000" bash -s -- upgrade

鍙傛暟锛?
  install   <TOKEN>  瀹夎 Agent锛堥渶瑕佺幆澧冨彉閲?PANEL_URL锛?
  upgrade   [TOKEN]  鍗囩骇 Agent锛涢粯璁ゅ鐢ㄧ幇鏈夐厤缃?
  uninstall          瀹屽叏鍗歌浇 Agent锛堜笉渚濊禆闈㈡澘锛?

EOF
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[閿欒] 璇蜂娇鐢?root 鏉冮檺杩愯姝よ剼鏈?
    exit 1
  fi
}

read_existing_config() {
  if [ -f "$CONFIG_DIR/config.json" ]; then
    EXISTING_PANEL_URL=$(jq -r ".panelUrl // empty" "$CONFIG_DIR/config.json" 2>/dev/null || true)
    EXISTING_TOKEN=$(jq -r ".token // empty" "$CONFIG_DIR/config.json" 2>/dev/null || true)
  fi
}

# Fetch installer from panel and execute it with explicit action/token.
run_panel_installer() {
  local mode="$1"
  local token="$2"
  local timeout="${3:-60}"
  local tmp_script
  tmp_script=$(mktemp /tmp/forwardx-install.XXXXXX)

  PANEL_URL="${PANEL_URL%/}"
  local url="${PANEL_URL}/api/agent/install.sh?token=${token}"

  echo "[淇℃伅] 浠庨潰鏉胯幏鍙栧畨瑁呰剼鏈? $PANEL_URL"
  if ! curl -fsSL --max-time "$timeout" "$url" -o "$tmp_script"; then
    rm -f "$tmp_script"
    return 1
  fi
  if [ ! -s "$tmp_script" ]; then
    rm -f "$tmp_script"
    return 1
  fi
  chmod 700 "$tmp_script"
  # Forward install/upgrade action and token to avoid interactive menu.
  if bash "$tmp_script" "$mode" "$token" </dev/null; then
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
    echo "[閿欒] 瀹夎妯″紡闇€瑕佹彁渚?Agent Token"
    echo "鐢ㄦ硶: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh install YOUR_TOKEN"
    exit 1
  fi

  if [ -z "${PANEL_URL:-}" ]; then
    echo "[閿欒] 缂哄皯 PANEL_URL 鐜鍙橀噺"
    echo "鐢ㄦ硶: PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh install YOUR_TOKEN"
    exit 1
  fi

  echo "======================================"
  echo "  ForwardX Agent 瀹夎锛圙itHub 鍏ュ彛锛?
  echo "======================================"
  echo "闈㈡澘鍦板潃: $PANEL_URL"
  echo "Token: ${AGENT_TOKEN:0:8}***"
  echo ""

  echo "[淇℃伅] 姝ｅ湪浠庨潰鏉胯幏鍙栧畨瑁呰剼鏈?.."
  if ! run_panel_installer "install" "$AGENT_TOKEN" 60; then
    echo ""
    echo "[閿欒] 鏃犳硶浠庨潰鏉胯幏鍙栧畨瑁呰剼鏈?
    echo "       璇锋鏌ラ潰鏉垮湴鍧€鏄惁姝ｇ‘銆佺綉缁滄槸鍚﹂€氱晠"
    echo "       涔熷彲浠ョ洿鎺ヤ粠闈㈡澘瀹夎锛?
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
    echo "[閿欒] 鏈壘鍒伴潰鏉垮湴鍧€銆傝璁剧疆 PANEL_URL锛?
    echo "       PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh upgrade"
    exit 1
  fi

  if [ -z "$AGENT_TOKEN" ]; then
    echo "[閿欒] 鏈壘鍒?Agent Token銆傝浼犲叆 Token 鎴栭噸鏂板畨瑁咃細"
    echo "       PANEL_URL=\"http://your-panel:3000\" bash install-agent.sh upgrade YOUR_TOKEN"
    exit 1
  fi

  PANEL_URL="${PANEL_URL%/}"

  echo "======================================"
  echo "  ForwardX Agent 鍗囩骇绋嬪簭"
  echo "======================================"
  echo "闈㈡澘鍦板潃: $PANEL_URL"
  echo "Token: ${AGENT_TOKEN:0:8}***"
  echo ""

  echo "[淇℃伅] 姝ｅ湪浠庨潰鏉胯幏鍙栨渶鏂板畨瑁呰剼鏈?.."
  if ! run_panel_installer "upgrade" "$AGENT_TOKEN" 60; then
    echo ""
    echo "[閿欒] 鍗囩骇澶辫触锛氭棤娉曚粠闈㈡澘鑾峰彇瀹夎鑴氭湰"
    echo "       璇锋鏌ラ潰鏉垮湴鍧€鍜岀綉缁滆繛鎺?
    exit 1
  fi
}

do_uninstall() {
  require_root
  echo "======================================"
  echo "  ForwardX Agent 鍗歌浇绋嬪簭锛堟湰鍦帮級"
  echo "======================================"
  echo ""

  echo "[姝ラ 1/5] 鍋滄 Agent 鏈嶅姟..."
  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME"
    echo "[淇℃伅] 鏈嶅姟宸插仠姝?
  else
    echo "[淇℃伅] 鏈嶅姟鏈湪杩愯"
  fi

  echo "[姝ラ 2/5] 绂佺敤骞跺垹闄?systemd 鏈嶅姟..."
  if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
    echo "[淇℃伅] 鏈嶅姟鏂囦欢宸插垹闄?
  fi

  echo "[姝ラ 3/5] 娓呯悊浜岃繘鍒跺拰閰嶇疆..."
  rm -f "$GO_AGENT_BIN" "$FXP_BIN"
  rm -rf "$CONFIG_DIR"
  echo "[淇℃伅] Go Agent 鏂囦欢宸插垹闄?

  echo "[姝ラ 4/5] 娓呯悊杞彂杩涚▼鍜?iptables 瑙勫垯..."
  pkill -f "/usr/local/bin/forwardx-fxp" 2>/dev/null || true
  pkill -f "realm -l" 2>/dev/null || true
  pkill -f "socat.*LISTEN" 2>/dev/null || true
  for SVC in /etc/systemd/system/forwardx-socat-*.service /etc/systemd/system/forwardx-realm-*.service /etc/systemd/system/forwardx-gost-*.service; do
    if [ -f "$SVC" ]; then
      SVCNAME=$(basename "$SVC" .service)
      systemctl stop "$SVCNAME" 2>/dev/null || true
      systemctl disable "$SVCNAME" 2>/dev/null || true
      rm -f "$SVC"
      echo "[淇℃伅] 宸插垹闄ゆ湇鍔? $SVCNAME"
    fi
  done
  systemctl daemon-reload 2>/dev/null || true

  # 娓呯悊 mangle 琛ㄤ腑鐨?FWX 璁℃暟閾?
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
    echo "[淇℃伅] 宸叉竻鐞?mangle 璁℃暟閾? $CH"
  done

  # 娓呯悊 FWX_LIMIT 閾?
  for CH in $(iptables -L 2>/dev/null | awk '/^Chain FWX_LIMIT_/ {print $2}'); do
    iptables -D INPUT -p tcp -j "$CH" 2>/dev/null || true
    iptables -D FORWARD -p tcp -j "$CH" 2>/dev/null || true
    iptables -F "$CH" 2>/dev/null || true
    iptables -X "$CH" 2>/dev/null || true
    echo "[淇℃伅] 宸叉竻鐞嗚繛鎺ラ檺鍒堕摼: $CH"
  done

  # 娓呯悊 nat 琛ㄤ腑鐨?DNAT/MASQUERADE 瑙勫垯
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
  echo "[淇℃伅] iptables 瑙勫垯宸叉竻鐞?

  echo "[姝ラ 5/5] 娓呯悊鏃ュ織鍜岀姸鎬佹枃浠?.."
  rm -rf "$LOG_DIR" 2>/dev/null || true
  rm -rf "$STATE_DIR" 2>/dev/null || true
  echo "[淇℃伅] 鏃ュ織鍜岀姸鎬佹枃浠跺凡鍒犻櫎"

  echo ""
  echo "======================================"
  echo "  ForwardX Agent 鍗歌浇瀹屾垚!"
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
      echo "[鎻愮ず] 鏈煡鎿嶄綔: $ACTION"
      echo ""
    fi
    exit 1
    ;;
esac

exit 0
