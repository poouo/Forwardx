#!/usr/bin/env bash
set -euo pipefail

CN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGIONS_JSON="${REGIONS_JSON:-${CN_ROOT}/data/regions.json}"
DATA_DIR="${DATA_DIR:-${CN_ROOT}/data}"
CN_REGIONS_TSV="${CN_REGIONS_TSV:-${DATA_DIR}/regions.tsv}"
CN_COUNTRY_FILE="${CN_COUNTRY_FILE:-${DATA_DIR}/country/CN.txt}"
CN_BUNDLED_ASN_DIR="${CN_BUNDLED_ASN_DIR:-${DATA_DIR}/asn}"
CN_RUNTIME_DIR="${CN_RUNTIME_DIR:-/var/lib/china-region-whitelist}"
CN_CONFIG_FILE="${CN_CONFIG_FILE:-/etc/china-region-whitelist.conf}"
CN_SERVICE_NAME="china-region-whitelist.service"
CN_CHAIN_NAME="CN_REGION_WHITELIST"
CN_SET_NAME="cn_region_whitelist"
CN_FIREWALL_BACKEND="${CN_FIREWALL_BACKEND:-auto}"
CN_NFT_TABLE="china_region_whitelist"
CN_NFT_SET_NAME="allowed_v4"
CN_NFT_HOOK_PRIORITY="${CN_NFT_HOOK_PRIORITY:--10}"
CN_PORT_POLICIES="${CN_PORT_POLICIES:-}"
CN_GITHUB_PROXY="${CN_GITHUB_PROXY:-https://gh-proxy.com/}"
CN_REPO_OWNER="${CN_REPO_OWNER:-GHUNLIL}"
CN_REPO_NAME="${CN_REPO_NAME:-china-region-whitelist}"
CN_REPO_BRANCH="${CN_REPO_BRANCH:-main}"
CN_REPO_ARCHIVE_URL="${CN_REPO_ARCHIVE_URL:-https://github.com/${CN_REPO_OWNER}/${CN_REPO_NAME}/archive/refs/heads/${CN_REPO_BRANCH}.tar.gz}"
CN_ASN_BASE_URL="${CN_ASN_BASE_URL:-https://raw.githubusercontent.com/ipverse/as-ip-blocks/master/as}"
CN_ASN_CACHE_DIR="${CN_ASN_CACHE_DIR:-${CN_RUNTIME_DIR}/asn}"

cn_set_data_dir() {
  local output_dir="$1"
  REGIONS_JSON="${output_dir}/data/regions.json"
  DATA_DIR="${output_dir}/data"
  CN_REGIONS_TSV="${DATA_DIR}/regions.tsv"
  CN_COUNTRY_FILE="${DATA_DIR}/country/CN.txt"
  CN_BUNDLED_ASN_DIR="${DATA_DIR}/asn"
}

cn_github_proxy_url_with_proxy() {
  local raw_url="$1"
  local proxy="$2"
  case "${proxy}" in
    ""|direct|none)
      printf '%s\n' "${raw_url}"
      ;;
    */)
      printf '%s%s\n' "${proxy}" "${raw_url}"
      ;;
    *)
      printf '%s/%s\n' "${proxy}" "${raw_url}"
      ;;
  esac
}

cn_github_proxy_url() {
  cn_github_proxy_url_with_proxy "$1" "${CN_GITHUB_PROXY}"
}

cn_proxy_url_if_github() {
  local raw_url="$1"
  case "${raw_url}" in
    https://raw.githubusercontent.com/*|https://github.com/*)
      cn_github_proxy_url "${raw_url}"
      ;;
    *)
      printf '%s\n' "${raw_url}"
      ;;
  esac
}

cn_effective_firewall_backend() {
  case "${CN_FIREWALL_BACKEND}" in
    nft|iptables)
      printf '%s\n' "${CN_FIREWALL_BACKEND}"
      ;;
    auto|"")
      if command -v nft >/dev/null 2>&1; then
        printf '%s\n' "nft"
      else
        printf '%s\n' "iptables"
      fi
      ;;
    *)
      echo "未知防火墙后端：${CN_FIREWALL_BACKEND}，可选 auto/nft/iptables。" >&2
      return 1
      ;;
  esac
}

cn_use_runtime_data_if_available() {
  if [[ -s "${CN_RUNTIME_DIR}/data/regions.json" && -d "${CN_RUNTIME_DIR}/data/regions" && -s "${CN_RUNTIME_DIR}/data/country/CN.txt" ]]; then
    cn_set_data_dir "${CN_RUNTIME_DIR}"
  fi
}

cn_download_repo_archive() {
  local target="$1"
  local proxy_candidates proxy url
  proxy_candidates="${CN_GITHUB_PROXIES:-${CN_GITHUB_PROXY} direct}"
  proxy_candidates="${proxy_candidates//,/ }"

  for proxy in ${proxy_candidates}; do
    url="$(cn_github_proxy_url_with_proxy "${CN_REPO_ARCHIVE_URL}" "${proxy}")"
    echo "正在下载 GitHub 预制 IP 数据包：${url}" >&2
    if curl -fL --connect-timeout 20 --retry 2 --retry-delay 1 -o "${target}" "${url}"; then
      return 0
    fi
    echo "下载失败，尝试下一个地址。" >&2
  done

  echo "无法下载 GitHub 预制 IP 数据包，请检查网络或设置 CN_GITHUB_PROXY。" >&2
  return 1
}

cn_validate_prebuilt_data_dir() {
  local data_dir="$1"
  if [[ ! -s "${data_dir}/regions.json" || ! -s "${data_dir}/regions.tsv" || ! -s "${data_dir}/country/CN.txt" || ! -d "${data_dir}/regions" ]]; then
    echo "预制 IP 数据不完整：${data_dir}" >&2
    return 1
  fi
}

cn_update_runtime_data() {
  cn_require_root
  if [[ -z "${CN_RUNTIME_DIR}" || "${CN_RUNTIME_DIR}" == "/" ]]; then
    echo "运行目录不安全：CN_RUNTIME_DIR=${CN_RUNTIME_DIR}" >&2
    return 1
  fi
  local command_name
  for command_name in curl tar mktemp; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      echo "同步 GitHub 预制 IP 数据需要 ${command_name}。" >&2
      return 1
    fi
  done

  local work_dir archive_path source_dir next_data status
  mkdir -p "${CN_RUNTIME_DIR}"
  work_dir="$(mktemp -d)"
  archive_path="${work_dir}/repo.tar.gz"
  source_dir="${work_dir}/source"
  next_data="${CN_RUNTIME_DIR}/data.new"
  status=0

  (
    set -e
    mkdir -p "${source_dir}"
    cn_download_repo_archive "${archive_path}"
    tar -xzf "${archive_path}" --strip-components=1 -C "${source_dir}"
    cn_validate_prebuilt_data_dir "${source_dir}/data"
    rm -rf "${next_data}"
    cp -a "${source_dir}/data" "${next_data}"
    cn_validate_prebuilt_data_dir "${next_data}"
    rm -rf "${CN_RUNTIME_DIR}/data"
    mv "${next_data}" "${CN_RUNTIME_DIR}/data"
  ) || status=$?

  rm -rf "${work_dir}" "${next_data}"
  if [[ "${status}" -ne 0 ]]; then
    return "${status}"
  fi

  cn_set_data_dir "${CN_RUNTIME_DIR}"
  echo "已同步 GitHub 预制 IP 数据：${CN_RUNTIME_DIR}/data" >&2
}

cn_require_region_index() {
  if [[ ! -r "${CN_REGIONS_TSV}" ]]; then
    echo "缺少省份索引：${CN_REGIONS_TSV}" >&2
    echo "请重新运行 bootstrap.sh 或 install.sh update-data 拉取 GitHub 预制数据。" >&2
    return 1
  fi
}

cn_normalize_region_name() {
  local name="$1"
  local suffix
  name="${name#"${name%%[![:space:]]*}"}"
  name="${name%"${name##*[![:space:]]}"}"
  for suffix in 特别行政区 维吾尔自治区 壮族自治区 回族自治区 自治区 省 市; do
    if [[ "${name}" == *"${suffix}" ]]; then
      printf '%s\n' "${name%"${suffix}"}"
      return
    fi
  done
  printf '%s\n' "${name}"
}

cn_list_provinces() {
  cn_require_region_index
  awk -F '\t' '$1 == "province" {print $2 "\t" $6 "\t" $7}' "${CN_REGIONS_TSV}"
}

cn_show_provinces() {
  echo "可选省份："
  cn_list_provinces | awk -F '\t' '{print $1 "." $3}'
}

cn_resolve_province() {
  local selector="$1"
  local selector_norm code=""
  local match_count=0
  selector="${selector#"${selector%%[![:space:]]*}"}"
  selector="${selector%"${selector##*[![:space:]]}"}"
  selector_norm="$(cn_normalize_region_name "${selector}")"

  local index province_code name
  while IFS=$'\t' read -r index province_code name; do
    if [[ "${selector}" == "${index}" || "${selector}" == "${province_code}" || "${selector}" == "${name}" || "${selector_norm}" == "$(cn_normalize_region_name "${name}")" ]]; then
      code="${province_code}"
      match_count=$((match_count + 1))
    fi
  done < <(cn_list_provinces)

  if [[ "${match_count}" -eq 1 ]]; then
    printf '%s\n' "${code}"
    return
  fi
  if [[ "${match_count}" -eq 0 ]]; then
    echo "未找到省份：${selector}" >&2
  else
    echo "省份名称不唯一：${selector}" >&2
  fi
  return 1
}

cn_collect_cidrs() {
  local code region_file full_path
  for code in "$@"; do
    if cn_is_all_china_selector "${code}"; then
      cn_collect_country_cidrs
      continue
    fi
    region_file="$(cn_region_file_for_code "${code}")" || return 1
    full_path="${DATA_DIR}/${region_file}"
    if [[ ! -r "${full_path}" ]]; then
      echo "缺少省级 CIDR 文件：${full_path}" >&2
      return 1
    fi
    sed 's/[[:space:]]*$//' "${full_path}" | awk 'NF && $0 !~ /^#/'
  done | awk '!seen[$0]++'
}

cn_collect_country_cidrs() {
  if [[ ! -r "${CN_COUNTRY_FILE}" ]]; then
    echo "缺少国家级 CN CIDR 文件：${CN_COUNTRY_FILE}" >&2
    echo "请重新运行 bootstrap.sh 或 install.sh update-data 拉取 GitHub 预制数据。" >&2
    return 1
  fi
  sed 's/[[:space:]]*$//' "${CN_COUNTRY_FILE}" | awk 'NF && $0 !~ /^#/'
}

cn_province_name() {
  local code="$1"
  cn_require_region_index
  awk -F '\t' -v code="${code}" '$1 == "province" && $6 == code {print $7; exit}' "${CN_REGIONS_TSV}"
}

cn_region_file_for_code() {
  local code="$1"
  if ! [[ "${code}" =~ ^[0-9]{6}$ ]]; then
    echo "非法省份代码：${code}" >&2
    return 1
  fi
  cn_require_region_index
  local file
  file="$(awk -F '\t' -v code="${code}" '$1 == "province" && $6 == code {print $8; exit}' "${CN_REGIONS_TSV}")"
  if [[ -z "${file}" ]]; then
    echo "未知省份代码：${code}" >&2
    return 1
  fi
  printf '%s\n' "${file}"
}

cn_normalize_asn() {
  local asn="$1"
  asn="${asn#"${asn%%[![:space:]]*}"}"
  asn="${asn%"${asn##*[![:space:]]}"}"
  case "${asn}" in
    AS*|as*|As*|aS*) asn="${asn:2}" ;;
  esac
  if ! [[ "${asn}" =~ ^[0-9]{1,10}$ ]]; then
    echo "非法 ASN：${asn}" >&2
    return 1
  fi
  if (( asn < 1 || asn > 4294967295 )); then
    echo "ASN 超出范围：${asn}" >&2
    return 1
  fi
  printf '%s\n' "${asn}"
}

cn_asn_prefix_url() {
  local asn="$1"
  local base_url
  base_url="$(cn_proxy_url_if_github "${CN_ASN_BASE_URL}")"
  printf '%s/%s/ipv4-aggregated.txt\n' "${base_url%/}" "${asn}"
}

cn_download_asn_prefixes() {
  local asn="$1"
  local target="$2"
  local tmp url
  if [[ "${CN_ASN_OFFLINE:-0}" == "1" ]]; then
    echo "缺少 ASN${asn} 缓存：${target}；请先运行 apply 或 update-asn 在线同步。" >&2
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "同步 ASN${asn} 前缀需要 curl。" >&2
    return 1
  fi
  mkdir -p "$(dirname "${target}")"
  tmp="${target}.tmp.$$"
  url="$(cn_asn_prefix_url "${asn}")"
  echo "正在同步 ASN${asn} IPv4 前缀：${url}" >&2
  if ! curl -fsSL --connect-timeout 20 --retry 2 --retry-delay 1 -o "${tmp}" "${url}"; then
    rm -f "${tmp}"
    echo "同步 ASN${asn} 前缀失败。" >&2
    return 1
  fi
  mv "${tmp}" "${target}"
}

cn_collect_asn_cidrs() {
  local raw_asn asn file bundled_file
  for raw_asn in "$@"; do
    [[ -n "${raw_asn}" ]] || continue
    asn="$(cn_normalize_asn "${raw_asn}")" || return 1
    bundled_file="${CN_BUNDLED_ASN_DIR}/AS${asn}.txt"
    if [[ "${CN_ASN_FORCE_UPDATE:-0}" != "1" && -s "${bundled_file}" ]]; then
      awk 'NF && $0 !~ /^#/ && $0 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+$/ {print $0}' "${bundled_file}"
      continue
    fi
    file="${CN_ASN_CACHE_DIR}/AS${asn}.txt"
    if [[ ! -s "${file}" || "${CN_ASN_FORCE_UPDATE:-0}" == "1" ]]; then
      cn_download_asn_prefixes "${asn}" "${file}" || return 1
    fi
    awk 'NF && $0 !~ /^#/ && $0 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+$/ {print $0}' "${file}"
  done
}

cn_collect_allowed_cidrs() {
  local asns="$1"
  shift || true
  {
    cn_collect_cidrs "$@"
    # shellcheck disable=SC2086
    cn_collect_asn_cidrs ${asns}
  } | awk '!seen[$0]++'
}

cn_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s\n' "${value}"
}

cn_is_ipv4_address() {
  local ip="$1"
  [[ "${ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

cn_validate_ipv4_cidr() {
  local value="$1"
  local addr mask octet
  addr="${value%/*}"
  mask=""
  if [[ "${value}" == */* ]]; then
    mask="${value#*/}"
  fi
  [[ "${addr}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r o1 o2 o3 o4 <<<"${addr}"
  for octet in "${o1}" "${o2}" "${o3}" "${o4}"; do
    [[ "${octet}" =~ ^[0-9]+$ ]] || return 1
    (( octet >= 0 && octet <= 255 )) || return 1
  done
  if [[ -n "${mask}" ]]; then
    [[ "${mask}" =~ ^[0-9]+$ ]] || return 1
    (( mask >= 0 && mask <= 32 )) || return 1
  fi
}

cn_is_all_china_selector() {
  case "$1" in
    全国|中国|中国大陆|大陆|CN|cn|all|ALL)
      return 0
      ;;
  esac
  return 1
}

cn_split_selector_list() {
  local input="$1"
  input="${input//,/ }"
  input="${input//，/ }"
  input="${input//、/ }"
  printf '%s\n' "${input}" | tr '[:space:]' '\n'
}

cn_collect_selector_cidrs() {
  local selectors="$1"
  local selector asn code
  while IFS= read -r selector; do
    selector="$(cn_trim "${selector}")"
    [[ -n "${selector}" ]] || continue
    if cn_is_all_china_selector "${selector}"; then
      cn_collect_country_cidrs
    elif [[ "${selector}" =~ ^[Aa][Ss][0-9]+$ ]]; then
      asn="$(cn_normalize_asn "${selector}")" || return 1
      cn_collect_asn_cidrs "AS${asn}"
    elif cn_validate_ipv4_cidr "${selector}"; then
      printf '%s\n' "${selector}"
    else
      code="$(cn_resolve_province "${selector}")" || return 1
      cn_collect_cidrs "${code}"
    fi
  done < <(cn_split_selector_list "${selectors}") | awk '!seen[$0]++'
}

cn_validate_port_spec() {
  local spec="$1"
  local start end
  spec="$(cn_trim "${spec}")"
  if [[ "${spec}" =~ ^[0-9]{1,5}$ ]]; then
    (( spec >= 1 && spec <= 65535 )) || return 1
    return 0
  fi
  if [[ "${spec}" =~ ^[0-9]{1,5}-[0-9]{1,5}$ ]]; then
    start="${spec%-*}"
    end="${spec#*-}"
    (( start >= 1 && start <= 65535 && end >= 1 && end <= 65535 && start <= end )) || return 1
    return 0
  fi
  return 1
}

cn_validate_port_policies() {
  local policies="$1"
  local raw_policy port_spec selectors selector code asn
  local -a policy_items
  policies="${policies//；/;}"
  [[ -n "$(cn_trim "${policies}")" ]] || return 0

  IFS=';' read -r -a policy_items <<<"${policies}"
  for raw_policy in "${policy_items[@]}"; do
    raw_policy="$(cn_trim "${raw_policy}")"
    [[ -n "${raw_policy}" ]] || continue
    if [[ "${raw_policy}" != *=* ]]; then
      echo "端口策略缺少 '='：${raw_policy}" >&2
      return 1
    fi
    port_spec="$(cn_trim "${raw_policy%%=*}")"
    selectors="$(cn_trim "${raw_policy#*=}")"
    if ! cn_validate_port_spec "${port_spec}"; then
      echo "非法端口或端口范围：${port_spec}" >&2
      return 1
    fi
    if [[ -z "${selectors}" ]]; then
      echo "端口策略缺少白名单：${raw_policy}" >&2
      return 1
    fi
    while IFS= read -r selector; do
      selector="$(cn_trim "${selector}")"
      [[ -n "${selector}" ]] || continue
      if cn_is_all_china_selector "${selector}"; then
        true
      elif [[ "${selector}" =~ ^[Aa][Ss][0-9]+$ ]]; then
        asn="$(cn_normalize_asn "${selector}")" || return 1
        [[ -n "${asn}" ]] || return 1
      elif cn_validate_ipv4_cidr "${selector}"; then
        true
      else
        code="$(cn_resolve_province "${selector}")" || return 1
        [[ -n "${code}" ]] || return 1
      fi
    done < <(cn_split_selector_list "${selectors}")
  done
}

cn_list_asns_from_port_policies() {
  local policies="$1"
  local raw_policy selectors selector asn
  local -a policy_items
  policies="${policies//；/;}"
  [[ -n "$(cn_trim "${policies}")" ]] || return 0
  IFS=';' read -r -a policy_items <<<"${policies}"
  for raw_policy in "${policy_items[@]}"; do
    raw_policy="$(cn_trim "${raw_policy}")"
    [[ -n "${raw_policy}" && "${raw_policy}" == *=* ]] || continue
    selectors="$(cn_trim "${raw_policy#*=}")"
    while IFS= read -r selector; do
      selector="$(cn_trim "${selector}")"
      [[ -n "${selector}" ]] || continue
      if [[ "${selector}" =~ ^[Aa][Ss][0-9]+$ ]]; then
        asn="$(cn_normalize_asn "${selector}")" || return 1
        printf 'AS%s\n' "${asn}"
      fi
    done < <(cn_split_selector_list "${selectors}")
  done | awk '!seen[$0]++'
}

cn_for_each_port_policy() {
  local policies="$1"
  local callback="$2"
  local raw_policy port_spec selectors index=0
  local -a policy_items
  policies="${policies//；/;}"
  [[ -n "$(cn_trim "${policies}")" ]] || return 0
  IFS=';' read -r -a policy_items <<<"${policies}"
  for raw_policy in "${policy_items[@]}"; do
    raw_policy="$(cn_trim "${raw_policy}")"
    [[ -n "${raw_policy}" ]] || continue
    port_spec="$(cn_trim "${raw_policy%%=*}")"
    selectors="$(cn_trim "${raw_policy#*=}")"
    index=$((index + 1))
    "${callback}" "${index}" "${port_spec}" "${selectors}"
  done
}

cn_preflight_port_policy() {
  local index="$1"
  local _port_spec="$2"
  local selectors="$3"
  local cidrs
  cidrs="$(cn_collect_selector_cidrs "${selectors}")" || return 1
  if [[ -z "$(cn_trim "${cidrs}")" ]]; then
    echo "端口策略 ${index} 没有可用 IPv4 CIDR 段。" >&2
    return 1
  fi
}

cn_remove_jump_command() {
  local entry_chain="$1"
  printf "iptables -S %s | awk '\$0 ~ / -j %s( |\$)/ { sub(/^-A /, \"-D \"); print \"iptables \" \$0 }' | sh\n" \
    "${entry_chain}" "${CN_CHAIN_NAME}"
}

cn_add_jump_command() {
  local entry_chain="$1"
  shift || true
  local arg_string=""
  if [[ "$#" -gt 0 ]]; then
    arg_string="$* "
  fi
  printf 'iptables -C %s %s-j %s 2>/dev/null || iptables -I %s 1 %s-j %s\n' \
    "${entry_chain}" "${arg_string}" "${CN_CHAIN_NAME}" "${entry_chain}" "${arg_string}" "${CN_CHAIN_NAME}"
}

cn_validate_client_ip() {
  local ip="$1"
  [[ "${ip}" =~ ^[0-9A-Fa-f:.]+$ ]]
}

cn_is_ipv4_covered_by_cidrs() {
  local ip="$1"
  local cidrs="$2"
  awk -v target_ip="${ip}" '
    function ip2int(value, parts) {
      split(value, parts, ".")
      return (((parts[1] * 256 + parts[2]) * 256 + parts[3]) * 256 + parts[4])
    }
    BEGIN {
      target = ip2int(target_ip)
      covered = 0
    }
    {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if ($0 == "" || $0 ~ /^#/) {
        next
      }
      split($0, cidr, "/")
      mask = (cidr[2] == "" ? 32 : cidr[2])
      if (mask < 0 || mask > 32) {
        next
      }
      size = 2 ^ (32 - mask)
      start = int(ip2int(cidr[1]) / size) * size
      end = start + size - 1
      if (target >= start && target <= end) {
        covered = 1
        exit
      }
    }
    END {
      exit covered ? 0 : 1
    }
  ' <<<"${cidrs}"
}

cn_normalize_ipv4_cidrs_for_nft() {
  awk '
    function ip2int(value, parts) {
      split(value, parts, ".")
      return (((parts[1] * 256 + parts[2]) * 256 + parts[3]) * 256 + parts[4])
    }
    {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if ($0 == "" || $0 ~ /^#/) {
        next
      }
      split($0, cidr, "/")
      mask = (cidr[2] == "" ? 32 : cidr[2])
      if (mask < 0 || mask > 32) {
        next
      }
      size = 2 ^ (32 - mask)
      start = int(ip2int(cidr[1]) / size) * size
      end = start + size - 1
      key = start "\t" end
      if (!seen[key]++) {
        print start "\t" end "\t" $0
      }
    }
  ' | sort -n -k1,1 -k2,2r | awk -F '\t' '
    BEGIN {
      max_end = -1
    }
    $2 <= max_end {
      next
    }
    {
      print $3
      max_end = $2
    }
  '
}

cn_nft_print_element_list() {
  local values="$1"
  local indent="${2:-      }"
  local value first=1
  while IFS= read -r value; do
    value="$(cn_trim "${value}")"
    [[ -n "${value}" ]] || continue
    if [[ "${first}" -eq 1 ]]; then
      printf '%s%s' "${indent}" "${value}"
      first=0
    else
      printf ',\n%s%s' "${indent}" "${value}"
    fi
  done <<<"${values}"
  printf '\n'
}

cn_render_nft_ip_set_definition() {
  local set_name="$1"
  local cidrs="$2"
  local indent="${3:-  }"
  printf '%sset %s {\n' "${indent}" "${set_name}"
  printf '%s  type ipv4_addr\n' "${indent}"
  printf '%s  flags interval\n' "${indent}"
  printf '%s  elements = {\n' "${indent}"
  cn_nft_print_element_list "${cidrs}" "${indent}    "
  printf '%s  }\n' "${indent}"
  printf '%s}\n' "${indent}"
}

cn_render_nft_port_set_definition() {
  local set_name="$1"
  local port_spec="$2"
  local indent="${3:-  }"
  printf '%sset %s {\n' "${indent}" "${set_name}"
  printf '%s  type inet_service\n' "${indent}"
  printf '%s  flags interval\n' "${indent}"
  printf '%s  elements = { %s }\n' "${indent}" "${port_spec}"
  printf '%s}\n' "${indent}"
}

cn_render_apply_commands() {
  local backend
  backend="$(cn_effective_firewall_backend)" || return 1
  case "${backend}" in
    nft) cn_render_apply_commands_nft "$@" ;;
    iptables) cn_render_apply_commands_iptables "$@" ;;
  esac
}

cn_validate_forward_selection() {
  local forward_mode="$1"
  local forward_ifaces="$2"
  case "${forward_mode}" in
    all|"")
      ;;
    none)
      ;;
    selected)
      if [[ -z "${forward_ifaces}" ]]; then
        echo "已选择指定转发接口模式，但没有提供接口名。" >&2
        return 1
      fi
      local iface
      for iface in ${forward_ifaces}; do
        cn_validate_interface_name "${iface}" || return 1
      done
      ;;
    *)
      echo "未知转发接口模式：${forward_mode}" >&2
      return 1
      ;;
  esac
}

cn_render_apply_commands_iptables() {
  local client_ip="${1:-}"
  local forward_mode="${2:-all}"
  local forward_ifaces="${3:-}"
  local asns="${4:-}"
  local port_policies="${5:-}"
  shift 5 || true

  cn_validate_forward_selection "${forward_mode}" "${forward_ifaces}" || return 1
  cn_validate_port_policies "${port_policies}" || return 1
  cn_for_each_port_policy "${port_policies}" cn_preflight_port_policy || return 1

  local cidrs cidr has_global="false"
  cidrs="$(cn_collect_allowed_cidrs "${asns}" "$@")" || return 1
  if [[ -n "${client_ip}" ]]; then
    if ! cn_validate_client_ip "${client_ip}"; then
      echo "非法客户端 IP：${client_ip}" >&2
      return 1
    fi
    if ! cn_is_ipv4_address "${client_ip}"; then
      echo "iptables 后端当前只支持 IPv4 客户端临时白名单：${client_ip}" >&2
      return 1
    fi
    cidrs="${cidrs}${cidrs:+$'\n'}${client_ip}"
  fi
  if [[ -n "$(cn_trim "${cidrs}")" ]]; then
    has_global="true"
  elif [[ -z "$(cn_trim "${port_policies}")" ]]; then
    echo "请至少配置一项全局白名单或端口白名单。" >&2
    return 1
  fi

  printf 'iptables -N %s 2>/dev/null || true\n' "${CN_CHAIN_NAME}"
  cn_remove_jump_command INPUT
  cn_remove_jump_command FORWARD
  printf 'iptables -F %s\n' "${CN_CHAIN_NAME}"
  printf 'ipset list -name 2>/dev/null | awk '\''$0 == "%s" || $0 ~ /^%s_port_[0-9]+$/ { print "ipset destroy " $0 " 2>/dev/null || true" }'\'' | sh\n' "${CN_SET_NAME}" "${CN_SET_NAME}"

  if [[ "${has_global}" == "true" ]]; then
    printf 'ipset create %s hash:net family inet -exist\n' "${CN_SET_NAME}"
    printf 'ipset flush %s\n' "${CN_SET_NAME}"
    while IFS= read -r cidr; do
      [[ -n "${cidr}" ]] || continue
      printf 'ipset add %s %s -exist\n' "${CN_SET_NAME}" "${cidr}"
    done <<<"${cidrs}"
  fi
  cn_for_each_port_policy "${port_policies}" cn_render_iptables_port_policy_set

  cn_add_jump_command INPUT
  if [[ "${forward_mode}" != "none" ]]; then
    if [[ "${forward_mode}" == "selected" ]]; then
      local iface
      for iface in ${forward_ifaces}; do
        cn_add_jump_command FORWARD -i "${iface}" -m conntrack --ctstate DNAT
        cn_add_jump_command FORWARD -o "${iface}" -m conntrack --ctstate DNAT
      done
    else
      cn_add_jump_command FORWARD -m conntrack --ctstate DNAT
    fi
  fi
  printf 'iptables -A %s -i lo -j ACCEPT\n' "${CN_CHAIN_NAME}"
  printf 'iptables -A %s -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT\n' "${CN_CHAIN_NAME}"
  cn_for_each_port_policy "${port_policies}" cn_render_iptables_port_policy_rules
  if [[ "${has_global}" == "true" ]]; then
    printf 'iptables -A %s -m set --match-set %s src -j ACCEPT\n' "${CN_CHAIN_NAME}" "${CN_SET_NAME}"
    printf 'iptables -A %s -j REJECT\n' "${CN_CHAIN_NAME}"
  fi
}

cn_iptables_port_spec() {
  local spec="$1"
  printf '%s\n' "${spec/-/:}"
}

cn_render_iptables_port_policy_set() {
  local index="$1"
  local _port_spec="$2"
  local selectors="$3"
  local set_name="${CN_SET_NAME}_port_${index}"
  local cidrs cidr
  cidrs="$(cn_collect_selector_cidrs "${selectors}")" || return 1
  if [[ -z "${cidrs}" ]]; then
    echo "端口策略 ${index} 没有可用 IPv4 CIDR 段。" >&2
    return 1
  fi
  printf 'ipset create %s hash:net family inet -exist\n' "${set_name}"
  printf 'ipset flush %s\n' "${set_name}"
  while IFS= read -r cidr; do
    [[ -n "${cidr}" ]] || continue
    printf 'ipset add %s %s -exist\n' "${set_name}" "${cidr}"
  done <<<"${cidrs}"
}

cn_render_iptables_port_policy_rules() {
  local index="$1"
  local port_spec="$2"
  local _selectors="$3"
  local set_name="${CN_SET_NAME}_port_${index}"
  local iptables_port
  iptables_port="$(cn_iptables_port_spec "${port_spec}")"
  printf 'iptables -A %s -p tcp -m conntrack --ctstate DNAT --ctorigdstport %s -m set --match-set %s src -j ACCEPT\n' "${CN_CHAIN_NAME}" "${iptables_port}" "${set_name}"
  printf 'iptables -A %s -p udp -m conntrack --ctstate DNAT --ctorigdstport %s -m set --match-set %s src -j ACCEPT\n' "${CN_CHAIN_NAME}" "${iptables_port}" "${set_name}"
  printf 'iptables -A %s -p tcp -m conntrack --ctstate DNAT --ctorigdstport %s -j REJECT\n' "${CN_CHAIN_NAME}" "${iptables_port}"
  printf 'iptables -A %s -p udp -m conntrack --ctstate DNAT --ctorigdstport %s -j REJECT\n' "${CN_CHAIN_NAME}" "${iptables_port}"
  printf 'iptables -A %s -p tcp -m conntrack ! --ctstate DNAT --dport %s -m set --match-set %s src -j ACCEPT\n' "${CN_CHAIN_NAME}" "${iptables_port}" "${set_name}"
  printf 'iptables -A %s -p udp -m conntrack ! --ctstate DNAT --dport %s -m set --match-set %s src -j ACCEPT\n' "${CN_CHAIN_NAME}" "${iptables_port}" "${set_name}"
  printf 'iptables -A %s -p tcp -m conntrack ! --ctstate DNAT --dport %s -j REJECT\n' "${CN_CHAIN_NAME}" "${iptables_port}"
  printf 'iptables -A %s -p udp -m conntrack ! --ctstate DNAT --dport %s -j REJECT\n' "${CN_CHAIN_NAME}" "${iptables_port}"
}

cn_render_apply_commands_nft() {
  local client_ip="${1:-}"
  local forward_mode="${2:-all}"
  local forward_ifaces="${3:-}"
  local asns="${4:-}"
  local port_policies="${5:-}"
  shift 5 || true

  cn_validate_forward_selection "${forward_mode}" "${forward_ifaces}" || return 1
  cn_validate_port_policies "${port_policies}" || return 1
  cn_for_each_port_policy "${port_policies}" cn_preflight_port_policy || return 1

  local cidrs iface has_global="false"
  cidrs="$(cn_collect_allowed_cidrs "${asns}" "$@")" || return 1

  if [[ -n "${client_ip}" ]]; then
    if ! cn_validate_client_ip "${client_ip}"; then
      echo "非法客户端 IP：${client_ip}" >&2
      return 1
    fi
    if cn_is_ipv4_address "${client_ip}"; then
      if cn_is_ipv4_covered_by_cidrs "${client_ip}" "${cidrs}"; then
        echo "客户端 IPv4 已被现有 nft 白名单覆盖，跳过重复加入：${client_ip}" >&2
      else
        cidrs="${cidrs}"$'\n'"${client_ip}"
      fi
    else
      echo "nft 后端当前只托管 IPv4 白名单，已跳过 IPv6 客户端临时白名单：${client_ip}" >&2
    fi
  fi
  cidrs="$(cn_normalize_ipv4_cidrs_for_nft <<<"${cidrs}")"
  if [[ -n "$(cn_trim "${cidrs}")" ]]; then
    has_global="true"
  elif [[ -z "$(cn_trim "${port_policies}")" ]]; then
    echo "请至少配置一项全局白名单或端口白名单。" >&2
    return 1
  fi

  printf 'nft delete table inet %s 2>/dev/null || true\n' "${CN_NFT_TABLE}"
  printf "nft -f - <<'NFT'\n"
  printf 'table inet %s {\n' "${CN_NFT_TABLE}"
  if [[ "${has_global}" == "true" ]]; then
    cn_render_nft_ip_set_definition "${CN_NFT_SET_NAME}" "${cidrs}" "  "
  fi
  cn_for_each_port_policy "${port_policies}" cn_render_nft_port_policy_sets

  printf '  chain input {\n'
  printf '    type filter hook input priority %s; policy accept;\n' "${CN_NFT_HOOK_PRIORITY}"
  printf '    iifname "lo" accept\n'
  printf '    ct state established,related accept\n'
  cn_for_each_port_policy "${port_policies}" cn_render_nft_port_policy_input_rules
  if [[ "${has_global}" == "true" ]]; then
    printf '    ip saddr @%s accept\n' "${CN_NFT_SET_NAME}"
    printf '    meta nfproto ipv4 reject\n'
  fi
  printf '  }\n'

  if [[ "${forward_mode}" != "none" ]]; then
    printf '  chain forward {\n'
    printf '    type filter hook forward priority %s; policy accept;\n' "${CN_NFT_HOOK_PRIORITY}"
    printf '    ct state established,related accept\n'
    cn_for_each_port_policy "${port_policies}" cn_render_nft_port_policy_forward_rules
    if [[ "${has_global}" == "true" ]]; then
      if [[ "${forward_mode}" == "selected" ]]; then
        for iface in ${forward_ifaces}; do
          printf '    iifname "%s" ct status dnat ip saddr @%s accept\n' "${iface}" "${CN_NFT_SET_NAME}"
          printf '    iifname "%s" ct status dnat meta nfproto ipv4 reject\n' "${iface}"
          printf '    oifname "%s" ct status dnat ip saddr @%s accept\n' "${iface}" "${CN_NFT_SET_NAME}"
          printf '    oifname "%s" ct status dnat meta nfproto ipv4 reject\n' "${iface}"
        done
      else
        printf '    ct status dnat ip saddr @%s accept\n' "${CN_NFT_SET_NAME}"
        printf '    ct status dnat meta nfproto ipv4 reject\n'
      fi
    fi
    printf '  }\n'
  fi
  printf '}\n'
  printf 'NFT\n'
}

cn_render_nft_port_policy_sets() {
  local index="$1"
  local port_spec="$2"
  local selectors="$3"
  local cidrs
  cidrs="$(cn_collect_selector_cidrs "${selectors}")" || return 1
  if [[ -z "${cidrs}" ]]; then
    echo "端口策略 ${index} 没有可用 IPv4 CIDR 段。" >&2
    return 1
  fi
  cidrs="$(cn_normalize_ipv4_cidrs_for_nft <<<"${cidrs}")"
  cn_render_nft_port_set_definition "port_policy_${index}_ports" "${port_spec}" "  "
  cn_render_nft_ip_set_definition "port_policy_${index}_v4" "${cidrs}" "  "
}

cn_render_nft_port_policy_input_rules() {
  local index="$1"
  local _port_spec="$2"
  local _selectors="$3"
  printf '    tcp dport @port_policy_%s_ports ip saddr @port_policy_%s_v4 accept\n' "${index}" "${index}"
  printf '    udp dport @port_policy_%s_ports ip saddr @port_policy_%s_v4 accept\n' "${index}" "${index}"
  printf '    tcp dport @port_policy_%s_ports meta nfproto ipv4 reject\n' "${index}"
  printf '    udp dport @port_policy_%s_ports meta nfproto ipv4 reject\n' "${index}"
}

cn_render_nft_port_policy_forward_rules() {
  local index="$1"
  local _port_spec="$2"
  local _selectors="$3"
  printf '    ct status dnat ct original proto-dst @port_policy_%s_ports ip saddr @port_policy_%s_v4 accept\n' "${index}" "${index}"
  printf '    ct status dnat ct original proto-dst @port_policy_%s_ports meta nfproto ipv4 reject\n' "${index}"
}

cn_render_clear_commands() {
  local backend
  backend="$(cn_effective_firewall_backend)" || return 1
  case "${backend}" in
    nft)
      printf 'nft delete table inet %s 2>/dev/null || true\n' "${CN_NFT_TABLE}"
      ;;
    iptables)
      cn_remove_jump_command INPUT
      cn_remove_jump_command FORWARD
      printf 'iptables -F %s 2>/dev/null || true\n' "${CN_CHAIN_NAME}"
      printf 'iptables -X %s 2>/dev/null || true\n' "${CN_CHAIN_NAME}"
      printf 'ipset list -name 2>/dev/null | awk '\''$0 == "%s" || $0 ~ /^%s_port_[0-9]+$/ { print "ipset destroy " $0 " 2>/dev/null || true" }'\'' | sh\n' "${CN_SET_NAME}" "${CN_SET_NAME}"
      ;;
  esac
}

cn_render_best_effort_clear_commands() {
  printf 'command -v nft >/dev/null 2>&1 && nft delete table inet %s 2>/dev/null || true\n' "${CN_NFT_TABLE}"
  printf 'if command -v iptables >/dev/null 2>&1; then\n'
  cn_remove_jump_command INPUT
  cn_remove_jump_command FORWARD
  printf 'iptables -F %s 2>/dev/null || true\n' "${CN_CHAIN_NAME}"
  printf 'iptables -X %s 2>/dev/null || true\n' "${CN_CHAIN_NAME}"
  printf 'fi\n'
  printf 'if command -v ipset >/dev/null 2>&1; then\n'
  printf 'ipset list -name 2>/dev/null | awk '\''$0 == "%s" || $0 ~ /^%s_port_[0-9]+$/ { print "ipset destroy " $0 " 2>/dev/null || true" }'\'' | sh\n' "${CN_SET_NAME}" "${CN_SET_NAME}"
  printf 'fi\n'
}

cn_save_config() {
  cn_require_root
  local forward_mode="$1"
  local forward_ifaces="$2"
  local asns="$3"
  local port_policies="$4"
  shift 4 || true
  local -a codes=("$@")
  if [[ "${#codes[@]}" -eq 0 && -z "$(cn_trim "${asns}")" && -z "$(cn_trim "${port_policies}")" ]]; then
    echo "请至少配置一项全局白名单或端口白名单。" >&2
    return 1
  fi
  case "${forward_mode}" in
    all|none|selected) ;;
    *)
      echo "未知转发接口模式：${forward_mode}" >&2
      return 1
      ;;
  esac
  cn_validate_port_policies "${port_policies}" || return 1

  mkdir -p "$(dirname "${CN_CONFIG_FILE}")"
  {
    echo "# Generated by china-region-whitelist. CN_CODES may contain CN or province codes."
    printf 'CN_CODES="%s"\n' "${codes[*]}"
    printf 'CN_ASNS="%s"\n' "${asns}"
    printf 'CN_PORT_POLICIES=%q\n' "${port_policies}"
    printf 'CN_FORWARD_MODE="%s"\n' "${forward_mode}"
    printf 'CN_FORWARD_IFACES="%s"\n' "${forward_ifaces}"
    printf 'CN_FIREWALL_BACKEND="%s"\n' "$(cn_effective_firewall_backend)"
    printf 'CN_ROOT="%s"\n' "${CN_ROOT}"
    printf 'CN_RUNTIME_DIR="%s"\n' "${CN_RUNTIME_DIR}"
    printf 'CN_ASN_CACHE_DIR="%s"\n' "${CN_ASN_CACHE_DIR}"
  } > "${CN_CONFIG_FILE}"
  chmod 0644 "${CN_CONFIG_FILE}"
}

cn_source_config() {
  if [[ ! -r "${CN_CONFIG_FILE}" ]]; then
    echo "未找到配置文件：${CN_CONFIG_FILE}，请先运行 apply。" >&2
    return 1
  fi

  # shellcheck disable=SC1090
  source "${CN_CONFIG_FILE}"
}

cn_load_config_codes() {
  cn_source_config
  local code
  for code in ${CN_CODES}; do
    if cn_is_all_china_selector "${code}"; then
      printf 'CN\n'
      continue
    fi
    if ! [[ "${code}" =~ ^[0-9]{6}$ ]]; then
      echo "配置文件中存在非法全局白名单代码：${code}" >&2
      return 1
    fi
    printf '%s\n' "${code}"
  done
}

cn_load_config_forward_mode() {
  cn_source_config
  printf '%s\n' "${CN_FORWARD_MODE:-all}"
}

cn_load_config_asns() {
  cn_source_config
  local raw_asn asn
  for raw_asn in ${CN_ASNS:-}; do
    asn="$(cn_normalize_asn "${raw_asn}")" || return 1
    printf 'AS%s\n' "${asn}"
  done
}

cn_load_config_port_policies() {
  cn_source_config
  printf '%s\n' "${CN_PORT_POLICIES:-}"
}

cn_load_config_forward_ifaces() {
  cn_source_config
  local iface
  for iface in ${CN_FORWARD_IFACES:-}; do
    cn_validate_interface_name "${iface}" || return 1
    printf '%s\n' "${iface}"
  done
}

cn_install_systemd_service() {
  cn_require_root
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "未检测到 systemd，已应用当前规则，但无法自动配置开机恢复。" >&2
    return 0
  fi

  local service_path="/etc/systemd/system/${CN_SERVICE_NAME}"
  cat > "${service_path}" <<EOF
[Unit]
Description=china region whitelist firewall
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash ${CN_ROOT}/install.sh restore --offline

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${CN_SERVICE_NAME}"
}

cn_disable_systemd_service() {
  cn_require_root
  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop "${CN_SERVICE_NAME}" >/dev/null 2>&1 || true
    systemctl disable "${CN_SERVICE_NAME}" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${CN_SERVICE_NAME}"
    systemctl daemon-reload || true
  fi
  rm -f "${CN_CONFIG_FILE}"
}

cn_show_persistence_status() {
  echo
  echo "== persistence =="
  if [[ -r "${CN_CONFIG_FILE}" ]]; then
    echo "config: ${CN_CONFIG_FILE}"
    # shellcheck disable=SC1090
    source "${CN_CONFIG_FILE}"
    echo "regions: ${CN_CODES:-未配置}"
    echo "asns: ${CN_ASNS:-未配置}"
    echo "port policies: ${CN_PORT_POLICIES:-未配置}"
    echo "backend: ${CN_FIREWALL_BACKEND:-auto}"
    echo "forward: ${CN_FORWARD_MODE:-all}${CN_FORWARD_IFACES:+ (${CN_FORWARD_IFACES})}"
  else
    echo "config: 未配置"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-enabled "${CN_SERVICE_NAME}" 2>/dev/null || true
  else
    echo "systemd: 未检测到"
  fi
}

cn_require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "此操作需要 root 权限，请使用 sudo 或 root 用户运行。" >&2
    exit 1
  fi
}

cn_dependency_packages() {
  local backend="$1"
  case "${backend}" in
    nft) printf '%s\n' "nftables" ;;
    iptables) printf '%s\n' "iptables ipset" ;;
  esac
}

cn_install_dependencies() {
  local backend="$1"
  local packages
  packages="$(cn_dependency_packages "${backend}")"
  echo "检测到缺少 ${packages}，开始使用系统默认软件源自动安装..." >&2

  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    # shellcheck disable=SC2086
    apt-get install -y ${packages}
  elif command -v dnf >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    dnf install -y ${packages}
  elif command -v yum >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    yum install -y ${packages}
  elif command -v apk >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    apk add --no-cache ${packages}
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive refresh || true
    # shellcheck disable=SC2086
    zypper --non-interactive install ${packages}
  else
    echo "未识别到 apt-get/dnf/yum/apk/zypper，无法自动安装 ${packages}。" >&2
    return 1
  fi
}

cn_require_commands() {
  local backend command_name
  backend="$(cn_effective_firewall_backend)" || exit 1
  local missing=0
  local -a required_commands=()
  case "${backend}" in
    nft) required_commands=(nft) ;;
    iptables) required_commands=(iptables ipset) ;;
  esac

  for command_name in "${required_commands[@]}"; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      echo "缺少命令：${command_name}" >&2
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    cn_install_dependencies "${backend}" || {
      echo "自动安装失败，请检查系统软件源后重试。" >&2
      exit 1
    }
  fi

  missing=0
  for command_name in "${required_commands[@]}"; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      echo "安装后仍缺少命令：${command_name}" >&2
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    echo "依赖未安装完整，请检查系统软件源或包名。" >&2
    exit 1
  fi
}

cn_detect_ssh_client_ip() {
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    awk '{print $1}' <<<"${SSH_CONNECTION}"
  else
    true
  fi
}

cn_validate_interface_name() {
  local iface="$1"
  if [[ "${iface}" =~ ^[A-Za-z0-9_.:-]{1,64}\+?$ ]]; then
    return 0
  fi
  echo "非法接口名：${iface}" >&2
  return 1
}

cn_list_network_interfaces() {
  if command -v ip >/dev/null 2>&1; then
    ip -o link show | awk -F': ' '{print $2}' | sed 's/@.*//' | sort -u
  elif [[ -d /sys/class/net ]]; then
    local iface_path
    for iface_path in /sys/class/net/*; do
      [[ -e "${iface_path}" ]] || continue
      basename "${iface_path}"
    done | sort -u
  fi
}

cn_is_tunnel_interface() {
  local iface="$1"
  if [[ -e "/sys/class/net/${iface}/tun_flags" ]]; then
    return 0
  fi
  case "${iface}" in
    tun*|tap*|wg*|tailscale*|ts*|zt*|utun*|warp*|nebula*|mihomo*|sing*|clash*)
      return 0
      ;;
  esac
  return 1
}

cn_list_tunnel_interfaces() {
  local iface
  while IFS= read -r iface; do
    [[ -n "${iface}" ]] || continue
    cn_is_tunnel_interface "${iface}" && printf '%s\n' "${iface}"
  done < <(cn_list_network_interfaces)
}

cn_run_rendered_commands() {
  local script_file command_line in_nft_batch=0 status
  script_file="$(mktemp)"
  {
    echo "set -euo pipefail"
    cat
  } > "${script_file}"
  while IFS= read -r command_line; do
    [[ -z "${command_line}" ]] && continue
    if [[ "${in_nft_batch}" -eq 1 ]]; then
      if [[ "${command_line}" == "NFT" ]]; then
        in_nft_batch=0
      fi
      continue
    fi
    echo "+ ${command_line}"
    if [[ "${command_line}" == "nft -f - <<'NFT'" ]]; then
      echo "+ [nft 批量规则内容已省略]"
      in_nft_batch=1
    fi
  done < "${script_file}"
  if bash "${script_file}"; then
    status=0
  else
    status=$?
  fi
  rm -f "${script_file}"
  return "${status}"
}
