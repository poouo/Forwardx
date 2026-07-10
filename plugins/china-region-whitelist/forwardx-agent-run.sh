#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CN_ROOT="${CN_ROOT:-${ROOT}}"
export CN_CONFIG_FILE="${CN_CONFIG_FILE:-/etc/china-region-whitelist.conf}"

source "${ROOT}/tools/firewall_lib.sh"

load_config_values() {
  local item
  SAVED_CODES=()
  while IFS= read -r item; do
    [[ -n "${item}" ]] && SAVED_CODES+=("${item}")
  done < <(cn_load_config_codes)

  SAVED_ASNS=()
  while IFS= read -r item; do
    [[ -n "${item}" ]] && SAVED_ASNS+=("${item}")
  done < <(cn_load_config_asns)

  SAVED_PORT_POLICIES="$(cn_load_config_port_policies)"
  SAVED_FORWARD_MODE="$(cn_load_config_forward_mode)"
  SAVED_FORWARD_IFACES=()
  while IFS= read -r item; do
    [[ -n "${item}" ]] && SAVED_FORWARD_IFACES+=("${item}")
  done < <(cn_load_config_forward_ifaces)

  SAVED_ASNS_TEXT="${SAVED_ASNS[*]:-}"
  SAVED_FORWARD_IFACES_TEXT="${SAVED_FORWARD_IFACES[*]:-}"
}

render_config_commands() {
  cn_source_config
  cn_use_runtime_data_if_available
  load_config_values
  if [[ "${#SAVED_CODES[@]}" -eq 0 ]]; then
    echo "配置文件中没有全局白名单代码。" >&2
    exit 1
  fi
  cn_render_apply_commands "" "${SAVED_FORWARD_MODE}" "${SAVED_FORWARD_IFACES_TEXT}" "${SAVED_ASNS_TEXT}" "${SAVED_PORT_POLICIES}" "${SAVED_CODES[@]}"
}

apply_config() {
  cn_require_root
  cn_source_config
  cn_require_commands
  render_config_commands | cn_run_rendered_commands
  cn_install_systemd_service
  echo "已按 ForwardX 插件配置应用白名单规则。"
}

dry_run_config() {
  render_config_commands
}

status_rules() {
  cn_require_root
  echo "== nft table: ${CN_NFT_TABLE} =="
  if command -v nft >/dev/null 2>&1; then
    nft list table inet "${CN_NFT_TABLE}" 2>/dev/null || true
  else
    echo "nft 未安装"
  fi
  echo
  echo "== ipset: ${CN_SET_NAME} =="
  if command -v ipset >/dev/null 2>&1; then
    ipset list "${CN_SET_NAME}" 2>/dev/null || true
  else
    echo "ipset 未安装"
  fi
  echo
  echo "== iptables chain: ${CN_CHAIN_NAME} =="
  if command -v iptables >/dev/null 2>&1; then
    iptables -S "${CN_CHAIN_NAME}" 2>/dev/null || true
  else
    echo "iptables 未安装"
  fi
  cn_show_persistence_status
}

clear_rules() {
  cn_require_root
  cn_disable_systemd_service
  cn_render_best_effort_clear_commands | cn_run_rendered_commands
  echo "已清除 china-region-whitelist 管理的规则。"
}

case "${1:-status}" in
  apply-config) apply_config ;;
  dry-run-config) dry_run_config ;;
  status) status_rules ;;
  clear) clear_rules ;;
  update-asn) bash "${ROOT}/install.sh" update-asn ;;
  *)
    echo "Usage: $0 {apply-config|dry-run-config|status|clear|update-asn}" >&2
    exit 2
    ;;
esac
