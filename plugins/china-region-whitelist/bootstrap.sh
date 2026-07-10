#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="GHUNLIL"
REPO_NAME="china-region-whitelist"
REPO_BRANCH="${CN_REPO_BRANCH:-main}"
INSTALL_DIR="${CN_INSTALL_DIR:-/opt/china-region-whitelist}"
GITHUB_PROXY="${CN_GITHUB_PROXY:-https://gh-proxy.com/}"
ARCHIVE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${REPO_BRANCH}.tar.gz"
BOOTSTRAP_WORK_DIR=""

usage() {
  cat <<'EOF'
china-region-whitelist bootstrap

默认从 GitHub 代理下载完整项目到 /opt/china-region-whitelist，然后执行 install.sh。

用法：
  bash <(curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/GHUNLIL/china-region-whitelist/main/bootstrap.sh) [install.sh 参数]

环境变量：
  CN_GITHUB_PROXY=https://gh-proxy.com/   GitHub 代理前缀；设为 direct 可直连 GitHub
  CN_FIREWALL_BACKEND=auto               防火墙后端：auto/nft/iptables
  CN_INSTALL_DIR=/opt/china-region-whitelist
  CN_REPO_BRANCH=main
EOF
}

proxy_url() {
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

require_command() {
  local command_name="$1"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "缺少命令：${command_name}" >&2
    exit 1
  fi
}

run_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    if ! command -v sudo >/dev/null 2>&1; then
      echo "当前不是 root，且未找到 sudo。请用 root 用户运行。" >&2
      exit 1
    fi
    sudo "$@"
  fi
}

run_root_preserve_env() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    if ! command -v sudo >/dev/null 2>&1; then
      echo "当前不是 root，且未找到 sudo。请用 root 用户运行。" >&2
      exit 1
    fi
    sudo -E "$@"
  fi
}

download_archive() {
  local target="$1"
  local proxy_candidates
  proxy_candidates="${CN_GITHUB_PROXIES:-${GITHUB_PROXY} direct}"
  proxy_candidates="${proxy_candidates//,/ }"

  local proxy url
  for proxy in ${proxy_candidates}; do
    url="$(proxy_url "${ARCHIVE_URL}" "${proxy}")"
    echo "正在下载：${url}" >&2
    if curl -fL --connect-timeout 20 --retry 2 --retry-delay 1 -o "${target}" "${url}"; then
      return 0
    fi
    echo "下载失败，尝试下一个地址。" >&2
  done

  echo "无法下载项目，请检查网络或设置 CN_GITHUB_PROXY。" >&2
  return 1
}

install_project() {
  local source_dir="$1"
  local parent_dir next_dir
  parent_dir="$(dirname "${INSTALL_DIR}")"
  next_dir="${INSTALL_DIR}.new"

  run_root mkdir -p "${parent_dir}"
  run_root rm -rf "${next_dir}"
  run_root cp -a "${source_dir}" "${next_dir}"
  run_root rm -rf "${INSTALL_DIR}"
  run_root mv "${next_dir}" "${INSTALL_DIR}"
  run_root chmod +x "${INSTALL_DIR}/install.sh"
}

main() {
  case "${1:-}" in
    -h|--help|help)
      usage
      return 0
      ;;
  esac

  require_command curl
  require_command tar
  require_command mktemp

  local archive_path source_dir
  BOOTSTRAP_WORK_DIR="$(mktemp -d)"
  archive_path="${BOOTSTRAP_WORK_DIR}/repo.tar.gz"
  source_dir="${BOOTSTRAP_WORK_DIR}/source"
  trap '[[ -n "${BOOTSTRAP_WORK_DIR:-}" ]] && rm -rf "${BOOTSTRAP_WORK_DIR}"' EXIT

  mkdir -p "${source_dir}"
  download_archive "${archive_path}"
  tar -xzf "${archive_path}" --strip-components=1 -C "${source_dir}"
  install_project "${source_dir}"

  if [[ "$#" -eq 0 ]]; then
    set -- apply
  fi

  echo "已安装到：${INSTALL_DIR}" >&2
  run_root_preserve_env bash "${INSTALL_DIR}/install.sh" "$@"
}

main "$@"
