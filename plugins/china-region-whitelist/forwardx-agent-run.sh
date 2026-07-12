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
  local forward_mode="all"
  local forward_ifaces=""
  local rule_count="0"
  local nft_state="" ipset_state="" iptables_state=""

  if command -v python3 >/dev/null 2>&1 && [[ -r "${ROOT}/manifest.json" ]]; then
    plugin_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8")).get("version", ""))' "${ROOT}/manifest.json" 2>/dev/null || true)"
  fi

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
  region_summary="$(region_codes_summary "${regions}")"

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
  printf '"regions":'
  json_words_array "${regions}"
  printf ',"regionSummary":"%s",' "$(json_escape "${region_summary}")"
  printf '"asns":'
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
  command -v python3 >/dev/null 2>&1 || {
    echo "动态编辑白名单配置需要 python3。" >&2
    exit 1
  }
  [[ -n "${payload}" ]] || {
    echo "缺少白名单配置。" >&2
    exit 1
  }
  python3 - "${payload}" "${CN_CONFIG_FILE}" "${ROOT}" <<'PY'
import json
import os
import re
import shlex
import sys
import tempfile

payload = json.loads(sys.argv[1])
config_path = sys.argv[2]
root = sys.argv[3]

def words(value):
    if isinstance(value, list):
        values = value
    else:
        values = re.split(r"[\s,，、;；]+", str(value or ""))
    return [str(item).strip() for item in values if str(item).strip()]

regions = []
for code in words(payload.get("regions")):
    if code == "CN" or re.fullmatch(r"\d{6}", code):
        if code not in regions:
            regions.append(code)
provinces = [code for code in regions if code != "CN"]
regions = provinces or (["CN"] if "CN" in regions or not regions else regions)

asns = []
for value in words(payload.get("asns")):
    number = re.sub(r"^AS", "", value, flags=re.I)
    if re.fullmatch(r"\d{1,10}", number):
        normalized = f"AS{number}"
        if normalized not in asns:
            asns.append(normalized)
asns = asns[:40]

forward_mode = str(payload.get("forwardMode") or "all")
if forward_mode not in {"all", "none", "selected"}:
    forward_mode = "all"
forward_ifaces = []
for interface in words(payload.get("forwardInterfaces")):
    if re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}\+?", interface):
        forward_ifaces.append(interface)
forward_ifaces = forward_ifaces[:32] if forward_mode == "selected" else []

backend = str(payload.get("configuredBackend") or payload.get("backend") or "auto")
if backend not in {"auto", "nft", "iptables"}:
    backend = "auto"
port_policies = str(payload.get("portPolicies") or "").replace("\r", "").strip()[:5000]

values = {
    "CN_CODES": " ".join(regions),
    "CN_ASNS": " ".join(asns),
    "CN_PORT_POLICIES": port_policies,
    "CN_FORWARD_MODE": forward_mode,
    "CN_FORWARD_IFACES": " ".join(forward_ifaces),
    "CN_FIREWALL_BACKEND": backend,
    "CN_ROOT": root,
    "CN_RUNTIME_DIR": "/var/lib/china-region-whitelist",
    "CN_ASN_CACHE_DIR": "/var/lib/china-region-whitelist/asn",
}

directory = os.path.dirname(config_path) or "."
os.makedirs(directory, exist_ok=True)
fd, temporary_path = tempfile.mkstemp(prefix=".china-region-whitelist.", dir=directory, text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("# Generated by ForwardX plugin resource manager.\n")
        for key, value in values.items():
            handle.write(f"{key}={shlex.quote(value)}\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary_path, 0o600)
    os.replace(temporary_path, config_path)
finally:
    if os.path.exists(temporary_path):
        os.unlink(temporary_path)
PY
}

save_resource() {
  write_resource_config "${1:-}"
  apply_config >/dev/null
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
