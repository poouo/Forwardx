#!/usr/bin/env bash
# ForwardX Mimic installer helper.
# Installs only Mimic and its DKMS module by reusing wg-mimic-fabric's
# install-mimic command. It does not configure WireGuard or ForwardX rules.

set -Eeuo pipefail

REPO="${WMF_REPO:-ike-sh/wg-mimic-fabric}"
REF="${WMF_REF:-main}"
DEFAULT_MIRRORS="https://gh.ddlc.top/,https://gh-proxy.com/,https://ghproxy.net/"
TS="$(date +%s)"

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

fetch_repo_file() {
  local relpath="$1"
  local dest="$2"
  local ref="${3:-main}"
  local mirror url
  local mirrors=()

  if curl -fsSL -H "Accept: application/vnd.github.raw+json" \
    -o "$dest" "https://api.github.com/repos/${REPO}/contents/${relpath}?ref=${ref}" 2>/dev/null \
    && [ -s "$dest" ]; then
    return 0
  fi

  IFS=',' read -r -a mirrors <<< "${WMF_GITHUB_MIRRORS:-$DEFAULT_MIRRORS}"
  for mirror in "${mirrors[@]}" ""; do
    if [ -n "$mirror" ]; then
      url="${mirror%/}/https://raw.githubusercontent.com/${REPO}/${ref}/${relpath}"
    else
      url="https://raw.githubusercontent.com/${REPO}/${ref}/${relpath}?ts=${TS}"
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

main() {
  require_root

  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v awk >/dev/null 2>&1 || die "awk is required"

  if ! kernel_ge_61; then
    die "Linux kernel $(uname -r) is lower than 6.1; Mimic requires a newer eBPF/XDP capable kernel"
  fi

  local verify_status=0
  verify_mimic || verify_status="$?"
  case "$verify_status" in
    0)
      log "mimic command and kernel module are already available"
      exit 0
      ;;
    2)
      log "mimic command exists, but the kernel module is not loaded; reinstalling or repairing DKMS"
      ;;
    *)
      log "mimic is not installed; installing from ${REPO}@${REF}"
      ;;
  esac

  local tmp
  tmp="$(mktemp /tmp/forwardx-mimic-install.XXXXXX)"
  trap 'rm -f -- "$tmp"' EXIT

  fetch_repo_file "install.sh" "$tmp" "$REF" || die "failed to download wg-mimic-fabric install.sh"
  chmod +x "$tmp"

  log "running wg-mimic-fabric install-mimic only"
  bash "$tmp" install-mimic

  if verify_mimic; then
    log "mimic is ready"
    log "next: set the correct network interface name in ForwardX host management before enabling mimic UDP camouflage"
    exit 0
  fi

  if command -v mimic >/dev/null 2>&1; then
    die "mimic CLI is installed, but the kernel module cannot be loaded. Check DKMS logs, Secure Boot/MOK signing, or reboot into the kernel with the built module."
  fi

  die "mimic installation did not complete"
}

main "$@"
