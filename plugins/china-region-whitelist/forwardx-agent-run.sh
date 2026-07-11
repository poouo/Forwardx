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

json_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "${value}"
}

json_words_array() {
  local values="${1:-}"
  local value first="true"
  printf '['
  for value in ${values}; do
    if [[ "${first}" != "true" ]]; then
      printf ','
    fi
    first="false"
    printf '"%s"' "$(json_escape "${value}")"
  done
  printf ']'
}

status_rules_json() {
  local privileged="false"
  if [[ "${EUID}" -eq 0 ]]; then
    privileged="true"
  fi
  local configured="false"
  local applied="false"
  local service_active="false"
  local actual_backend="none"
  local configured_backend="${CN_FIREWALL_BACKEND:-auto}"
  local regions=""
  local asns=""
  local port_policies=""
  local forward_mode="all"
  local forward_ifaces=""
  local rule_count="0"
  local nft_state="" ipset_state="" iptables_state=""

  if [[ -r "${CN_CONFIG_FILE}" ]]; then
    configured="true"
    # shellcheck disable=SC1090
    source "${CN_CONFIG_FILE}"
    configured_backend="${CN_FIREWALL_BACKEND:-auto}"
    regions="${CN_CODES:-}"
    asns="${CN_ASNS:-}"
    port_policies="${CN_PORT_POLICIES:-}"
    forward_mode="${CN_FORWARD_MODE:-all}"
    forward_ifaces="${CN_FORWARD_IFACES:-}"
  fi

  if command -v nft >/dev/null 2>&1; then
    nft_state="$(nft list table inet "${CN_NFT_TABLE}" 2>/dev/null || true)"
    if [[ -n "${nft_state}" ]]; then
      applied="true"
      actual_backend="nft"
      rule_count="$(
        (printf '%s\n' "${nft_state}" | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?' || true) |
          wc -l | tr -d '[:space:]'
      )"
    fi
  fi
  if [[ "${applied}" != "true" ]] && command -v ipset >/dev/null 2>&1; then
    ipset_state="$(ipset list "${CN_SET_NAME}" 2>/dev/null || true)"
    if [[ -n "${ipset_state}" ]]; then
      applied="true"
      actual_backend="iptables"
      rule_count="$(printf '%s\n' "${ipset_state}" | awk -F: '/Number of entries/ {gsub(/[[:space:]]/, "", $2); print $2 + 0; found=1} END {if (!found) print 0}')"
    fi
  fi
  if command -v iptables >/dev/null 2>&1; then
    iptables_state="$(iptables -S "${CN_CHAIN_NAME}" 2>/dev/null || true)"
    if [[ -n "${iptables_state}" && "${applied}" != "true" ]]; then
      applied="true"
      actual_backend="iptables"
      rule_count="$(printf '%s\n' "${iptables_state}" | awk '/^-A / {count++} END {print count + 0}')"
    fi
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "${CN_SERVICE_NAME}" 2>/dev/null; then
    service_active="true"
  elif command -v rc-service >/dev/null 2>&1 && rc-service "${CN_SERVICE_NAME%.service}" status >/dev/null 2>&1; then
    service_active="true"
  fi

  printf '{'
  printf '"privileged":%s,' "${privileged}"
  printf '"configured":%s,' "${configured}"
  printf '"applied":%s,' "${applied}"
  printf '"serviceActive":%s,' "${service_active}"
  printf '"backend":"%s",' "$(json_escape "${actual_backend}")"
  printf '"configuredBackend":"%s",' "$(json_escape "${configured_backend}")"
  printf '"regions":'
  json_words_array "${regions}"
  printf ',"asns":'
  json_words_array "${asns}"
  printf ',"portPolicies":"%s",' "$(json_escape "${port_policies}")"
  printf '"forwardMode":"%s",' "$(json_escape "${forward_mode}")"
  printf '"forwardInterfaces":'
  json_words_array "${forward_ifaces}"
  printf ',"ruleCount":%s,' "${rule_count:-0}"
  printf '"configPath":"%s",' "$(json_escape "${CN_CONFIG_FILE}")"
  printf '"checkedAt":"%s"' "$(date -Iseconds 2>/dev/null || date)"
  printf '}\n'
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
  status-json) status_rules_json ;;
  clear) clear_rules ;;
  update-asn) bash "${ROOT}/install.sh" update-asn ;;
  *)
    echo "Usage: $0 {apply-config|dry-run-config|status|status-json|clear|update-asn}" >&2
    exit 2
    ;;
esac
