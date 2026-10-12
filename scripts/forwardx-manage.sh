#!/bin/bash
# ForwardX Manager: host-side management for Agent/local/Docker panel.
set -euo pipefail
MANAGE_DIR="${FORWARDX_MANAGE_DIR:-/etc/forwardx/manage}"
AGENT_CONFIG="${FORWARDX_AGENT_CONFIG:-/etc/forwardx/agent/config.json}"
if [ ! -f "$AGENT_CONFIG" ] && [ -f /etc/forwardx-agent/config.json ]; then AGENT_CONFIG=/etc/forwardx-agent/config.json; fi

die() { echo "[ERROR] $*" >&2; exit 1; }
help() {
  cat <<'HELP'
ForwardX Manager / 管理工具 — fwxm
  fwxm                         Interactive menu / 交互菜单
  fwxm agent|panel info         Paths, address, service / 关键参数
  fwxm agent|panel status       Service status / 服务状态
  fwxm agent|panel logs         Follow logs / 查看日志 (Ctrl+C exits)
  fwxm agent|panel start|stop|restart
  fwxm agent|panel proxy show   Redacted proxy / 查看代理（隐藏密码）
  fwxm agent|panel proxy set [URL]  Save proxy / 设置代理（省略 URL 则安全输入）
  fwxm agent|panel proxy off    Direct / 关闭代理
  fwxm agent|panel install|upgrade|repair|uninstall
  fwxm panel reset-admin       Reset admin password / 重置管理员密码
  fwxm panel address           Panel address / 后台地址
  fwxm agent install --panel-url URL --token TOKEN [--proxy URL]
Agent proxy covers management/downloads, not forwarding or probes.
Panel proxy covers maintenance downloads only, not Node runtime/Docker pulls.
HELP
}

case "${1:-}" in -h|--help|help) help; exit 0 ;; esac
[ "$(id -u)" = 0 ] || die 'Run with sudo/root / 请使用 root 权限。'
[ -r "$MANAGE_DIR/agent-proxy.sh" ] || die 'Management helpers missing; reinstall/upgrade ForwardX first.'
# This is an installer-owned root-only script, never user configuration.
source "$MANAGE_DIR/agent-proxy.sh"

metadata() { local value=''; [ ! -f "$MANAGE_DIR/$1" ] || IFS= read -r value < "$MANAGE_DIR/$1" || true; printf '%s' "$value"; }
json_value() {
  command -v jq >/dev/null 2>&1 || die 'jq is required for Agent configuration.'
  jq -er --arg key "$1" 'if type == "object" then (.[$key] // "") else error("invalid config") end' "$AGENT_CONFIG" 2>/dev/null || die 'Cannot read Agent configuration.'
}
redacted_proxy() {
  local value="$1" scheme authority
  [ -n "$value" ] || { echo 'Direct / 直连'; return; }
  scheme="${value%%://*}"; authority="${value#*://}"
  case "$authority" in *@*) printf '%s://***@%s\n' "$scheme" "${authority##*@}" ;; *) printf '%s\n' "$value" ;; esac
}
confirm() {
  local answer
  [ -r /dev/tty ] && [ -w /dev/tty ] || die 'This action requires an interactive SSH terminal.'
  printf '%s [y/N] ' "$1" > /dev/tty
  IFS= read -r answer < /dev/tty || return 1
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
service_action() {
  local role="$1" action="$2" service="$3"
  if [ "$role" = panel ] && [ "$PANEL_KIND" = docker ]; then
    case "$action" in status) docker inspect --format '{{.Name}} {{.State.Status}}' "$PANEL_CONTAINER" ;; *) docker "$action" "$PANEL_CONTAINER" ;; esac
  elif command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    if [ "$action" = status ]; then systemctl status "$service" --no-pager -l; else systemctl "$action" "$service"; fi
  elif command -v rc-service >/dev/null 2>&1; then rc-service "$service" "$action"
  elif [ -x "/etc/init.d/$service" ]; then "/etc/init.d/$service" "$action"
  else die 'No supported service manager found.'; fi
}
agent_proxy() {
  local action="${1:-show}" value='' tmp
  [ -f "$AGENT_CONFIG" ] || die 'Agent config not found.'
  case "$action" in
    show) redacted_proxy "$(json_value proxyUrl)"; return ;;
    off|remove|delete) value='' ;;
    set|add)
      value="${2:-}"
      if [ -z "$value" ]; then
        printf 'Proxy URL (hidden input): ' > /dev/tty
        IFS= read -rs value < /dev/tty; printf '\n' > /dev/tty
      fi
      [ -n "$value" ] || die 'Empty proxy; use proxy off for direct.'
      value="$(fwx_proxy_normalize "$value")" || exit 1 ;;
    *) die 'Use proxy show|set|off.' ;;
  esac
  tmp="$(mktemp "$(dirname "$AGENT_CONFIG")/.proxy-config.XXXXXX")"
  if jq --arg proxy "$value" 'if type == "object" then .proxyUrl = $proxy else error("invalid config") end' "$AGENT_CONFIG" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$AGENT_CONFIG"; then
    echo '[DONE] Saved / 已保存。Restarting Agent only; managed forwarding runtimes are not intentionally restarted.'
    service_action agent restart forwardx-agent
  else rm -f "$tmp"; die 'Cannot update config; no service was restarted.'; fi
}
panel_proxy() {
  local action="${1:-show}" value='' tmp
  echo '[INFO] Panel maintenance downloads only; not Node runtime or Docker daemon image pulls.'
  case "$action" in
    show) redacted_proxy "$(metadata panel-proxy)"; return ;;
    off|remove|delete) value='' ;;
    set|add)
      value="${2:-}"
      if [ -z "$value" ]; then printf 'Proxy URL (hidden input): ' > /dev/tty; IFS= read -rs value < /dev/tty; printf '\n' > /dev/tty; fi
      [ -n "$value" ] || die 'Empty proxy; use proxy off.'
      value="$(fwx_proxy_normalize "$value")" || exit 1 ;;
    *) die 'Use proxy show|set|off.' ;;
  esac
  tmp="$(mktemp "$MANAGE_DIR/.panel-proxy.XXXXXX")"
  printf '%s\n' "$value" > "$tmp"; chmod 600 "$tmp"; mv -f "$tmp" "$MANAGE_DIR/panel-proxy"
  echo '[DONE] Maintenance proxy saved; panel service was not restarted.'
}
panel_env_value() {
  local key="$1" value
  [ -f "$PANEL_DIR/.env" ] || return 0
  value="$(sed -n "s/^${key}=//p" "$PANEL_DIR/.env" | tail -n 1)"
  value="${value%$'\r'}"; value="${value#\"}"; value="${value%\"}"
  printf '%s' "$value"
}

ROLE="${1:-}"; [ "$#" = 0 ] || shift
if [ -z "$ROLE" ]; then
  if [ -f "$AGENT_CONFIG" ] && [ -f "$MANAGE_DIR/panel-kind" ]; then
    printf '\nForwardX Manager\n  1) Agent\n  2) 面板 / Panel\n  0) 退出 / Exit\n选择 / Select: ' > /dev/tty; IFS= read -r choice < /dev/tty
    case "$choice" in 1) ROLE=agent ;; 2) ROLE=panel ;; *) exit 0 ;; esac
  elif [ -f "$AGENT_CONFIG" ]; then ROLE=agent
  elif [ -f "$MANAGE_DIR/panel-kind" ]; then ROLE=panel
  else help; exit 0; fi
fi
case "$ROLE" in agent|panel) ;; *) help; exit 1 ;; esac
ACTION="${1:-}"; [ "$#" = 0 ] || shift
if [ -z "$ACTION" ]; then
  printf '\nForwardX %s 管理 / Management\n' "$ROLE"
  printf '%s\n' '  1) 关键信息 / Info' '  2) 运行状态 / Status' '  3) 查看日志 / Logs' '  4) 重启面板或 Agent / Restart' '  5) 代理设置 / Proxy' '  6) 升级 / Upgrade' '  7) 重装修复 / Repair' '  8) 卸载 / Uninstall'
  if [ "$ROLE" = panel ]; then echo '  9) 重置管理员密码 / Reset admin password'; fi
  echo '  0) 退出 / Exit'
  printf 'Select / 选择: ' > /dev/tty; IFS= read -r choice < /dev/tty
  case "$choice" in 1) ACTION=info ;; 2) ACTION=status ;; 3) ACTION=logs ;; 4) ACTION=restart ;; 5)
    printf 'Proxy: 1) show  2) set  3) off: ' > /dev/tty; IFS= read -r choice < /dev/tty; ACTION=proxy
    case "$choice" in 1) set -- show ;; 2) set -- set ;; 3) set -- off ;; *) exit 0 ;; esac ;;
    6) ACTION=upgrade ;; 7) ACTION=repair ;; 8) ACTION=uninstall ;; 9) ACTION=reset-admin ;; *) exit 0 ;; esac
fi
PANEL_KIND="$(metadata panel-kind)"; PANEL_DIR="$(metadata panel-dir)"
PANEL_SERVICE="$(metadata panel-service)"; PANEL_SERVICE="${PANEL_SERVICE:-forwardx-panel}"
PANEL_CONTAINER="$(metadata panel-container)"; PANEL_CONTAINER="${PANEL_CONTAINER:-forwardx-panel}"
if [ "$ROLE" = agent ]; then
  case "$ACTION" in
    proxy) agent_proxy "$@" ;;
    info|address|config)
      echo "Agent config: $AGENT_CONFIG"; echo 'Service: forwardx-agent'
      echo "Panel: $(json_value panelUrl)"; printf 'Proxy: '; redacted_proxy "$(json_value proxyUrl)"
      echo 'Logs: /var/log/forwardx-agent/agent-go.log'; echo 'Restart after manual config edits / 手工修改配置后需重启。' ;;
    status|start|stop|restart) service_action agent "$ACTION" forwardx-agent ;;
    logs) tail -n 100 -F /var/log/forwardx-agent/agent-go.log ;;
    install|upgrade|repair|uninstall)
      [ -f "$MANAGE_DIR/install-agent.sh" ] || die 'Cached Agent installer missing; upgrade management tools first.'
      if [ "$ACTION" = uninstall ]; then confirm 'Uninstall Agent and managed forwarding? / 卸载会中断转发，继续？' || exit 0; fi
      if [ "$ACTION" = repair ]; then confirm 'Reinstall/upgrade binaries, preserve config, restart Agent? / 保留配置重装修复？' || exit 0; ACTION=upgrade; fi
      if [ "$ACTION" = install ] && [ ! -f "$AGENT_CONFIG" ]; then
        panel='' token='' args=()
        while [ "$#" -gt 0 ]; do
          case "$1" in --panel-url) [ "$#" -ge 2 ] || die 'Missing panel URL.'; panel="$2"; shift 2 ;; --token) [ "$#" -ge 2 ] || die 'Missing token.'; token="$2"; shift 2 ;; --proxy) [ "$#" -ge 2 ] || die 'Missing proxy URL.'; args+=(--proxy "$2"); shift 2 ;; --no-proxy) args+=(--no-proxy); shift ;; *) die "Unknown option: ${1%%=*}" ;; esac
        done
        [ -n "$panel" ] && [ -n "$token" ] || die 'Use agent install --panel-url URL --token TOKEN [--proxy URL].'
        PANEL_URL="$panel" bash "$MANAGE_DIR/install-agent.sh" install "$token" "${args[@]}"
      else
        [ "$ACTION" != install ] || ACTION=upgrade # preserve existing registration
        bash "$MANAGE_DIR/install-agent.sh" "$ACTION" "$@"
      fi ;;
    *) help; exit 1 ;;
  esac
else
  case "$PANEL_KIND" in local|docker) ;; *) die 'Panel management metadata missing; run the panel installer/upgrade first.' ;; esac
  case "$ACTION" in
    proxy) panel_proxy "$@" ;;
    info|address|config)
      echo "Deployment: $PANEL_KIND"; echo "Directory: $PANEL_DIR"
      if [ "$PANEL_KIND" = docker ]; then echo "Container: $PANEL_CONTAINER"; docker port "$PANEL_CONTAINER" 3000/tcp 2>/dev/null || true
      else echo "Service: $PANEL_SERVICE"; fi
      port="$(panel_env_value PORT)"; echo "Panel: http://SERVER_IP:${port:-9810} (HTTPS/domain: see your reverse proxy)"
      echo "Local: http://127.0.0.1:${port:-9810}"
      printf 'Host IPs (may include private addresses): '; hostname -I 2>/dev/null || true
      echo "Database configuration: $PANEL_DIR/data/database.json (local), /data/database.json (Docker)"
      printf 'Maintenance proxy: '; redacted_proxy "$(metadata panel-proxy)" ;;
    status|start|stop|restart) service_action panel "$ACTION" "$PANEL_SERVICE" ;;
    logs)
      if [ "$PANEL_KIND" = docker ]; then docker logs --tail 100 -f "$PANEL_CONTAINER"
      elif command -v journalctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then journalctl -u "$PANEL_SERVICE" -n 100 -f
      else tail -n 100 -F "$PANEL_DIR/data/panel.log"; fi ;;
    install|upgrade|repair|uninstall|reset-admin|reset-password)
      script="$MANAGE_DIR/install-panel-$PANEL_KIND.sh"
      [ -f "$script" ] || die 'Cached panel installer missing; upgrade management tools first.'
      if [ "$ACTION" = repair ]; then confirm 'Reinstall/upgrade panel, preserve database, restart? / 保留数据重装修复？' || exit 0; ACTION=upgrade; fi
      if [ "$ACTION" = install ] && [ -f "$PANEL_DIR/.env" ]; then ACTION=upgrade; fi
      fwx_proxy_environment "$(metadata panel-proxy)" || exit 1
      export FORWARDX_PANEL_DIR="$PANEL_DIR" FORWARDX_DOCKER_DIR="$PANEL_DIR" FORWARDX_SERVICE_NAME="$PANEL_SERVICE" FORWARDX_CONTAINER_NAME="$PANEL_CONTAINER"
      export COMPOSE_PROJECT_NAME="$(metadata panel-project)"; COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-forwardx}"
      bash "$script" "$ACTION" "$@" ;;
    *) help; exit 1 ;;
  esac
fi
