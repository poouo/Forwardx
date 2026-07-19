#!/usr/bin/env bash
# ForwardX Mimic installer helper.
# Installs only Mimic and its DKMS module by reusing wg-mimic-fabric's
# update-mimic command. It does not configure WireGuard or ForwardX rules.

set -Eeuo pipefail

REPO="${WMF_REPO:-ike-sh/wg-mimic-fabric}"
REF="${WMF_REF:-v1.4.9}"
TARGET_VERSION="${FORWARDX_MIMIC_VERSION:-0.7.1}"
TARGET_VERSION="${TARGET_VERSION#v}"
TARGET_TAG="v${TARGET_VERSION}"
GITHUB_ACCELERATOR_ENABLED="${GITHUB_ACCELERATOR_ENABLED:-false}"
GITHUB_ACCELERATOR_URL="${GITHUB_ACCELERATOR_URL:-}"
DEFAULT_MIRRORS="https://gh.ddlc.top/,https://gh-proxy.com/,https://ghproxy.net/"
TS="$(date +%s)"

while [ "${GITHUB_ACCELERATOR_URL%/}" != "$GITHUB_ACCELERATOR_URL" ]; do
  GITHUB_ACCELERATOR_URL="${GITHUB_ACCELERATOR_URL%/}"
done

log() {
  printf '[ForwardX mimic] %s\n' "$*" >&2
}

die() {
  printf '[ForwardX mimic] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "please run as root, for example: sudo bash scripts/install-mimic.sh"
  fi
}

kernel_ge_61() {
  awk -v r="$(uname -r)" 'BEGIN {
    split(r, a, "[.-]");
    major = a[1] + 0;
    minor = a[2] + 0;
    exit !(major > 6 || (major == 6 && minor >= 1));
  }'
}

is_enabled_value() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

github_accelerator_enabled() {
  is_enabled_value "$GITHUB_ACCELERATOR_ENABLED" \
    && [[ "$GITHUB_ACCELERATOR_URL" == http://* || "$GITHUB_ACCELERATOR_URL" == https://* ]]
}

upstream_github_mirrors() {
  local mirrors="${WMF_GITHUB_MIRRORS:-$DEFAULT_MIRRORS}"
  if github_accelerator_enabled; then
    if [ -n "$mirrors" ]; then
      printf '%s/,%s\n' "$GITHUB_ACCELERATOR_URL" "$mirrors"
    else
      printf '%s/\n' "$GITHUB_ACCELERATOR_URL"
    fi
    return 0
  fi
  printf '%s\n' "$mirrors"
}

fetch_repo_file() {
  local relpath="$1"
  local dest="$2"
  local ref="${3:-main}"
  local mirror url raw_url
  local mirrors=()

  raw_url="https://raw.githubusercontent.com/${REPO}/${ref}/${relpath}"
  if github_accelerator_enabled; then
    url="${GITHUB_ACCELERATOR_URL}/${raw_url}"
    if curl -fsSL --connect-timeout 10 --max-time 120 -o "$dest" "$url" 2>/dev/null \
      && [ -s "$dest" ]; then
      return 0
    fi
  fi

  if curl -fsSL -H "Accept: application/vnd.github.raw+json" \
    -o "$dest" "https://api.github.com/repos/${REPO}/contents/${relpath}?ref=${ref}" 2>/dev/null \
    && [ -s "$dest" ]; then
    return 0
  fi

  IFS=',' read -r -a mirrors <<< "${WMF_GITHUB_MIRRORS:-$DEFAULT_MIRRORS}"
  for mirror in "${mirrors[@]}" ""; do
    if [ -n "$mirror" ]; then
      url="${mirror%/}/${raw_url}"
    else
      url="${raw_url}?ts=${TS}"
    fi
    if curl -fsSL --connect-timeout 10 --max-time 120 -o "$dest" "$url" 2>/dev/null \
      && [ -s "$dest" ]; then
      return 0
    fi
  done

  return 1
}

verify_mimic() {
  command -v mimic >/dev/null 2>&1 || return 1
  modprobe mimic 2>/dev/null || return 2
  return 0
}

installed_mimic_version() {
  command -v mimic >/dev/null 2>&1 || return 1
  mimic --version 2>/dev/null \
    | sed -nE 's/.*v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' \
    | head -n 1
}

validate_target_version() {
  awk -F. 'NF == 3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { ok = 1 } END { exit !ok }' \
    <<<"${TARGET_VERSION}" \
    || die "invalid FORWARDX_MIMIC_VERSION: ${TARGET_VERSION}"
}

capture_mimic_units() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local unit enabled active
  while IFS= read -r unit; do
    [ -n "${unit}" ] || continue
    enabled="$(systemctl is-enabled "${unit}" 2>/dev/null || true)"
    active="$(systemctl is-active "${unit}" 2>/dev/null || true)"
    printf '%s|%s|%s\n' "${unit}" "${enabled}" "${active}"
  done < <(
    systemctl list-units --all --type=service --no-legend \
      'mimic@*.service' 'wg-mimic-mimic@*.service' 2>/dev/null \
      | awk '{print $1}'
  )
}

restore_mimic_units() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local item unit state enabled active
  for item in "$@"; do
    unit="${item%%|*}"
    state="${item#*|}"
    enabled="${state%%|*}"
    active="${state#*|}"
    if [ "${enabled}" = "enabled" ]; then
      systemctl enable "${unit}" >/dev/null 2>&1 \
        || log "failed to re-enable service ${unit}; Agent reconciliation will retry"
    fi
    if [ "${active}" = "active" ]; then
      systemctl start "${unit}" >/dev/null 2>&1 \
        || log "failed to restart service ${unit}; Agent reconciliation will retry"
    fi
  done
}

main() {
  require_root

  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v awk >/dev/null 2>&1 || die "awk is required"
  command -v sed >/dev/null 2>&1 || die "sed is required"
  validate_target_version

  if ! kernel_ge_61; then
    die "Linux kernel $(uname -r) is lower than 6.1; Mimic requires a newer eBPF/XDP capable kernel"
  fi

  local verify_status=0 current_version=""
  verify_mimic || verify_status="$?"
  current_version="$(installed_mimic_version || true)"
  case "$verify_status" in
    0)
      if [ "${current_version}" = "${TARGET_VERSION}" ]; then
        log "mimic ${TARGET_VERSION} command and kernel module are already available"
        exit 0
      fi
      log "mimic ${current_version:-unknown} is installed; upgrading to ${TARGET_VERSION}"
      ;;
    2)
      log "mimic ${current_version:-unknown} command exists, but the kernel module is not loaded; installing ${TARGET_VERSION} and repairing DKMS"
      ;;
    *)
      log "mimic is not installed; installing ${TARGET_TAG} via ${REPO}@${REF}"
      ;;
  esac

  local tmp
  tmp="$(mktemp /tmp/forwardx-mimic-install.XXXXXX)"
  trap 'rm -f -- "$tmp"' EXIT

  fetch_repo_file "install.sh" "$tmp" "$REF" || die "failed to download wg-mimic-fabric install.sh"
  chmod +x "$tmp"

  local -a saved_units=()
  local github_mirrors
  mapfile -t saved_units < <(capture_mimic_units)
  github_mirrors="$(upstream_github_mirrors)"
  log "running wg-mimic-fabric update-mimic ${TARGET_VERSION}"
  if ! WMF_GITHUB_MIRRORS="$github_mirrors" MIMIC_UPSTREAM_TAG="${TARGET_TAG}" bash "$tmp" update-mimic "${TARGET_VERSION}"; then
    restore_mimic_units "${saved_units[@]}"
    die "wg-mimic-fabric failed to install mimic ${TARGET_VERSION}"
  fi
  restore_mimic_units "${saved_units[@]}"

  current_version="$(installed_mimic_version || true)"
  if verify_mimic && [ "${current_version}" = "${TARGET_VERSION}" ]; then
    log "mimic ${TARGET_VERSION} is ready"
    log "next: set the correct network interface name in ForwardX host management before enabling mimic UDP camouflage"
    exit 0
  fi

  if command -v mimic >/dev/null 2>&1; then
    die "mimic ${current_version:-unknown} is installed, but target ${TARGET_VERSION} is not ready. Check DKMS logs, Secure Boot/MOK signing, or reboot into the kernel with the built module."
  fi

  die "mimic installation did not complete"
}

main "$@"
