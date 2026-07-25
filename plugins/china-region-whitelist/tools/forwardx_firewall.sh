#!/usr/bin/env bash
set -euo pipefail

# ForwardX-owned firewall and data adapter for the China region whitelist plugin.
# The runtime deliberately uses the plugin's local data and never executes a
# downloaded third-party shell script.

CN_ROOT="${CN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
CN_CONFIG_FILE="${CN_CONFIG_FILE:-/etc/china-region-whitelist.conf}"
CN_RUNTIME_DIR="${CN_RUNTIME_DIR:-/var/lib/china-region-whitelist}"
CN_DATA_DIR="${CN_DATA_DIR:-${CN_ROOT}/data}"
CN_ASN_CACHE_DIR="${CN_ASN_CACHE_DIR:-${CN_RUNTIME_DIR}/asn}"
CN_FIREWALL_BACKEND="${CN_FIREWALL_BACKEND:-auto}"
CN_NFT_TABLE="china_region_whitelist"
CN_NFT_SET_NAME="allowed_v4"
CN_NFT_CHAIN_NAME="forwardx_input"
CN_NFT_FORWARD_CHAIN_NAME="forwardx_forward"
CN_IPSET_PREFIX="fx_cn_allow"
CN_CHAIN_NAME="FX_CN_WHITELIST"
CN_SERVICE_NAME="china-region-whitelist.service"
CN_ASN_BASE_URL="${CN_ASN_BASE_URL:-https://raw.githubusercontent.com/ipverse/as-ip-blocks/master/as}"
CN_GITHUB_PROXY="${CN_GITHUB_PROXY:-direct}"

cn_trim() {
  local value="${1:-}"
  value="${value#${value%%[!$' \t\r\n']*}}"
  value="${value%${value##*[!$' \t\r\n']}}"
  printf '%s' "${value}"
}

cn_is_all_china_selector() {
  case "$(cn_trim "${1:-}")" in
    CN|cn|中国|全国|中国大陆|大陆|all|ALL) return 0 ;;
    *) return 1 ;;
  esac
}

cn_normalize_asn() {
  local value="$(cn_trim "${1:-}")"
  value="${value#AS}"
  value="${value#as}"
  [[ "${value}" =~ ^[0-9]{1,10}$ ]] || return 1
  ((10#${value} > 0)) || return 1
  printf '%s' "${value}"
}

cn_normalize_region_name() {
  local value="$(cn_trim "${1:-}")"
  local suffix
  for suffix in 特别行政区 维吾尔自治区 壮族自治区 回族自治区 自治区 省 市; do
    if [[ "${value}" == *"${suffix}" ]]; then
      value="${value:0:${#value}-${#suffix}}"
      break
    fi
  done
  printf '%s' "${value}"
}

cn_use_runtime_data_if_available() {
  local candidate="${CN_RUNTIME_DIR}/data"
  if [[ -s "${candidate}/regions.tsv" && -s "${candidate}/country/CN.txt" ]]; then
    CN_DATA_DIR="${candidate}"
  else
    CN_DATA_DIR="${CN_ROOT}/data"
  fi
  export CN_DATA_DIR
}

cn_require_region_index() {
  [[ -s "${CN_DATA_DIR}/regions.tsv" ]] || {
    echo "缺少区域索引：${CN_DATA_DIR}/regions.tsv" >&2
    return 1
  }
}

cn_list_provinces() {
  cn_require_region_index
  awk -F '\t' 'NF >= 5 && $1 == "province" { print $2 "\t" $4 "\t" $5 }' "${CN_DATA_DIR}/regions.tsv"
}

cn_show_provinces() {
  while IFS=$'\t' read -r index code name; do
    printf '%s. %s (%s)\n' "${index}" "${name}" "${code}"
  done < <(cn_list_provinces)
}

cn_province_name() {
  local code="$(cn_trim "${1:-}")"
  cn_list_provinces | awk -F '\t' -v wanted="${code}" '$2 == wanted { print $3; exit }'
}

cn_resolve_province() {
  local selector="$(cn_trim "${1:-}")"
  local normalized="$(cn_normalize_region_name "${selector}")"
  local index code name
  if [[ "${selector}" =~ ^[0-9]{6}$ ]]; then
    code="$(cn_list_provinces | awk -F '\t' -v wanted="${selector}" '$2 == wanted { print $2; exit }')"
    [[ -n "${code}" ]] || return 1
    printf '%s' "${code}"
    return 0
  fi
  while IFS=$'\t' read -r index code name; do
    if [[ "${selector}" == "${index}" || "${selector}" == "${name}" || "${normalized}" == "$(cn_normalize_region_name "${name}")" ]]; then
      printf '%s' "${code}"
      return 0
    fi
  done < <(cn_list_provinces)
  return 1
}

cn_region_file_for_code() {
  local code="$(cn_trim "${1:-}")"
  if cn_is_all_china_selector "${code}"; then
    printf '%s/country/CN.txt' "${CN_DATA_DIR}"
    return 0
  fi
  [[ "${code}" =~ ^[0-9]{6}$ ]] || return 1
  local relative
  relative="$(cn_list_provinces | awk -F '\t' -v wanted="${code}" '$2 == wanted { print "regions/" $2 ".txt"; exit }')"
  [[ -n "${relative}" ]] || return 1
  printf '%s/%s' "${CN_DATA_DIR}" "${relative}"
}

cn_validate_ipv4_cidr() {
  local value="$(cn_trim "${1:-}")"
  local address prefix octet
  [[ "${value}" == */* ]] && { address="${value%/*}"; prefix="${value#*/}"; } || { address="${value}"; prefix="32"; }
  [[ "${prefix}" =~ ^[0-9]{1,2}$ ]] && ((10#${prefix} <= 32)) || return 1
  IFS='.' read -r -a octets <<< "${address}"
  [[ "${#octets[@]}" -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "${octet}" =~ ^[0-9]{1,3}$ ]] && ((10#${octet} <= 255)) || return 1
  done
}

cn_normalize_cidr_lines() {
  local source="${1:-}"
  [[ -r "${source}" ]] || return 1
  awk '
    function valid_cidr(value, address, prefix, parts, i) {
      sub(/[[:space:]]*#.*/, "", value)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value == "") return 0
      prefix = 32
      if (index(value, "/")) {
        split(value, parts, "/")
        address = parts[1]
        prefix = parts[2]
        if (prefix !~ /^[0-9][0-9]?$/ || prefix > 32) return 0
      } else address = value
      split(address, parts, ".")
      if (parts[1] == "" || parts[2] == "" || parts[3] == "" || parts[4] == "" || parts[5] != "") return 0
      for (i = 1; i <= 4; i++) if (parts[i] !~ /^[0-9][0-9]?[0-9]?$/ || parts[i] > 255) return 0
      return 1
    }
    {
      raw = $0
      if (!valid_cidr(raw)) next
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", raw)
      sub(/[[:space:]]*#.*/, "", raw)
      if (index(raw, "/") == 0) raw = raw "/32"
      print raw
    }
  ' "${source}"
}

# nftables interval sets reject duplicate or nested ranges. Keep the first
# widest range for each covered address span before rendering the set.
cn_normalize_ipv4_cidrs_for_nft() {
  awk '
    function ip2int(value, parts) {
      split(value, parts, ".")
      return (((parts[1] * 256 + parts[2]) * 256 + parts[3]) * 256 + parts[4])
    }
    {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if ($0 == "" || $0 ~ /^#/) next
      split($0, cidr, "/")
      mask = (cidr[2] == "" ? 32 : cidr[2])
      if (mask < 0 || mask > 32) next
      size = 2 ^ (32 - mask)
      start = int(ip2int(cidr[1]) / size) * size
      end = start + size - 1
      key = start "\t" end
      if (!seen[key]++) print start "\t" end "\t" $0
    }
  ' | sort -n -k1,1 -k2,2r | awk -F '\t' '
    BEGIN { max_end = -1 }
    $2 <= max_end { next }
    { print $3; max_end = $2 }
  '
}

cn_collect_region_cidrs() {
  local selector="${1:-}"
  local file
  if cn_is_all_china_selector "${selector}"; then
    file="$(cn_region_file_for_code CN)"
  else
    local code
    code="$(cn_resolve_province "${selector}")" || {
      echo "无法识别区域：${selector}" >&2
      return 1
    }
    file="$(cn_region_file_for_code "${code}")"
  fi
  cn_normalize_cidr_lines "${file}"
}

cn_proxy_url() {
  local raw_url="$1"
  local proxy="${CN_GITHUB_PROXY:-direct}"
  case "${proxy}" in
    ""|direct|none) printf '%s\n' "${raw_url}" ;;
    */) printf '%s%s\n' "${proxy}" "${raw_url}" ;;
    *) printf '%s/%s\n' "${proxy}" "${raw_url}" ;;
  esac
}

cn_collect_asn_cidrs() {
  local raw asn source
  for raw in "$@"; do
    asn="$(cn_normalize_asn "${raw}")" || {
      echo "ASN 格式错误：${raw}" >&2
      return 1
    }
    source=""
    if [[ "${CN_ASN_FORCE_UPDATE:-0}" != "1" ]]; then
      source="${CN_DATA_DIR}/asn/AS${asn}.txt"
      [[ -s "${source}" ]] || source="${CN_ASN_CACHE_DIR}/AS${asn}.txt"
    fi
    if [[ ! -s "${source}" && "${CN_ASN_OFFLINE:-0}" != "1" ]]; then
      mkdir -p "${CN_ASN_CACHE_DIR}"
      local url
      url="$(cn_proxy_url "${CN_ASN_BASE_URL%/}/${asn}/ipv4-aggregated.txt")"
      local temporary="${CN_ASN_CACHE_DIR}/.AS${asn}.tmp.$$"
      if curl -fsSL --connect-timeout 15 --max-time 60 "${url}" -o "${temporary}" && [[ -s "${temporary}" ]]; then
        mv -f "${temporary}" "${CN_ASN_CACHE_DIR}/AS${asn}.txt"
        source="${CN_ASN_CACHE_DIR}/AS${asn}.txt"
      else
        rm -f "${temporary}"
      fi
    fi
    [[ -s "${source}" ]] || {
      echo "没有可用的 ASN 数据：AS${asn}" >&2
      return 1
    }
    cn_normalize_cidr_lines "${source}"
  done
}

cn_split_selector_list() {
  local input="${1:-}"
  input="${input//,/ }"
  input="${input//，/ }"
  input="${input//、/ }"
  input="${input//;/ }"
  input="${input//；/ }"
  printf '%s\n' "${input}" | tr '[:space:]' '\n' | sed '/^$/d'
}

cn_collect_selector_cidrs() {
  local selectors="${1:-}"
  local selector
  while IFS= read -r selector; do
    [[ -n "${selector}" ]] || continue
    if cn_is_all_china_selector "${selector}" || [[ "${selector}" =~ ^[0-9]{6}$ ]] || cn_resolve_province "${selector}" >/dev/null 2>&1; then
      cn_collect_region_cidrs "${selector}"
    elif [[ "${selector}" =~ ^[0-9]{1,10}$ || "${selector}" =~ ^[Aa][Ss][0-9]{1,10}$ ]]; then
      cn_collect_asn_cidrs "${selector}"
    elif cn_validate_ipv4_cidr "${selector}"; then
      if [[ "${selector}" != */* ]]; then selector="${selector}/32"; fi
      printf '%s\n' "${selector}"
    else
      echo "白名单项格式错误：${selector}" >&2
      return 1
    fi
  done < <(cn_split_selector_list "${selectors}")
}

cn_validate_port_spec() {
  local spec="$(cn_trim "${1:-}")"
  local start end
  if [[ "${spec}" =~ ^([0-9]{1,5})-([0-9]{1,5})$ ]]; then
    start="${BASH_REMATCH[1]}"; end="${BASH_REMATCH[2]}"
  elif [[ "${spec}" =~ ^[0-9]{1,5}$ ]]; then
    start="${spec}"; end="${spec}"
  else
    return 1
  fi
  ((10#${start} >= 1 && 10#${end} <= 65535 && 10#${start} <= 10#${end}))
}

cn_validate_port_policies() {
  local policies="$(cn_trim "${1:-}")"
  [[ -n "${policies}" ]] || return 0
  local item spec selectors
  policies="${policies//；/;}"
  IFS=';' read -r -a items <<< "${policies}"
  for item in "${items[@]}"; do
    item="$(cn_trim "${item}")"
    [[ -n "${item}" ]] || continue
    [[ "${item}" == *=* ]] || return 1
    spec="$(cn_trim "${item%%=*}")"
    selectors="$(cn_trim "${item#*=}")"
    cn_validate_port_spec "${spec}" || return 1
    [[ -n "${selectors}" ]] || return 1
    cn_collect_selector_cidrs "${selectors}" >/dev/null
  done
}

cn_list_asns_from_port_policies() {
  local policies="${1:-}" item selectors selector
  policies="${policies//；/;}"
  IFS=';' read -r -a items <<< "${policies}"
  for item in "${items[@]}"; do
    selectors="${item#*=}"
    while IFS= read -r selector; do
      if [[ "${selector}" =~ ^[0-9]{1,10}$ || "${selector}" =~ ^[Aa][Ss][0-9]{1,10}$ ]]; then printf '%s\n' "${selector}"; fi
    done < <(cn_split_selector_list "${selectors}")
  done
}

cn_effective_firewall_backend() {
  case "${CN_FIREWALL_BACKEND:-auto}" in
    nft) command -v nft >/dev/null 2>&1 || return 1; printf 'nft\n' ;;
    iptables) command -v iptables >/dev/null 2>&1 && command -v ipset >/dev/null 2>&1 || return 1; printf 'iptables\n' ;;
    auto|"")
      if command -v nft >/dev/null 2>&1; then printf 'nft\n'
      elif command -v iptables >/dev/null 2>&1 && command -v ipset >/dev/null 2>&1; then printf 'iptables\n'
      else return 1
      fi
      ;;
    *) return 1 ;;
  esac
}

cn_require_root() {
  [[ "${EUID}" -eq 0 ]] || { echo "白名单规则需要 root 权限。" >&2; return 1; }
}

cn_require_commands() {
  command -v awk >/dev/null 2>&1 || { echo "缺少 awk。" >&2; return 1; }
  command -v sed >/dev/null 2>&1 || { echo "缺少 sed。" >&2; return 1; }
  cn_effective_firewall_backend >/dev/null || {
    echo "没有可用的防火墙后端，请安装 nftables 或 iptables/ipset。" >&2
    return 1
  }
}

cn_source_config() {
  [[ -r "${CN_CONFIG_FILE}" ]] || { echo "配置文件不存在：${CN_CONFIG_FILE}" >&2; return 1; }
  # The panel writes shell-quoted assignments only; loading this file keeps
  # compatibility with existing ForwardX host configurations.
  # shellcheck disable=SC1090
  source "${CN_CONFIG_FILE}"
}

cn_load_config_codes() { printf '%s\n' "${CN_CODES:-}" | tr ' ' '\n' | sed '/^$/d'; }
cn_load_config_asns() { printf '%s\n' "${CN_ASNS:-}" | tr ' ' '\n' | sed '/^$/d'; }
cn_load_config_port_policies() { printf '%s' "${CN_PORT_POLICIES:-}"; }
cn_load_config_forward_mode() { printf '%s\n' "${CN_FORWARD_MODE:-all}"; }
cn_load_config_forward_ifaces() { printf '%s\n' "${CN_FORWARD_IFACES:-}" | tr ' ' '\n' | sed '/^$/d'; }

cn_validate_forward_selection() {
  local mode="${1:-all}" ifaces="${2:-}" iface
  case "${mode}" in all|none) [[ -z "${ifaces}" ]] || return 1 ;; selected)
    [[ -n "${ifaces}" ]] || return 1
    for iface in ${ifaces}; do [[ "${iface}" =~ ^[A-Za-z0-9_.:-]{1,64}$ ]] || return 1; done ;;
    *) return 1 ;;
  esac
}

cn_cidr_list_for_selectors() {
  local selectors="${1:-}" output
  output="$(cn_collect_selector_cidrs "${selectors}" | sort -u)"
  if [[ -n "${output}" ]]; then
    printf '%s\n' "${output}"
  fi
  return 0
}

cn_ports_for_spec() {
  local spec="${1:-}"
  cn_validate_port_spec "${spec}" || return 1
  if [[ "${spec}" == *-* ]]; then printf '%s\n' "${spec}"; else printf '%s\n' "${spec}"; fi
}

cn_render_nft_set() {
  local set_name="$1" cidrs="$2"
  printf '  set %s { type ipv4_addr; flags interval;\n' "${set_name}"
  if [[ -n "${cidrs}" ]]; then
    printf '    elements = { '
    printf '%s' "${cidrs}" | paste -sd ',' -
    printf ' }\n'
  fi
  printf '  }\n'
}

cn_render_nft_port_set() {
  local set_name="$1" ports="$2"
  printf '  set %s { type inet_service; flags interval; elements = { %s } }\n' "${set_name}" "${ports}"
}

cn_render_apply_commands_nft() {
  local client_ip="$1" forward_mode="$2" forward_ifaces="$3" asns="$4" port_policies="$5"
  shift 5
  local codes=("$@")
  local global_selectors="${codes[*]} ${asns}" global_cidrs
  global_cidrs="$(cn_cidr_list_for_selectors "${global_selectors}")"
  if [[ -n "${client_ip}" ]]; then
    cn_validate_ipv4_cidr "${client_ip}" || { echo "当前客户端地址不是有效 IPv4：${client_ip}" >&2; return 1; }
    global_cidrs="${global_cidrs}${global_cidrs:+$'\n'}${client_ip}/32"
  fi

  local -a policy_ports=() policy_cidrs=() items=()
  local item spec selectors cidrs
  port_policies="${port_policies//；/;}"
  IFS=';' read -r -a items <<< "${port_policies}"
  for item in "${items[@]}"; do
    item="$(cn_trim "${item}")"; [[ -n "${item}" ]] || continue
    spec="$(cn_trim "${item%%=*}")"; selectors="$(cn_trim "${item#*=}")"
    cn_validate_port_spec "${spec}" || { echo "端口策略格式错误：${spec}" >&2; return 1; }
    cidrs="$(cn_cidr_list_for_selectors "${selectors}")"
    [[ -n "${cidrs}" ]] || { echo "端口策略没有有效白名单：${spec}" >&2; return 1; }
    policy_ports+=("${spec}"); policy_cidrs+=("${cidrs}")
  done

  local has_global="false"
  [[ -n "$(cn_trim "${global_cidrs}")" ]] && has_global="true"
  if [[ "${has_global}" != "true" && "$(cn_trim "${port_policies}")" == "" ]]; then
    echo "请至少配置一项全局白名单或端口白名单。" >&2
    return 1
  fi
  if [[ "${has_global}" == "true" ]]; then
    global_cidrs="$(cn_normalize_ipv4_cidrs_for_nft <<<"${global_cidrs}")"
  fi

  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
  cn_render_best_effort_clear_commands
  printf 'nft delete table inet %s 2>/dev/null || true\n' "${CN_NFT_TABLE}"
  printf 'nft -f - <<'"'"'FORWARDX_NFT'"'"'\n'
  printf 'table inet %s {\n' "${CN_NFT_TABLE}"
  if [[ "${has_global}" == "true" ]]; then
    cn_render_nft_set "${CN_NFT_SET_NAME}" "${global_cidrs}"
  fi
  local i port_set allow_set
  for ((i = 0; i < ${#policy_ports[@]}; i++)); do
    port_set="ports_$((i + 1))"; allow_set="policy_allow_$((i + 1))"
    cn_render_nft_port_set "${port_set}" "${policy_ports[$i]}"
    cn_render_nft_set "${allow_set}" "$(cn_normalize_ipv4_cidrs_for_nft <<<"${policy_cidrs[$i]}")"
  done
  printf '  chain %s { type filter hook input priority -10; policy accept;\n' "${CN_NFT_CHAIN_NAME}"
  printf '    iifname "lo" accept\n    ct state established,related accept\n'
  for ((i = 0; i < ${#policy_ports[@]}; i++)); do
    port_set="ports_$((i + 1))"; allow_set="policy_allow_$((i + 1))"
    printf '    tcp dport @%s ip saddr @%s accept\n' "${port_set}" "${allow_set}"
    printf '    udp dport @%s ip saddr @%s accept\n' "${port_set}" "${allow_set}"
    printf '    tcp dport @%s meta nfproto ipv4 reject\n    udp dport @%s meta nfproto ipv4 reject\n' "${port_set}" "${port_set}"
  done
  if [[ "${has_global}" == "true" ]]; then
    printf '    ip saddr @%s accept\n    meta nfproto ipv4 reject\n' "${CN_NFT_SET_NAME}"
  fi
  printf '  }\n'

  if [[ "${forward_mode}" != "none" ]]; then
    printf '  chain %s { type filter hook forward priority -10; policy accept;\n' "${CN_NFT_FORWARD_CHAIN_NAME}"
    printf '    ct state established,related accept\n'
    for ((i = 0; i < ${#policy_ports[@]}; i++)); do
      port_set="ports_$((i + 1))"; allow_set="policy_allow_$((i + 1))"
      printf '    ct status dnat ct original proto-dst @%s ip saddr @%s accept\n' "${port_set}" "${allow_set}"
      printf '    ct status dnat ct original proto-dst @%s meta nfproto ipv4 reject\n' "${port_set}"
    done
    if [[ "${has_global}" == "true" ]]; then
      if [[ "${forward_mode}" == "selected" ]]; then
        local iface
        for iface in ${forward_ifaces}; do
          printf '    iifname "%s" ct status dnat ip saddr @%s accept\n' "${iface}" "${CN_NFT_SET_NAME}"
          printf '    iifname "%s" ct status dnat meta nfproto ipv4 reject\n' "${iface}"
          printf '    oifname "%s" ct status dnat ip saddr @%s accept\n' "${iface}" "${CN_NFT_SET_NAME}"
          printf '    oifname "%s" ct status dnat meta nfproto ipv4 reject\n' "${iface}"
        done
      else
        printf '    ct status dnat ip saddr @%s accept\n    ct status dnat meta nfproto ipv4 reject\n' "${CN_NFT_SET_NAME}"
      fi
    fi
    printf '  }\n'
  fi
  printf '}\nFORWARDX_NFT\n'
}

cn_render_apply_commands_iptables() {
  local client_ip="$1" forward_mode="$2" forward_ifaces="$3" asns="$4" port_policies="$5"
  shift 5
  local codes=("$@")
  local global_selectors="${codes[*]} ${asns}" global_cidrs
  global_cidrs="$(cn_cidr_list_for_selectors "${global_selectors}")"
  if [[ -n "${client_ip}" ]]; then
    cn_validate_ipv4_cidr "${client_ip}" || return 1
    global_cidrs="${global_cidrs}${global_cidrs:+$'\n'}${client_ip}/32"
  fi
  local -a policy_specs=() policy_cidrs=() items=()
  local item spec selectors cidrs
  port_policies="${port_policies//；/;}"
  IFS=';' read -r -a items <<< "${port_policies}"
  for item in "${items[@]}"; do
    item="$(cn_trim "${item}")"; [[ -n "${item}" ]] || continue
    spec="$(cn_trim "${item%%=*}")"; selectors="$(cn_trim "${item#*=}")"
    cn_validate_port_spec "${spec}" || return 1
    cidrs="$(cn_cidr_list_for_selectors "${selectors}")"
    [[ -n "${cidrs}" ]] || return 1
    policy_specs+=("${spec}"); policy_cidrs+=("${cidrs}")
  done

  local has_global="false"
  [[ -n "$(cn_trim "${global_cidrs}")" ]] && has_global="true"
  if [[ "${has_global}" != "true" && "$(cn_trim "${port_policies}")" == "" ]]; then
    echo "请至少配置一项全局白名单或端口白名单。" >&2
    return 1
  fi

  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
  cn_render_best_effort_clear_commands
  if [[ "${has_global}" == "true" ]]; then
    printf 'ipset create %s hash:net family inet -exist\n' "${CN_IPSET_PREFIX}"
    printf 'ipset flush %s\n' "${CN_IPSET_PREFIX}"
    local cidr
    while IFS= read -r cidr; do [[ -n "${cidr}" ]] && printf 'ipset add %s %s -exist\n' "${CN_IPSET_PREFIX}" "${cidr}"; done <<< "${global_cidrs}"
  else
    printf 'ipset destroy %s 2>/dev/null || true\n' "${CN_IPSET_PREFIX}"
  fi
  local i set_name
  for ((i = 0; i < ${#policy_specs[@]}; i++)); do
    set_name="${CN_IPSET_PREFIX}_$((i + 1))"
    printf 'ipset create %s hash:net family inet -exist\nipset flush %s\n' "${set_name}" "${set_name}"
    while IFS= read -r cidr; do [[ -n "${cidr}" ]] && printf 'ipset add %s %s -exist\n' "${set_name}" "${cidr}"; done <<< "${policy_cidrs[$i]}"
  done
  for ((i = ${#policy_specs[@]} + 1; i <= 32; i++)); do printf 'ipset destroy %s_%d 2>/dev/null || true\n' "${CN_IPSET_PREFIX}" "${i}"; done
  printf 'iptables -S INPUT 2>/dev/null | awk '\''$0 ~ /-j %s([[:space:]]|$)/ {sub(/^-A /, "-D "); print "iptables " $0}'\'' | sh || true\n' "${CN_CHAIN_NAME}"
  printf 'iptables -S FORWARD 2>/dev/null | awk '\''$0 ~ /-j %s([[:space:]]|$)/ {sub(/^-A /, "-D "); print "iptables " $0}'\'' | sh || true\n' "${CN_CHAIN_NAME}"
  printf 'iptables -N %s 2>/dev/null || true\niptables -F %s\n' "${CN_CHAIN_NAME}" "${CN_CHAIN_NAME}"
  printf 'iptables -C INPUT -j %s 2>/dev/null || iptables -I INPUT 1 -j %s\n' "${CN_CHAIN_NAME}" "${CN_CHAIN_NAME}"
  if [[ "${forward_mode}" == "selected" ]]; then
    local iface
    for iface in ${forward_ifaces}; do
      printf 'iptables -C FORWARD -i %s -m conntrack --ctstate DNAT -j %s 2>/dev/null || iptables -I FORWARD 1 -i %s -m conntrack --ctstate DNAT -j %s\n' "${iface}" "${CN_CHAIN_NAME}" "${iface}" "${CN_CHAIN_NAME}"
      printf 'iptables -C FORWARD -o %s -m conntrack --ctstate DNAT -j %s 2>/dev/null || iptables -I FORWARD 1 -o %s -m conntrack --ctstate DNAT -j %s\n' "${iface}" "${CN_CHAIN_NAME}" "${iface}" "${CN_CHAIN_NAME}"
    done
  elif [[ "${forward_mode}" != "none" ]]; then
    printf 'iptables -C FORWARD -m conntrack --ctstate DNAT -j %s 2>/dev/null || iptables -I FORWARD 1 -m conntrack --ctstate DNAT -j %s\n' "${CN_CHAIN_NAME}" "${CN_CHAIN_NAME}"
  fi
  printf 'iptables -A %s -i lo -j ACCEPT\niptables -A %s -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n' "${CN_CHAIN_NAME}" "${CN_CHAIN_NAME}"
  for ((i = 0; i < ${#policy_specs[@]}; i++)); do
    set_name="${CN_IPSET_PREFIX}_$((i + 1))"
    local iptables_port="${policy_specs[$i]//-/:}"
    printf 'iptables -A %s -p tcp -m conntrack --ctstate DNAT --ctorigdstport %s -m set --match-set %s src -j ACCEPT\n' "${CN_CHAIN_NAME}" "${iptables_port}" "${set_name}"
    printf 'iptables -A %s -p udp -m conntrack --ctstate DNAT --ctorigdstport %s -m set --match-set %s src -j ACCEPT\n' "${CN_CHAIN_NAME}" "${iptables_port}" "${set_name}"
    printf 'iptables -A %s -p tcp -m conntrack --ctstate DNAT --ctorigdstport %s -j REJECT\n' "${CN_CHAIN_NAME}" "${iptables_port}"
    printf 'iptables -A %s -p udp -m conntrack --ctstate DNAT --ctorigdstport %s -j REJECT\n' "${CN_CHAIN_NAME}" "${iptables_port}"
    printf 'iptables -A %s -p tcp -m conntrack ! --ctstate DNAT --dport %s -m set --match-set %s src -j ACCEPT\n' "${CN_CHAIN_NAME}" "${iptables_port}" "${set_name}"
    printf 'iptables -A %s -p udp -m conntrack ! --ctstate DNAT --dport %s -m set --match-set %s src -j ACCEPT\n' "${CN_CHAIN_NAME}" "${iptables_port}" "${set_name}"
    printf 'iptables -A %s -p tcp -m conntrack ! --ctstate DNAT --dport %s -j REJECT\n' "${CN_CHAIN_NAME}" "${iptables_port}"
    printf 'iptables -A %s -p udp -m conntrack ! --ctstate DNAT --dport %s -j REJECT\n' "${CN_CHAIN_NAME}" "${iptables_port}"
  done
  if [[ "${has_global}" == "true" ]]; then
    printf 'iptables -A %s -m set --match-set %s src -j ACCEPT\niptables -A %s -j REJECT\n' "${CN_CHAIN_NAME}" "${CN_IPSET_PREFIX}" "${CN_CHAIN_NAME}"
  fi
  if [[ "${forward_mode}" == "none" ]]; then return 0; fi
}

cn_render_apply_commands() {
  local client_ip="${1:-}" forward_mode="${2:-all}" forward_ifaces="${3:-}" asns="${4:-}" port_policies="${5:-}"
  shift 5
  cn_validate_forward_selection "${forward_mode}" "${forward_ifaces}" || { echo "转发模式配置错误。" >&2; return 1; }
  [[ -z "${port_policies}" ]] || cn_validate_port_policies "${port_policies}" || { echo "端口白名单配置错误。" >&2; return 1; }
  local backend
  backend="$(cn_effective_firewall_backend)" || { echo "没有可用防火墙后端。" >&2; return 1; }
  if [[ "${backend}" == "nft" ]]; then
    cn_render_apply_commands_nft "${client_ip}" "${forward_mode}" "${forward_ifaces}" "${asns}" "${port_policies}" "$@"
  else
    cn_render_apply_commands_iptables "${client_ip}" "${forward_mode}" "${forward_ifaces}" "${asns}" "${port_policies}" "$@"
  fi
}

cn_render_best_effort_clear_commands() {
  printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail'
  printf 'nft delete table inet %s 2>/dev/null || true\n' "${CN_NFT_TABLE}"
  printf 'if command -v iptables >/dev/null 2>&1; then for chain in INPUT FORWARD; do iptables -S "${chain}" 2>/dev/null | awk '\''$0 ~ /-j %s([[:space:]]|$)/ {sub(/^-A /, "-D "); print "iptables " $0}'\'' | sh || true; done; iptables -F %s 2>/dev/null || true; iptables -X %s 2>/dev/null || true; fi\n' "${CN_CHAIN_NAME}" "${CN_CHAIN_NAME}" "${CN_CHAIN_NAME}"
  printf 'if command -v ipset >/dev/null 2>&1; then ipset destroy %s 2>/dev/null || true; for n in $(seq 1 32); do ipset destroy %s_${n} 2>/dev/null || true; done; fi\n' "${CN_IPSET_PREFIX}" "${CN_IPSET_PREFIX}"
}

cn_run_rendered_commands() {
  bash -euo pipefail
}

cn_install_systemd_service() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local unit="/etc/systemd/system/${CN_SERVICE_NAME}" temporary
  temporary="${unit}.tmp.$$"
  mkdir -p "$(dirname "${unit}")"
  {
    printf '[Unit]\nDescription=ForwardX China region whitelist\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/bash %q apply-config\nExecStop=/bin/bash %q clear\n\n[Install]\nWantedBy=multi-user.target\n' "${CN_ROOT}/forwardx-agent-run.sh" "${CN_ROOT}/forwardx-agent-run.sh"
  } > "${temporary}"
  chmod 0644 "${temporary}"
  mv -f "${temporary}" "${unit}"
  systemctl daemon-reload || true
  systemctl enable "${CN_SERVICE_NAME}" >/dev/null 2>&1 || true
}

cn_disable_systemd_service() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "${CN_SERVICE_NAME}" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${CN_SERVICE_NAME}"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
}

cn_show_persistence_status() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-enabled --quiet "${CN_SERVICE_NAME}" 2>/dev/null; then
      echo "开机恢复：已启用"
    else
      echo "开机恢复：未启用"
    fi
  else
    echo "开机恢复：系统未提供 systemctl"
  fi
}
