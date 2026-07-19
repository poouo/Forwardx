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
  if [[ "${#SAVED_CODES[@]}" -eq 0 && -z "${SAVED_ASNS_TEXT}" && -z "$(cn_trim "${SAVED_PORT_POLICIES}")" ]]; then
    echo "配置文件中没有全局白名单或端口白名单。" >&2
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

region_codes_summary() {
  local codes="${1:-}"
  local code label summary=""
  for code in ${codes}; do
    if cn_is_all_china_selector "${code}"; then
      label="全国（中国大陆）"
    else
      label="$(cn_province_name "${code}" 2>/dev/null || true)"
      [[ -n "${label}" ]] || label="${code}"
    fi
    if [[ -z "${summary}" ]]; then
      summary="${label}"
    else
      summary+="、${label}"
    fi
  done
  printf '%s' "${summary}"
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
  local plugin_version=""
  local regions=""
  local region_summary=""
  local asns=""
  local port_policies=""
  local displayed_port_policies=""
  local scope_mode="global"
  local port_spec=""
  local forward_mode="all"
  local forward_ifaces=""
  local rule_count="0"
  local nft_state="" ipset_state="" iptables_state=""

  if command -v jq >/dev/null 2>&1 && [[ -r "${ROOT}/manifest.json" ]]; then
    plugin_version="$(jq -r '.version // .pluginVersion // empty' "${ROOT}/manifest.json" 2>/dev/null || true)"
  fi

  if [[ -r "${CN_CONFIG_FILE}" ]]; then
    configured="true"
    # shellcheck disable=SC1090
    source "${CN_CONFIG_FILE}"
    configured_backend="${CN_FIREWALL_BACKEND:-auto}"
    regions="${CN_CODES:-}"
    asns="${CN_ASNS:-}"
    port_policies="${CN_PORT_POLICIES:-}"
    scope_mode="${CN_POLICY_MODE:-}"
    port_spec="${CN_PORT_SPEC:-}"
    if [[ "${scope_mode}" == "port" ]]; then
      regions="${CN_POLICY_REGIONS:-}"
      asns="${CN_POLICY_ASNS:-}"
    elif [[ -z "${scope_mode}" ]]; then
      scope_mode="global"
      [[ -n "$(cn_trim "${port_policies}")" ]] && scope_mode="advanced"
    fi
    forward_mode="${CN_FORWARD_MODE:-all}"
    forward_ifaces="${CN_FORWARD_IFACES:-}"
  fi
  region_summary="$(region_codes_summary "${regions}")"
  if [[ -n "${asns}" ]]; then
    region_summary="${region_summary}${region_summary:+、}${asns// /、}"
  fi
  [[ -n "${region_summary}" ]] || region_summary="未配置"
  if [[ "${scope_mode}" == "port" ]]; then
    region_summary="${port_spec}：${region_summary}"
  elif [[ "${scope_mode}" == "advanced" && -n "${port_policies}" ]]; then
    region_summary="${region_summary}；含端口策略"
    displayed_port_policies="${port_policies}"
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
  printf '"id":"whitelist",'
  printf '"name":"中国区域白名单",'
  printf '"pluginVersion":"%s",' "$(json_escape "${plugin_version}")"
  printf '"privileged":%s,' "${privileged}"
  printf '"configured":%s,' "${configured}"
  printf '"applied":%s,' "${applied}"
  printf '"serviceActive":%s,' "${service_active}"
  printf '"backend":"%s",' "$(json_escape "${actual_backend}")"
  printf '"configuredBackend":"%s",' "$(json_escape "${configured_backend}")"
  printf '"scopeMode":"%s",' "$(json_escape "${scope_mode}")"
  printf '"regions":'
  json_words_array "${regions}"
  printf ',"regionSummary":"%s",' "$(json_escape "${region_summary}")"
  printf '"asns":'
  json_words_array "${asns}"
  printf ',"portSpec":"%s",' "$(json_escape "${port_spec}")"
  printf '"portPolicies":"%s",' "$(json_escape "${displayed_port_policies}")"
  printf '"forwardMode":"%s",' "$(json_escape "${forward_mode}")"
  printf '"forwardInterfaces":'
  json_words_array "${forward_ifaces}"
  printf ',"ruleCount":%s,' "${rule_count:-0}"
  printf '"configPath":"%s",' "$(json_escape "${CN_CONFIG_FILE}")"
  printf '"checkedAt":"%s"' "$(date -Iseconds 2>/dev/null || date)"
  printf '}\n'
}

resource_list_json() {
  printf '{"items":['
  if [[ -r "${CN_CONFIG_FILE}" ]]; then
    status_rules_json
  fi
  printf ']}\n'
}

write_resource_config() {
  local payload="${1:-}"
  cn_require_root
  command -v jq >/dev/null 2>&1 || {
    echo "动态编辑白名单配置需要 jq，请重新执行 Agent 安装或升级脚本补齐依赖。" >&2
    exit 1
  }
  [[ -n "${payload}" ]] || {
    echo "缺少白名单配置。" >&2
    exit 1
  }
  if ! printf '%s' "${payload}" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo "白名单配置不是有效的 JSON 对象。" >&2
    return 1
  fi

  local jq_words_filter
  jq_words_filter='def words:
    if . == null then []
    elif type == "array" then .
    else tostring | gsub("[,，、;；\\s]+"; " ") | split(" ")
    end
    | map(tostring | gsub("^\\s+|\\s+$"; ""))
    | map(select(length > 0));
    .[$key] | words | .[]'

  local -a provinces=() selected_regions=()
  local -a selected_asns=() forward_ifaces=() effective_regions=() effective_asns=()
  local item normalized has_cn="false"
  while IFS= read -r item; do
    item="${item%$'\r'}"
    [[ -n "${item}" ]] || continue
    if [[ "${item}" == "CN" ]]; then
      has_cn="true"
    elif [[ "${item}" =~ ^[0-9]{6}$ ]] && [[ ! " ${provinces[*]:-} " =~ " ${item} " ]]; then
      provinces+=("${item}")
    fi
  done < <(printf '%s' "${payload}" | jq -r --arg key regions "${jq_words_filter}")
  if ((${#provinces[@]} > 0)); then
    selected_regions=("${provinces[@]}")
  elif [[ "${has_cn}" == "true" ]]; then
    selected_regions=("CN")
  fi

  while IFS= read -r item; do
    item="${item%$'\r'}"
    [[ -n "${item}" ]] || continue
    if normalized="$(cn_normalize_asn "${item}" 2>/dev/null)"; then
      normalized="AS${normalized}"
      if [[ ! " ${selected_asns[*]:-} " =~ " ${normalized} " ]]; then
        selected_asns+=("${normalized}")
        ((${#selected_asns[@]} >= 40)) && break
      fi
    fi
  done < <(printf '%s' "${payload}" | jq -r --arg key asns "${jq_words_filter}")

  local forward_mode backend raw_port_policies port_spec scope_mode port_policies=""
  forward_mode="$(printf '%s' "${payload}" | jq -r '(.forwardMode // "all") | tostring')"
  case "${forward_mode}" in all|none|selected) ;; *) forward_mode="all" ;; esac
  if [[ "${forward_mode}" == "selected" ]]; then
    while IFS= read -r item; do
      item="${item%$'\r'}"
      if [[ "${item}" =~ ^[A-Za-z0-9_.:-]{1,64}\+?$ ]]; then
        forward_ifaces+=("${item}")
        ((${#forward_ifaces[@]} >= 32)) && break
      fi
    done < <(printf '%s' "${payload}" | jq -r --arg key forwardInterfaces "${jq_words_filter}")
  fi

  backend="$(printf '%s' "${payload}" | jq -r '(.configuredBackend // .backend // "auto") | tostring')"
  case "${backend}" in auto|nft|iptables) ;; *) backend="auto" ;; esac
  raw_port_policies="$(printf '%s' "${payload}" | jq -r '(.portPolicies // "") | tostring')"
  raw_port_policies="$(cn_trim "${raw_port_policies//$'\r'/}")"
  raw_port_policies="${raw_port_policies:0:5000}"
  port_spec="$(cn_trim "$(printf '%s' "${payload}" | jq -r '(.portSpec // "") | tostring')")"
  scope_mode="$(printf '%s' "${payload}" | jq -r '(.scopeMode // "") | tostring')"
  if [[ "${scope_mode}" != "global" && "${scope_mode}" != "port" && "${scope_mode}" != "advanced" ]]; then
    if [[ -n "${port_spec}" || ( -n "${raw_port_policies}" && "${raw_port_policies}" != *=* ) ]]; then
      scope_mode="port"
    elif [[ -n "${raw_port_policies}" ]]; then
      scope_mode="advanced"
    else
      scope_mode="global"
    fi
  fi

  if [[ "${scope_mode}" == "port" ]]; then
    if [[ "${#selected_regions[@]}" -eq 0 && "${#selected_asns[@]}" -eq 0 ]]; then
      echo "请至少选择一个白名单区域或填写一个 ASN。" >&2
      return 1
    fi
    [[ -n "${port_spec}" ]] || port_spec="${raw_port_policies}"
    if ! cn_validate_port_spec "${port_spec}"; then
      echo "端口格式错误，请填写单端口（如 22）或端口范围（如 10000-20000）。" >&2
      return 1
    fi
    local selectors=""
    for item in "${selected_regions[@]}" "${selected_asns[@]}"; do
      selectors="${selectors}${selectors:+,}${item}"
    done
    port_policies="${port_spec}=${selectors}"
  elif [[ "${scope_mode}" == "advanced" ]]; then
    port_spec=""
    port_policies="${raw_port_policies}"
    if [[ -z "${port_policies}" ]]; then
      echo "请填写端口优先白名单策略。" >&2
      return 1
    fi
    effective_regions=("${selected_regions[@]}")
    effective_asns=("${selected_asns[@]}")
  else
    if [[ "${#selected_regions[@]}" -eq 0 && "${#selected_asns[@]}" -eq 0 ]]; then
      echo "请至少选择一个全局白名单区域或填写一个 ASN。" >&2
      return 1
    fi
    port_spec=""
    effective_regions=("${selected_regions[@]}")
    effective_asns=("${selected_asns[@]}")
  fi

  local config_dir temporary_path
  config_dir="$(dirname "${CN_CONFIG_FILE}")"
  mkdir -p "${config_dir}"
  temporary_path="$(mktemp "${config_dir}/.china-region-whitelist.XXXXXX")"
  if {
    echo "# Generated by ForwardX plugin resource manager."
    printf 'CN_CODES=%q\n' "${effective_regions[*]:-}"
    printf 'CN_ASNS=%q\n' "${effective_asns[*]:-}"
    printf 'CN_PORT_POLICIES=%q\n' "${port_policies}"
    printf 'CN_POLICY_MODE=%q\n' "${scope_mode}"
    printf 'CN_POLICY_REGIONS=%q\n' "${selected_regions[*]:-}"
    printf 'CN_POLICY_ASNS=%q\n' "${selected_asns[*]:-}"
    printf 'CN_PORT_SPEC=%q\n' "${port_spec}"
    printf 'CN_FORWARD_MODE=%q\n' "${forward_mode}"
    printf 'CN_FORWARD_IFACES=%q\n' "${forward_ifaces[*]:-}"
    printf 'CN_FIREWALL_BACKEND=%q\n' "${backend}"
    printf 'CN_ROOT=%q\n' "${ROOT}"
    printf 'CN_RUNTIME_DIR=%q\n' "/var/lib/china-region-whitelist"
    printf 'CN_ASN_CACHE_DIR=%q\n' "/var/lib/china-region-whitelist/asn"
  } > "${temporary_path}"; then
    chmod 0600 "${temporary_path}"
    mv -f "${temporary_path}" "${CN_CONFIG_FILE}"
  else
    rm -f "${temporary_path}"
    return 1
  fi
}

save_resource() {
  local backup_file="" status=0
  if [[ -r "${CN_CONFIG_FILE}" ]]; then
    backup_file="$(mktemp "$(dirname "${CN_CONFIG_FILE}")/.china-region-whitelist.backup.XXXXXX")"
    cp -p "${CN_CONFIG_FILE}" "${backup_file}"
  fi
  if ! write_resource_config "${1:-}"; then
    rm -f "${backup_file}"
    return 1
  fi
  if apply_config >/dev/null; then
    rm -f "${backup_file}"
  else
    status=$?
    if [[ -n "${backup_file}" ]]; then
      mv -f "${backup_file}" "${CN_CONFIG_FILE}"
      apply_config >/dev/null 2>&1 || true
    else
      rm -f "${CN_CONFIG_FILE}"
      cn_render_best_effort_clear_commands | cn_run_rendered_commands >/dev/null 2>&1 || true
    fi
    return "${status}"
  fi
  status_rules_json
}

delete_resource() {
  clear_rules >/dev/null
  rm -f "${CN_CONFIG_FILE}"
  status_rules_json
}

clear_rules() {
  cn_require_root
  cn_disable_systemd_service
  cn_render_best_effort_clear_commands | cn_run_rendered_commands
  echo "已清除 china-region-whitelist 管理的规则。"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-status}" in
    apply-config) apply_config ;;
    dry-run-config) dry_run_config ;;
    status) status_rules ;;
    status-json) status_rules_json ;;
    resource-list-json) resource_list_json ;;
    resource-save) save_resource "${2:-}" ;;
    resource-delete) delete_resource ;;
    clear) clear_rules ;;
    update-asn) bash "${ROOT}/install.sh" update-asn ;;
    *)
      echo "Usage: $0 {apply-config|dry-run-config|status|status-json|resource-list-json|resource-save|resource-delete|clear|update-asn}" >&2
      exit 2
      ;;
  esac
fi
