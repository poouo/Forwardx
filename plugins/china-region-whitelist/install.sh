#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${ROOT}/tools/firewall_lib.sh"
exec 3<&0

usage() {
  cat <<'EOF'
中国大陆省份白名单一键脚本

用法：
  ./install.sh apply [--offline|--update|--update-optional]
                         交互选择整机白名单和端口优先白名单、应用防火墙并配置开机恢复
  ./install.sh dry-run [--offline|--update|--update-optional]
                         交互选择整机白名单和端口优先白名单，只打印将执行的命令
  ./install.sh restore [--offline|--update|--update-optional]
                         使用上次保存的省份配置重新应用规则
  ./install.sh update-data
                         从 GitHub 同步最新预制 IP 数据到 /var/lib/china-region-whitelist
  ./install.sh update-asn
                         重新同步已保存的 ASN 白名单并恢复规则
  ./install.sh status    查看当前托管规则和开机恢复状态
  ./install.sh clear     清除本脚本创建的规则、保存配置和 systemd 服务

说明：
  apply 会让未命中白名单的所有入站端口全部拒绝。
  默认整机托管本机 INPUT 和 DNAT 入站转发流量，包含 flvx/nftables 端口转发。
  可为单端口或端口范围设置更高优先级的白名单。
  使用 flvx/nftables 转发时，建议保留默认 nft 后端；本脚本会使用独立 nft 表，不会改写 flvx 表。
  apply/dry-run 默认使用仓库内置数据；加 --update 会从 GitHub 拉取最新预制数据，不需要 Python。
  建议先运行 dry-run，确认省份和命令后再 apply。
EOF
}

pick_by_indices() {
  local prompt="$1"
  local max="$2"
  local input
  while true; do
    read -r -p "${prompt}" input
    input="${input//,/ }"
    [[ -n "${input}" ]] || continue
    local ok=1
    for value in ${input}; do
      if ! [[ "${value}" =~ ^[0-9]+$ ]] || (( value < 1 || value > max )); then
        ok=0
      fi
    done
    if [[ "${ok}" -eq 1 ]]; then
      echo "${input}"
      return
    fi
    echo "输入无效，请输入 1-${max} 范围内的编号，可用空格或逗号分隔。"
  done
}

split_user_list() {
  local input="$1"
  input="${input//,/ }"
  input="${input//，/ }"
  input="${input//、/ }"
  printf '%s\n' "${input}" | tr '[:space:]' '\n'
}

read_from_tty() {
  local prompt="$1"
  local value
  if [[ "${CN_READ_FROM_STDIN:-0}" != "1" && -r /dev/tty && ( -t 0 || -t 2 ) ]]; then
    read -r -p "${prompt}" value < /dev/tty
  else
    printf '%s' "${prompt}" >&2
    read -r value <&3 || value=""
  fi
  printf '%s\n' "${value}"
}

visual_menu_available() {
  [[ "${CN_VISUAL_MENU:-1}" != "0" && -r /dev/tty && ( -t 0 || -t 2 ) && "${TERM:-}" != "dumb" ]]
}

visual_clear_screen() {
  printf '\033[H\033[J' >&2
}

visual_read_key() {
  local key rest
  IFS= read -rsn1 key < /dev/tty || key=""
  if [[ "${key}" == $'\x1b' ]]; then
    IFS= read -rsn2 -t 1 rest < /dev/tty || rest=""
    key+="${rest}"
  fi
  printf '%s' "${key}"
}

visual_multi_select() {
  local title="$1"
  local allow_empty="$2"
  shift 2
  VISUAL_SELECTED_VALUES=()
  VISUAL_SELECTED_LABELS=()

  local -a labels values checked
  while (($# > 0)); do
    labels+=("$1")
    values+=("$2")
    checked+=(0)
    shift 2
  done

  local current=0
  local key selected_count i cursor mark
  while true; do
    visual_clear_screen
    printf '%s\n' "${title}" >&2
    printf '上/下键移动，空格勾选，回车确认。A 全选，C 清空。\n\n' >&2
    for ((i = 0; i < ${#labels[@]}; i++)); do
      cursor=" "
      [[ "${i}" -eq "${current}" ]] && cursor=">"
      mark="[ ]"
      [[ "${checked[$i]}" -eq 1 ]] && mark="[x]"
      printf '%s %s %s\n' "${cursor}" "${mark}" "${labels[$i]}" >&2
    done

    key="$(visual_read_key)"
    case "${key}" in
      $'\x1b[A'|k|K)
        ((current > 0)) && current=$((current - 1))
        ;;
      $'\x1b[B'|j|J)
        ((current < ${#labels[@]} - 1)) && current=$((current + 1))
        ;;
      " ")
        if [[ "${checked[$current]}" -eq 1 ]]; then
          checked[$current]=0
        else
          checked[$current]=1
        fi
        ;;
      a|A)
        for ((i = 0; i < ${#checked[@]}; i++)); do
          checked[$i]=1
        done
        ;;
      c|C)
        for ((i = 0; i < ${#checked[@]}; i++)); do
          checked[$i]=0
        done
        ;;
      "")
        selected_count=0
        for ((i = 0; i < ${#checked[@]}; i++)); do
          [[ "${checked[$i]}" -eq 1 ]] && selected_count=$((selected_count + 1))
        done
        if [[ "${selected_count}" -eq 0 && "${allow_empty}" != "1" ]]; then
          printf '\n至少选择一项，按任意键继续。' >&2
          IFS= read -rsn1 _ < /dev/tty || true
          continue
        fi
        for ((i = 0; i < ${#checked[@]}; i++)); do
          if [[ "${checked[$i]}" -eq 1 ]]; then
            VISUAL_SELECTED_VALUES+=("${values[$i]}")
            VISUAL_SELECTED_LABELS+=("${labels[$i]}")
          fi
        done
        visual_clear_screen
        return 0
        ;;
    esac
  done
}

visual_single_select() {
  local title="$1"
  shift
  VISUAL_SELECTED_VALUE=""
  VISUAL_SELECTED_LABEL=""

  local -a labels values
  while (($# > 0)); do
    labels+=("$1")
    values+=("$2")
    shift 2
  done

  local current=0
  local key i cursor
  while true; do
    visual_clear_screen
    printf '%s\n' "${title}" >&2
    printf '上/下键移动，回车确认。\n\n' >&2
    for ((i = 0; i < ${#labels[@]}; i++)); do
      cursor=" "
      [[ "${i}" -eq "${current}" ]] && cursor=">"
      printf '%s %s\n' "${cursor}" "${labels[$i]}" >&2
    done

    key="$(visual_read_key)"
    case "${key}" in
      $'\x1b[A'|k|K)
        ((current > 0)) && current=$((current - 1))
        ;;
      $'\x1b[B'|j|J)
        ((current < ${#labels[@]} - 1)) && current=$((current + 1))
        ;;
      ""|" ")
        VISUAL_SELECTED_VALUE="${values[$current]}"
        VISUAL_SELECTED_LABEL="${labels[$current]}"
        visual_clear_screen
        return 0
        ;;
    esac
  done
}

load_province_menu_options() {
  PROVINCE_MENU_LABELS=()
  PROVINCE_MENU_CODES=()
  PROVINCE_MENU_NAMES=()

  local index province_code name
  while IFS=$'\t' read -r index province_code name; do
    PROVINCE_MENU_LABELS+=("${index}. ${name}")
    PROVINCE_MENU_CODES+=("${province_code}")
    PROVINCE_MENU_NAMES+=("${name}")
  done < <(cn_list_provinces)
}

append_unique_selected_code() {
  local candidate="$1"
  local existing
  if cn_is_all_china_selector "${candidate}"; then
    SELECTED_CODES=("CN")
    return 0
  fi
  if ((${#SELECTED_CODES[@]} > 0)); then
    for existing in "${SELECTED_CODES[@]}"; do
      cn_is_all_china_selector "${existing}" && return 0
      [[ "${existing}" == "${candidate}" ]] && return 0
    done
  fi
  SELECTED_CODES+=("${candidate}")
}

join_by_delim() {
  local delim="$1"
  shift
  local out="" item
  for item in "$@"; do
    [[ -n "${item}" ]] || continue
    if [[ -z "${out}" ]]; then
      out="${item}"
    else
      out+="${delim}${item}"
    fi
  done
  printf '%s\n' "${out}"
}

join_by_comma() {
  join_by_delim "," "$@"
}

join_by_semicolon() {
  join_by_delim ";" "$@"
}

codes_summary() {
  local -a codes=("$@")
  if [[ "${#codes[@]}" -eq 1 ]] && cn_is_all_china_selector "${codes[0]}"; then
    printf '全国'
  else
    printf '%s 个省份' "${#codes[@]}"
  fi
}

asns_summary() {
  local -a asns=("$@")
  if [[ "${#asns[@]}" -eq 0 ]]; then
    printf '未配置'
  else
    printf '%s' "$(join_by_delim " " "${asns[@]}")"
  fi
}

port_policies_summary() {
  local -a policies=("$@")
  if [[ "${#policies[@]}" -eq 0 ]]; then
    printf '未配置'
  else
    printf '%s 条' "${#policies[@]}"
  fi
}

code_at_index() {
  local rows="$1"
  local index="$2"
  awk -F '\t' -v wanted="${index}" '$1 == wanted {print $2}' <<<"${rows}"
}

interactive_select_codes() {
  SELECTED_CODES=()
  if visual_menu_available; then
    load_province_menu_options
    local -a menu_items
    local province_value i
    menu_items=("全国（中国大陆 CN）" "__ALL__")
    for ((i = 0; i < ${#PROVINCE_MENU_LABELS[@]}; i++)); do
      menu_items+=("${PROVINCE_MENU_LABELS[$i]}" "${PROVINCE_MENU_CODES[$i]}")
    done

    visual_multi_select "请选择整机默认白名单省份" 0 "${menu_items[@]}"
    for province_value in "${VISUAL_SELECTED_VALUES[@]}"; do
      if [[ "${province_value}" == "__ALL__" ]]; then
        append_unique_selected_code "CN"
      else
        append_unique_selected_code "${province_value}"
      fi
    done
    return
  fi

  echo "请选择省/自治区/直辖市：" >&2
  cn_show_provinces >&2
  echo >&2
  echo "输入编号或省份名称，多个用空格/逗号分隔；输入 全国 表示中国大陆 CN 国家级 IP。" >&2

  local province_input
  province_input="$(read_from_tty "省份: ")"
  [[ -n "${province_input}" ]] || {
    echo "未输入省份。" >&2
    exit 1
  }

  local province_selector province_code
  while IFS= read -r province_selector; do
    [[ -n "${province_selector}" ]] || continue
    if cn_is_all_china_selector "${province_selector}"; then
      append_unique_selected_code "CN"
    else
      province_code="$(cn_resolve_province "${province_selector}")"
      append_unique_selected_code "${province_code}"
    fi
  done < <(split_user_list "${province_input}")
}

interactive_select_asns() {
  SELECTED_ASNS=()
  if visual_menu_available; then
    visual_single_select \
      "额外 ASN 白名单" \
      "不添加 ASN 白名单" "skip" \
      "输入 ASN 白名单" "input"
    [[ "${VISUAL_SELECTED_VALUE}" == "skip" ]] && return 0
  fi

  echo >&2
  echo "可选：额外 ASN 白名单，用于国外管理机或固定云厂商入口。" >&2
  echo "例如：AS16509 AS14061。留空则不添加 ASN 白名单。" >&2

  local asn_input asn_selector asn
  asn_input="$(read_from_tty "额外 ASN（可空）: ")"
  [[ -n "${asn_input}" ]] || return 0

  while IFS= read -r asn_selector; do
    [[ -n "${asn_selector}" ]] || continue
    asn="$(cn_normalize_asn "${asn_selector}")"
    SELECTED_ASNS+=("AS${asn}")
  done < <(split_user_list "${asn_input}")
}

read_manual_port_policies() {
  local prompt="${1:-端口优先白名单（可空）: }"
  local policy_input
  policy_input="$(read_from_tty "${prompt}")"
  policy_input="${policy_input//；/;}"
  [[ -n "$(cn_trim "${policy_input}")" ]] || {
    SELECTED_PORT_POLICIES=""
    return 0
  }
  cn_validate_port_policies "${policy_input}"
  SELECTED_PORT_POLICIES="${policy_input}"
}

interactive_select_port_policies_line() {
  echo >&2
  echo "可选：端口优先白名单。命中端口策略时，会先按该端口自己的白名单判断。" >&2
  echo "格式：端口=白名单；多条用英文或中文分号分隔。" >&2
  echo "示例：22=上海市,AS16509,1.2.3.4/32;10000-20000=广东省,江苏省" >&2
  echo "白名单可写：全国/中国、具体省份、AS12345、IPv4 或 IPv4 CIDR。留空则只使用整机默认白名单。" >&2
  read_manual_port_policies "端口优先白名单（可空）: "
}

normalize_extra_policy_selectors() {
  EXTRA_POLICY_SELECTORS=()
  local extra_input="$1"
  local selector asn
  while IFS= read -r selector; do
    selector="$(cn_trim "${selector}")"
    [[ -n "${selector}" ]] || continue
    if [[ "${selector}" =~ ^[Aa][Ss][0-9]+$ ]]; then
      asn="$(cn_normalize_asn "${selector}")"
      EXTRA_POLICY_SELECTORS+=("AS${asn}")
    elif cn_validate_ipv4_cidr "${selector}"; then
      EXTRA_POLICY_SELECTORS+=("${selector}")
    else
      echo "额外白名单只支持 ASN、IPv4 或 IPv4 CIDR：${selector}" >&2
      return 1
    fi
  done < <(split_user_list "${extra_input}")
}

build_port_policy_visual() {
  PORT_POLICY_ITEM=""
  local port_spec extra_input selector_text i
  local -a menu_items selectors

  while true; do
    port_spec="$(read_from_tty "端口或端口范围，例如 22 或 10000-20000: ")"
    if cn_validate_port_spec "${port_spec}"; then
      break
    fi
    echo "非法端口或端口范围：${port_spec}" >&2
  done

  load_province_menu_options
  menu_items=("全国（中国大陆 CN）" "全国")
  for ((i = 0; i < ${#PROVINCE_MENU_LABELS[@]}; i++)); do
    menu_items+=("${PROVINCE_MENU_LABELS[$i]}" "${PROVINCE_MENU_NAMES[$i]}")
  done
  visual_multi_select "请选择端口 ${port_spec} 允许的国内省份（可空，后续可输入 ASN/IP）" 1 "${menu_items[@]}"
  selectors=("${VISUAL_SELECTED_VALUES[@]}")

  extra_input="$(read_from_tty "额外 ASN/IP/CIDR（可空，多个用空格或逗号分隔）: ")"
  if [[ -n "$(cn_trim "${extra_input}")" ]]; then
    normalize_extra_policy_selectors "${extra_input}"
    selectors+=("${EXTRA_POLICY_SELECTORS[@]}")
  fi

  if [[ "${#selectors[@]}" -eq 0 ]]; then
    echo "端口策略至少需要一个省份、ASN、IPv4 或 CIDR 白名单。" >&2
    return 1
  fi

  selector_text="$(join_by_comma "${selectors[@]}")"
  PORT_POLICY_ITEM="${port_spec}=${selector_text}"
  cn_validate_port_policies "${PORT_POLICY_ITEM}"
}

interactive_select_port_policies() {
  SELECTED_PORT_POLICIES=""
  if ! visual_menu_available; then
    interactive_select_port_policies_line
    return
  fi

  local -a policies
  local done_label
  policies=()
  while true; do
    if [[ "${#policies[@]}" -eq 0 ]]; then
      done_label="完成，不添加端口优先白名单"
    else
      done_label="完成，使用已添加的 ${#policies[@]} 条端口策略"
    fi
    visual_single_select \
      "端口优先白名单" \
      "添加一条端口策略" "add" \
      "手动输入完整策略" "manual" \
      "${done_label}" "done"
    case "${VISUAL_SELECTED_VALUE}" in
      add)
        if build_port_policy_visual; then
          policies+=("${PORT_POLICY_ITEM}")
          printf '已添加：%s\n' "${PORT_POLICY_ITEM}" >&2
          read_from_tty "按回车继续..." >/dev/null
        fi
        ;;
      manual)
        read_manual_port_policies "完整端口策略（可空）: "
        return
        ;;
      done)
        if ((${#policies[@]} > 0)); then
          SELECTED_PORT_POLICIES="$(join_by_semicolon "${policies[@]}")"
        else
          SELECTED_PORT_POLICIES=""
        fi
        return
        ;;
    esac
  done
}

pause_visual() {
  local message="${1:-按回车返回...}"
  read_from_tty "${message}" >/dev/null
}

codes_detail() {
  local -a codes=("$@")
  local -a names
  local code name
  if [[ "${#codes[@]}" -eq 1 ]] && cn_is_all_china_selector "${codes[0]}"; then
    printf '全国'
    return
  fi
  names=()
  for code in "${codes[@]}"; do
    name="$(cn_province_name "${code}")"
    names+=("${name:-${code}}")
  done
  join_by_delim " " "${names[@]}"
}

edit_global_codes_visual() {
  interactive_select_codes
  CONFIG_CODES=()
  if ((${#SELECTED_CODES[@]} > 0)); then
    CONFIG_CODES=("${SELECTED_CODES[@]}")
  fi
}

edit_global_asns_visual() {
  interactive_select_asns
  CONFIG_ASNS=()
  if ((${#SELECTED_ASNS[@]} > 0)); then
    CONFIG_ASNS=("${SELECTED_ASNS[@]}")
  fi
}

set_config_port_policies_from_text() {
  local policies="$1"
  local raw_policy
  local -a policy_items next
  CONFIG_PORT_POLICIES=()
  policies="${policies//；/;}"
  [[ -n "$(cn_trim "${policies}")" ]] || return 0
  cn_validate_port_policies "${policies}"
  IFS=';' read -r -a policy_items <<<"${policies}"
  next=()
  for raw_policy in "${policy_items[@]}"; do
    raw_policy="$(cn_trim "${raw_policy}")"
    [[ -n "${raw_policy}" ]] && next+=("${raw_policy}")
  done
  if ((${#next[@]} > 0)); then
    CONFIG_PORT_POLICIES=("${next[@]}")
  fi
}

manual_edit_port_policies_visual() {
  read_manual_port_policies "完整端口策略（可空）: "
  set_config_port_policies_from_text "${SELECTED_PORT_POLICIES}"
}

add_port_policy_visual() {
  if build_port_policy_visual; then
    CONFIG_PORT_POLICIES+=("${PORT_POLICY_ITEM}")
    printf '已添加：%s\n' "${PORT_POLICY_ITEM}" >&2
    pause_visual
  fi
}

choose_port_policy_index() {
  CHOSEN_PORT_POLICY_INDEX=""
  if [[ "${#CONFIG_PORT_POLICIES[@]}" -eq 0 ]]; then
    printf '当前没有端口白名单。\n' >&2
    pause_visual
    return 1
  fi

  local -a menu_items
  local i
  menu_items=()
  for ((i = 0; i < ${#CONFIG_PORT_POLICIES[@]}; i++)); do
    menu_items+=("$((i + 1)). ${CONFIG_PORT_POLICIES[$i]}" "${i}")
  done
  menu_items+=("取消" "cancel")
  visual_single_select "选择端口白名单" "${menu_items[@]}"
  [[ "${VISUAL_SELECTED_VALUE}" != "cancel" ]] || return 1
  CHOSEN_PORT_POLICY_INDEX="${VISUAL_SELECTED_VALUE}"
}

edit_port_policy_visual() {
  local index
  choose_port_policy_index || return 0
  index="${CHOSEN_PORT_POLICY_INDEX}"
  printf '正在修改：%s\n' "${CONFIG_PORT_POLICIES[$index]}" >&2
  if build_port_policy_visual; then
    CONFIG_PORT_POLICIES[$index]="${PORT_POLICY_ITEM}"
    printf '已修改为：%s\n' "${PORT_POLICY_ITEM}" >&2
    pause_visual
  fi
}

delete_port_policy_visual() {
  local index i
  local -a next
  choose_port_policy_index || return 0
  index="${CHOSEN_PORT_POLICY_INDEX}"
  next=()
  for ((i = 0; i < ${#CONFIG_PORT_POLICIES[@]}; i++)); do
    [[ "${i}" -eq "${index}" ]] && continue
    next+=("${CONFIG_PORT_POLICIES[$i]}")
  done
  if ((${#next[@]} > 0)); then
    CONFIG_PORT_POLICIES=("${next[@]}")
  else
    CONFIG_PORT_POLICIES=()
  fi
  printf '已删除端口白名单。\n' >&2
  pause_visual
}

config_editor_title() {
  local codes_text asns_text ports_text
  if [[ "${#CONFIG_CODES[@]}" -gt 0 ]]; then
    codes_text="$(codes_summary "${CONFIG_CODES[@]}")"
  else
    codes_text="未配置"
  fi
  if [[ "${#CONFIG_ASNS[@]}" -gt 0 ]]; then
    asns_text="$(asns_summary "${CONFIG_ASNS[@]}")"
  else
    asns_text="未配置"
  fi
  if [[ "${#CONFIG_PORT_POLICIES[@]}" -gt 0 ]]; then
    ports_text="$(port_policies_summary "${CONFIG_PORT_POLICIES[@]}")"
  else
    ports_text="未配置"
  fi
  cat <<EOF
白名单配置主界面

全局白名单：${codes_text}
全局 ASN：${asns_text}
端口白名单：${ports_text}

端口白名单优先于全局白名单生效。
EOF
}

show_config_visual() {
  visual_clear_screen
  printf '当前配置\n\n' >&2
  if [[ "${#CONFIG_CODES[@]}" -gt 0 ]]; then
    printf '全局白名单：%s\n' "$(codes_detail "${CONFIG_CODES[@]}")" >&2
  else
    printf '全局白名单：未配置\n' >&2
  fi
  if [[ "${#CONFIG_ASNS[@]}" -gt 0 ]]; then
    printf '全局 ASN：%s\n' "$(asns_summary "${CONFIG_ASNS[@]}")" >&2
  else
    printf '全局 ASN：未配置\n' >&2
  fi
  if [[ "${#CONFIG_PORT_POLICIES[@]}" -gt 0 ]]; then
    printf '端口白名单：\n' >&2
    local i
    for ((i = 0; i < ${#CONFIG_PORT_POLICIES[@]}; i++)); do
      printf '  %d. %s\n' "$((i + 1))" "${CONFIG_PORT_POLICIES[$i]}" >&2
    done
  else
    printf '端口白名单：未配置\n' >&2
  fi
  printf '\n端口白名单优先于全局白名单。\n' >&2
  pause_visual
}

confirm_clear_rules_visual() {
  visual_single_select \
    "确认清理本脚本已应用的规则和开机配置" \
    "取消，返回主界面" "no" \
    "清理规则、保存配置和 systemd 服务" "yes"
  [[ "${VISUAL_SELECTED_VALUE}" == "yes" ]]
}

update_region_data_visual() {
  visual_clear_screen
  printf '同步最新预制 IP 数据\n\n' >&2
  printf '将从 GitHub 仓库下载已预制好的 data/ 数据包。\n' >&2
  printf '服务器端不需要 Python；全国、省份和预制 ASN 数据由仓库定时生成。\n\n' >&2
  if [[ "${EUID}" -ne 0 ]]; then
    printf '此操作需要 root 权限，请使用 sudo 或 root 用户运行。\n' >&2
    pause_visual
    return 0
  fi
  if prepare_data_for_mode required; then
    printf '\n数据已同步到：%s/data\n' "${CN_RUNTIME_DIR}" >&2
  else
    printf '\n同步失败。请确认服务器可以访问 GitHub 或已设置可用的 CN_GITHUB_PROXY。\n' >&2
  fi
  pause_visual
}

load_saved_config_into_editor() {
  [[ -r "${CN_CONFIG_FILE}" ]] || return 0

  local item saved_ports
  CONFIG_CODES=()
  while IFS= read -r item; do
    [[ -n "${item}" ]] && CONFIG_CODES+=("${item}")
  done < <(cn_load_config_codes 2>/dev/null || true)

  CONFIG_ASNS=()
  while IFS= read -r item; do
    [[ -n "${item}" ]] && CONFIG_ASNS+=("${item}")
  done < <(cn_load_config_asns 2>/dev/null || true)

  CONFIG_PORT_POLICIES=()
  saved_ports="$(cn_load_config_port_policies 2>/dev/null || true)"
  if [[ -n "$(cn_trim "${saved_ports}")" ]]; then
    if ! set_config_port_policies_from_text "${saved_ports}" 2>/dev/null; then
      CONFIG_PORT_POLICIES=()
    fi
  fi
}

interactive_config_editor() {
  local dry_run="${1:-0}"
  CONFIG_CODES=()
  CONFIG_ASNS=()
  CONFIG_PORT_POLICIES=()
  load_saved_config_into_editor

  local title
  while true; do
    title="$(config_editor_title)"
    if [[ "${dry_run}" == "1" ]]; then
      visual_single_select \
        "${title}" \
        "编辑全局白名单（省份/全国）" "edit_global" \
        "编辑全局 ASN 白名单" "edit_asn" \
        "新增端口白名单" "add_port" \
        "修改端口白名单" "edit_port" \
        "删除端口白名单" "delete_port" \
        "手动编辑全部端口白名单" "manual_ports" \
        "查看当前配置" "view" \
        "同步最新预制 IP 数据" "update_data" \
        "完成并继续" "done"
    else
      visual_single_select \
        "${title}" \
        "编辑全局白名单（省份/全国）" "edit_global" \
        "编辑全局 ASN 白名单" "edit_asn" \
        "新增端口白名单" "add_port" \
        "修改端口白名单" "edit_port" \
        "删除端口白名单" "delete_port" \
        "手动编辑全部端口白名单" "manual_ports" \
        "查看当前配置" "view" \
        "同步最新预制 IP 数据" "update_data" \
        "清理已应用规则和开机配置" "clear_applied" \
        "完成并继续" "done"
    fi
    case "${VISUAL_SELECTED_VALUE}" in
      edit_global)
        edit_global_codes_visual
        ;;
      edit_asn)
        edit_global_asns_visual
        ;;
      add_port)
        add_port_policy_visual
        ;;
      edit_port)
        edit_port_policy_visual
        ;;
      delete_port)
        delete_port_policy_visual
        ;;
      manual_ports)
        manual_edit_port_policies_visual
        ;;
      view)
        show_config_visual
        ;;
      update_data)
        update_region_data_visual
        ;;
      clear_applied)
        if confirm_clear_rules_visual; then
          clear_rules
          exit 0
        fi
        ;;
      done)
        if [[ "${#CONFIG_CODES[@]}" -eq 0 ]]; then
          printf '请先配置全局白名单，至少选择一个省份或全国。\n' >&2
          pause_visual
          continue
        fi
        SELECTED_CODES=("${CONFIG_CODES[@]}")
        SELECTED_ASNS=()
        if ((${#CONFIG_ASNS[@]} > 0)); then
          SELECTED_ASNS=("${CONFIG_ASNS[@]}")
        fi
        if ((${#CONFIG_PORT_POLICIES[@]} > 0)); then
          SELECTED_PORT_POLICIES="$(join_by_semicolon "${CONFIG_PORT_POLICIES[@]}")"
        else
          SELECTED_PORT_POLICIES=""
        fi
        return
        ;;
    esac
  done
}

append_unique_forward_iface() {
  local candidate="$1"
  local existing
  if ((${#SELECTED_FORWARD_IFACES[@]} > 0)); then
    for existing in "${SELECTED_FORWARD_IFACES[@]}"; do
      [[ "${existing}" == "${candidate}" ]] && return 0
    done
  fi
  SELECTED_FORWARD_IFACES+=("${candidate}")
}

interactive_select_forward_interfaces() {
  SELECTED_FORWARD_MODE="${CN_FORWARD_MODE_DEFAULT:-all}"
  SELECTED_FORWARD_IFACES=()
  case "${SELECTED_FORWARD_MODE}" in
    all|"")
      SELECTED_FORWARD_MODE="all"
      echo >&2
      echo "整机白名单范围：本机服务 INPUT + DNAT 入站转发流量（包含 flvx/nftables 端口转发）。" >&2
      ;;
    none)
      echo >&2
      echo "整机白名单范围：仅本机服务 INPUT，不托管 DNAT 入站转发。" >&2
      ;;
    selected)
      local iface
      for iface in ${CN_FORWARD_IFACES_DEFAULT:-}; do
        cn_validate_interface_name "${iface}"
        append_unique_forward_iface "${iface}"
      done
      if [[ "${#SELECTED_FORWARD_IFACES[@]}" -eq 0 ]]; then
        echo "CN_FORWARD_MODE_DEFAULT=selected 时必须设置 CN_FORWARD_IFACES_DEFAULT。" >&2
        exit 1
      fi
      echo >&2
      echo "整机白名单范围：本机服务 INPUT + 指定接口的 DNAT 入站转发 ${SELECTED_FORWARD_IFACES[*]}。" >&2
      ;;
    *)
      echo "未知 CN_FORWARD_MODE_DEFAULT：${SELECTED_FORWARD_MODE}，可选 all/none/selected。" >&2
      exit 1
      ;;
  esac
}

describe_forward_selection() {
  local mode="$1"
  local ifaces="$2"
  case "${mode}" in
    all) echo "转发托管：所有 DNAT 入站转发流量" ;;
    none) echo "转发托管：关闭，仅限制本机入站端口" ;;
    selected) echo "转发托管：指定接口 ${ifaces} 的 DNAT 入站转发" ;;
    *) echo "转发托管：未知模式 ${mode}" ;;
  esac
}

copy_selected_forward_ifaces() {
  selected_forward_ifaces=()
  if ((${#SELECTED_FORWARD_IFACES[@]} > 0)); then
    selected_forward_ifaces=("${SELECTED_FORWARD_IFACES[@]}")
  fi
}

confirm_client_ip() {
  local client_ip="$1"
  if [[ -z "${client_ip}" ]]; then
    echo ""
    return
  fi

  if visual_menu_available; then
    visual_single_select \
      "检测到当前 SSH 客户端 IP：${client_ip}" \
      "加入本次白名单，避免断连" "yes" \
      "不加入" "no"
    [[ "${VISUAL_SELECTED_VALUE}" == "yes" ]] && echo "${client_ip}" || echo ""
    return
  fi

  echo "检测到当前 SSH 客户端 IP：${client_ip}" >&2
  read -r -p "是否临时加入本次白名单以避免断连？[Y/n] " answer
  case "${answer:-Y}" in
    y|Y|yes|YES) echo "${client_ip}" ;;
    *) echo "" ;;
  esac
}

confirm_apply_rules() {
  echo "即将应用规则：未命中白名单的所有入站端口都会被拒绝。"
  if visual_menu_available; then
    visual_single_select \
      "确认应用防火墙规则" \
      "取消，不应用规则" "no" \
      "应用规则" "yes"
    [[ "${VISUAL_SELECTED_VALUE}" == "yes" ]]
    return
  fi

  local confirm
  read -r -p "确认继续？输入 YES/yes/y: " confirm
  is_yes_confirmation "${confirm}"
}

is_yes_confirmation() {
  case "$(cn_trim "${1:-}")" in
    YES|yes|Y|y) return 0 ;;
    *) return 1 ;;
  esac
}

confirm_post_apply_rules() {
  [[ "${CN_POST_APPLY_CONFIRM:-1}" != "0" ]] || return 0
  [[ -r /dev/tty && ( -t 0 || -t 2 ) ]] || return 0

  local timeout="${CN_POST_APPLY_TIMEOUT:-60}"
  local confirm=""
  echo
  echo "规则已临时应用。请立刻用新窗口测试 SSH/业务端口。"
  echo "如果 ${timeout} 秒内没有输入 YES/yes/y，脚本会自动清理本次规则，避免锁死。"
  read -r -t "${timeout}" -p "确认新连接可访问并保存开机恢复？输入 YES/yes/y: " confirm < /dev/tty || confirm=""
  is_yes_confirmation "${confirm}"
}

parse_update_mode() {
  UPDATE_MODE="$1"
  shift || true
  local arg
  for arg in "$@"; do
    case "${arg}" in
      --update) UPDATE_MODE="required" ;;
      --offline|--no-update) UPDATE_MODE="offline" ;;
      --update-optional) UPDATE_MODE="optional" ;;
      *)
        echo "未知参数：${arg}" >&2
        usage
        exit 2
        ;;
    esac
  done
}

prepare_data_for_mode() {
  local mode="$1"
  case "${mode}" in
    required)
      cn_update_runtime_data
      ;;
    optional)
      if ! cn_update_runtime_data; then
        echo "同步 GitHub 预制数据失败，将使用本机已有数据继续。" >&2
        cn_use_runtime_data_if_available
      fi
      ;;
    offline)
      cn_use_runtime_data_if_available
      ;;
    *)
      echo "未知更新模式：${mode}" >&2
      exit 2
      ;;
  esac
}

run_apply_or_dry_run() {
  local dry_run="$1"
  local update_mode="$2"
  local -a selected_codes
  local -a selected_asns
  local -a selected_forward_ifaces
  local selected_forward_mode selected_forward_ifaces_text selected_asns_text selected_port_policies
  prepare_data_for_mode "${update_mode}"
  SELECTED_CODES=()
  SELECTED_ASNS=()
  SELECTED_PORT_POLICIES=""
  if visual_menu_available; then
    interactive_config_editor "${dry_run}"
  else
    interactive_select_codes
    interactive_select_asns
    interactive_select_port_policies
  fi

  selected_codes=()
  if ((${#SELECTED_CODES[@]} > 0)); then
    selected_codes=("${SELECTED_CODES[@]}")
  fi
  if [[ "${#selected_codes[@]}" -eq 0 ]]; then
    echo "未选择任何省份。" >&2
    exit 1
  fi
  selected_asns=()
  if ((${#SELECTED_ASNS[@]} > 0)); then
    selected_asns=("${SELECTED_ASNS[@]}")
  fi
  selected_asns_text=""
  if ((${#selected_asns[@]} > 0)); then
    selected_asns_text="${selected_asns[*]}"
  fi
  selected_port_policies="${SELECTED_PORT_POLICIES}"
  interactive_select_forward_interfaces
  selected_forward_mode="${SELECTED_FORWARD_MODE}"
  copy_selected_forward_ifaces
  selected_forward_ifaces_text=""
  if ((${#selected_forward_ifaces[@]} > 0)); then
    selected_forward_ifaces_text="${selected_forward_ifaces[*]}"
  fi

  local client_ip
  client_ip="$(confirm_client_ip "$(cn_detect_ssh_client_ip)")"

  echo
  echo "将使用以下全局白名单代码：${selected_codes[*]}"
  if [[ -n "${selected_asns_text}" ]]; then
    echo "将额外加入 ASN 白名单：${selected_asns_text}"
  fi
  if [[ -n "${selected_port_policies}" ]]; then
    echo "端口优先白名单：${selected_port_policies}"
  fi
  describe_forward_selection "${selected_forward_mode}" "${selected_forward_ifaces_text}"
  echo "防火墙后端：$(cn_effective_firewall_backend)"
  echo

  if [[ "${dry_run}" == "1" ]]; then
    cn_render_apply_commands "${client_ip}" "${selected_forward_mode}" "${selected_forward_ifaces_text}" "${selected_asns_text}" "${selected_port_policies}" "${selected_codes[@]}"
    return
  fi

  cn_require_root
  cn_require_commands
  if ! confirm_apply_rules; then
    echo "已取消。"
    exit 0
  fi
  cn_render_apply_commands "${client_ip}" "${selected_forward_mode}" "${selected_forward_ifaces_text}" "${selected_asns_text}" "${selected_port_policies}" "${selected_codes[@]}" | cn_run_rendered_commands
  if ! confirm_post_apply_rules; then
    echo "未确认新连接可访问，正在自动清理本次规则。"
    cn_disable_systemd_service
    cn_render_best_effort_clear_commands | cn_run_rendered_commands
    exit 1
  fi
  cn_save_config "${selected_forward_mode}" "${selected_forward_ifaces_text}" "${selected_asns_text}" "${selected_port_policies}" "${selected_codes[@]}"
  cn_install_systemd_service
  echo "规则已应用。"
  echo "已保存白名单配置，重启后会由 ${CN_SERVICE_NAME} 自动恢复。"
}

restore_rules() {
  local update_mode="$1"
  local -a saved_codes
  local -a saved_asns
  local -a saved_forward_ifaces
  local saved_forward_mode saved_forward_ifaces_text saved_asns_text saved_port_policies
  cn_require_root
  cn_source_config
  cn_require_commands
  prepare_data_for_mode "${update_mode}"

  saved_codes=()
  while IFS= read -r code; do
    [[ -n "${code}" ]] && saved_codes+=("${code}")
  done < <(cn_load_config_codes)

  if [[ "${#saved_codes[@]}" -eq 0 ]]; then
    echo "配置文件中没有全局白名单代码。" >&2
    exit 1
  fi

  saved_asns=()
  while IFS= read -r asn; do
    [[ -n "${asn}" ]] && saved_asns+=("${asn}")
  done < <(cn_load_config_asns)
  saved_asns_text=""
  if ((${#saved_asns[@]} > 0)); then
    saved_asns_text="${saved_asns[*]}"
    CN_ASN_OFFLINE="${CN_ASN_OFFLINE:-1}"
  fi
  saved_port_policies="$(cn_load_config_port_policies)"
  if [[ -n "${saved_port_policies}" ]]; then
    CN_ASN_OFFLINE="${CN_ASN_OFFLINE:-1}"
  fi

  saved_forward_mode="$(cn_load_config_forward_mode)"
  saved_forward_ifaces=()
  while IFS= read -r iface; do
    [[ -n "${iface}" ]] && saved_forward_ifaces+=("${iface}")
  done < <(cn_load_config_forward_ifaces)
  saved_forward_ifaces_text=""
  if ((${#saved_forward_ifaces[@]} > 0)); then
    saved_forward_ifaces_text="${saved_forward_ifaces[*]}"
  fi

  cn_render_apply_commands "" "${saved_forward_mode}" "${saved_forward_ifaces_text}" "${saved_asns_text}" "${saved_port_policies}" "${saved_codes[@]}" | cn_run_rendered_commands
  echo "已按保存配置恢复规则：${saved_codes[*]}"
  if [[ -n "${saved_asns_text}" ]]; then
    echo "已加载 ASN 白名单：${saved_asns_text}"
  fi
  if [[ -n "${saved_port_policies}" ]]; then
    echo "已加载端口优先白名单：${saved_port_policies}"
  fi
  describe_forward_selection "${saved_forward_mode}" "${saved_forward_ifaces_text}"
}

update_asn_rules() {
  local -a saved_asns
  local asn saved_port_policies
  cn_require_root
  saved_asns=()
  while IFS= read -r asn; do
    [[ -n "${asn}" ]] && saved_asns+=("${asn}")
  done < <(cn_load_config_asns)
  saved_port_policies="$(cn_load_config_port_policies)"
  while IFS= read -r asn; do
    [[ -n "${asn}" ]] && saved_asns+=("${asn}")
  done < <(cn_list_asns_from_port_policies "${saved_port_policies}")
  if [[ "${#saved_asns[@]}" -eq 0 ]]; then
    echo "配置文件中没有 ASN 白名单。" >&2
    exit 1
  fi
  CN_ASN_FORCE_UPDATE=1 cn_collect_asn_cidrs "${saved_asns[@]}" >/dev/null
  echo "ASN 白名单已更新：${saved_asns[*]}"
  restore_rules offline
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
  echo "已清除本脚本管理的规则。"
  echo "如仍无法访问，请在控制台执行：nft list table inet ${CN_NFT_TABLE}"
}

main() {
  local command="${1:-apply}"
  shift || true
  case "${command}" in
    apply)
      parse_update_mode offline "$@"
      run_apply_or_dry_run 0 "${UPDATE_MODE}"
      ;;
    dry-run)
      parse_update_mode offline "$@"
      run_apply_or_dry_run 1 "${UPDATE_MODE}"
      ;;
    restore)
      parse_update_mode offline "$@"
      restore_rules "${UPDATE_MODE}"
      ;;
    update-data)
      parse_update_mode required "$@"
      prepare_data_for_mode "${UPDATE_MODE}"
      echo "数据已同步到：${CN_RUNTIME_DIR}/data"
      ;;
    update-asn) update_asn_rules ;;
    status) status_rules ;;
    clear) clear_rules ;;
    -h|--help|help) usage ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
