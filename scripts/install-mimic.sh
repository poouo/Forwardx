#!/usr/bin/env bash
# ForwardX Mimic installer — standalone, no external script dependencies.
# Installs mimic binary + DKMS kernel module directly from hack3ric/mimic releases.
# Does not configure WireGuard or ForwardX forwarding rules.

set -Eeuo pipefail

MIMIC_REPO="hack3ric/mimic"
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

# Build ordered mirror list: accelerator first, then DEFAULT_MIRRORS
upstream_github_mirrors() {
  local mirrors="${FORWARDX_GITHUB_MIRRORS:-$DEFAULT_MIRRORS}"
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

# Download a file from a raw GitHub URL with accelerator + mirror fallback.
# Variable naming kept compatible with existing test expectations.
fetch_github_file() {
  local raw_url="$1"
  local dest="$2"
  local url mirror mirrors=()

  if github_accelerator_enabled; then
    url="${GITHUB_ACCELERATOR_URL}/${raw_url}"
    if curl -fsSL --connect-timeout 10 --max-time 120 -o "$dest" "$url" 2>/dev/null \
      && [ -s "$dest" ]; then
      return 0
    fi
  fi

  IFS=',' read -r -a mirrors <<< "${FORWARDX_GITHUB_MIRRORS:-$DEFAULT_MIRRORS}"
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

ensure_ethtool() {
  command -v ethtool >/dev/null 2>&1 && return 0
  log "installing ethtool for Mimic NIC offload compatibility"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y ethtool >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y ethtool >/dev/null 2>&1 || true
  elif command -v yum >/dev/null 2>&1; then
    yum install -y ethtool >/dev/null 2>&1 || true
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed ethtool >/dev/null 2>&1 || true
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache ethtool >/dev/null 2>&1 || true
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n install ethtool >/dev/null 2>&1 || true
  fi
  command -v ethtool >/dev/null 2>&1
}

validate_target_version() {
  awk -F. 'NF == 3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { ok = 1 } END { exit !ok }' \
    <<<"${TARGET_VERSION}" \
    || die "invalid FORWARDX_MIMIC_VERSION: ${TARGET_VERSION}"
}

installed_mimic_version() {
  command -v mimic >/dev/null 2>&1 || return 1
  mimic --version 2>/dev/null \
    | sed -nE 's/.*v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' \
    | head -n 1
}

verify_mimic() {
  command -v mimic >/dev/null 2>&1 || return 1
  modprobe mimic 2>/dev/null || return 2
  return 0
}

# Detect distro family for package manager selection
detect_distro_family() {
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
      debian|ubuntu|linuxmint|pop|kali|raspbian|neon|elementary) echo "debian" ; return ;;
      rhel|centos|fedora|rocky|almalinux|ol|amzn|eurolinux|cloudlinux) echo "rhel" ; return ;;
      arch|manjaro|endeavouros|garuda|artix) echo "arch" ; return ;;
      alpine) echo "alpine" ; return ;;
      opensuse*|sles|sled) echo "opensuse" ; return ;;
    esac
    case "${ID_LIKE:-}" in
      *debian*) echo "debian" ; return ;;
      *rhel*|*fedora*|*centos*) echo "rhel" ; return ;;
      *arch*) echo "arch" ; return ;;
      *suse*) echo "opensuse" ; return ;;
    esac
  fi
  echo "unknown"
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)   echo "amd64" ;;
    aarch64|arm64)  echo "arm64" ;;
    *)              echo "" ;;
  esac
}

# Install dkms + kernel headers + build tools for the detected family
install_dkms_deps() {
  local family="$1"
  log "installing DKMS prerequisites for ${family}"
  case "$family" in
    debian)
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
        dkms "linux-headers-$(uname -r)" build-essential >/dev/null 2>&1 \
        || DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
          dkms linux-headers-generic build-essential >/dev/null 2>&1 \
        || true
      ;;
    rhel)
      if command -v dnf >/dev/null 2>&1; then
        dnf install -y -q dkms "kernel-devel-$(uname -r)" gcc make >/dev/null 2>&1 \
          || dnf install -y -q dkms kernel-devel gcc make >/dev/null 2>&1 \
          || true
      else
        yum install -y -q dkms "kernel-devel-$(uname -r)" gcc make >/dev/null 2>&1 \
          || yum install -y -q dkms kernel-devel gcc make >/dev/null 2>&1 \
          || true
      fi
      ;;
    arch)
      pacman -Sy --noconfirm --needed dkms linux-headers base-devel >/dev/null 2>&1 || true
      ;;
    opensuse)
      zypper -n install dkms "kernel-devel-$(uname -r)" gcc make >/dev/null 2>&1 \
        || zypper -n install dkms kernel-devel gcc make >/dev/null 2>&1 \
        || true
      ;;
    alpine)
      # Try DKMS from community repo; if unavailable fall back to bare build tools
      apk add --no-cache dkms gcc make musl-dev linux-lts-dev >/dev/null 2>&1 \
        || apk add --no-cache dkms gcc make musl-dev linux-edge-dev >/dev/null 2>&1 \
        || apk add --no-cache gcc make musl-dev linux-lts-dev >/dev/null 2>&1 \
        || apk add --no-cache gcc make musl-dev linux-edge-dev >/dev/null 2>&1 \
        || true
      ;;
    *)
      log "unknown distro family; skipping automatic dependency installation"
      ;;
  esac
}

# Download a mimic release asset with mirror fallback
download_mimic_asset() {
  local asset="$1" dest="$2"
  local raw_url="https://github.com/${MIMIC_REPO}/releases/download/${TARGET_TAG}/${asset}"
  log "downloading ${asset}"
  fetch_github_file "$raw_url" "$dest"
}

# Install via pre-built .deb packages (Debian / Ubuntu family)
install_mimic_deb() {
  local arch tmp rc=0
  arch="$(detect_arch)"
  [ -n "$arch" ] || { log "unsupported architecture for .deb install: $(uname -m)"; return 1; }

  tmp="$(mktemp -d /tmp/forwardx-mimic-deb.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp'" RETURN

  local bin_deb="mimic_${TARGET_VERSION}_${arch}.deb"
  local dkms_deb="mimic-dkms_${TARGET_VERSION}_all.deb"

  download_mimic_asset "$bin_deb"  "$tmp/$bin_deb"  || { log "failed to download ${bin_deb}"; return 1; }
  download_mimic_asset "$dkms_deb" "$tmp/$dkms_deb" || { log "failed to download ${dkms_deb}"; return 1; }

  DEBIAN_FRONTEND=noninteractive dpkg -i "$tmp/$dkms_deb" "$tmp/$bin_deb" >/dev/null 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    # Fix broken dependencies then retry
    DEBIAN_FRONTEND=noninteractive apt-get install -y -f >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive dpkg -i "$tmp/$dkms_deb" "$tmp/$bin_deb" >/dev/null 2>&1 || return 1
  fi
  return 0
}

# Install via pre-built .rpm packages (RHEL / CentOS / Fedora family)
install_mimic_rpm() {
  local hw_arch tmp
  hw_arch="$(uname -m)"

  tmp="$(mktemp -d /tmp/forwardx-mimic-rpm.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp'" RETURN

  local bin_rpm="mimic-${TARGET_VERSION}-1.${hw_arch}.rpm"
  local dkms_rpm="mimic-dkms-${TARGET_VERSION}-1.noarch.rpm"

  download_mimic_asset "$bin_rpm"  "$tmp/$bin_rpm"  || { log "failed to download ${bin_rpm}"; return 1; }
  download_mimic_asset "$dkms_rpm" "$tmp/$dkms_rpm" || { log "failed to download ${dkms_rpm}"; return 1; }

  if command -v dnf >/dev/null 2>&1; then
    dnf install -y "$tmp/$dkms_rpm" "$tmp/$bin_rpm" >/dev/null 2>&1 || return 1
  elif command -v rpm >/dev/null 2>&1; then
    rpm -U --force "$tmp/$dkms_rpm" "$tmp/$bin_rpm" >/dev/null 2>&1 || return 1
  else
    log "no rpm-compatible package manager found"
    return 1
  fi
  return 0
}

# Fetch and extract the mimic source into a temp dir, echo the src path on stdout.
# Caller owns cleanup of the temp dir.
_fetch_mimic_source() {
  local tmp="$1"
  local src_tar="mimic-${TARGET_VERSION}.tar.gz"
  if ! download_mimic_asset "$src_tar" "$tmp/$src_tar"; then
    log "release tarball not found; fetching source archive for ${TARGET_TAG}"
    local archive_url="https://github.com/${MIMIC_REPO}/archive/refs/tags/${TARGET_TAG}.tar.gz"
    fetch_github_file "$archive_url" "$tmp/$src_tar" \
      || { log "failed to download mimic source archive"; return 1; }
  fi
  tar -xzf "$tmp/$src_tar" -C "$tmp" 2>/dev/null \
    || { log "failed to extract mimic source archive"; return 1; }
  local src_dir
  src_dir="$(find "$tmp" -maxdepth 1 -type d -name "mimic*" | head -1)"
  [ -n "$src_dir" ] || { log "unexpected source archive structure"; return 1; }
  printf '%s\n' "$src_dir"
}

# Install userspace mimic binary from a source tree if not already on PATH
_install_mimic_binary_from_src() {
  local src_dir="$1"
  command -v mimic >/dev/null 2>&1 && return 0
  local bin_file
  bin_file="$(find "$src_dir" -maxdepth 2 -type f -name mimic \
    ! -name "*.c" ! -name "*.h" ! -name "*.go" ! -name "*.rs" | head -1)"
  if [ -n "$bin_file" ] && [ -x "$bin_file" ]; then
    install -m 0755 "$bin_file" /usr/local/bin/mimic
    return 0
  fi
  log "userspace mimic binary not found in source; you may need to install it manually"
  return 0  # non-fatal — kernel module may still work
}

# Build and install mimic from DKMS source tarball.
# Used as primary method for Arch/openSUSE, and as fallback when .deb/.rpm
# pre-built packages are unavailable for the target version.
install_mimic_dkms_source() {
  local tmp src_dir dkms_src
  tmp="$(mktemp -d /tmp/forwardx-mimic-src.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp'" RETURN

  if ! command -v dkms >/dev/null 2>&1; then
    log "dkms not available; falling back to manual kernel module build"
    install_mimic_make_only
    return $?
  fi

  src_dir="$(_fetch_mimic_source "$tmp")" || return 1

  dkms_src="/usr/src/mimic-${TARGET_VERSION}"
  rm -rf "$dkms_src"
  cp -r "$src_dir" "$dkms_src"

  # Synthesise a minimal dkms.conf if the project does not include one
  if [ ! -f "$dkms_src/dkms.conf" ]; then
    cat > "$dkms_src/dkms.conf" <<EOF
PACKAGE_NAME="mimic"
PACKAGE_VERSION="${TARGET_VERSION}"
BUILT_MODULE_NAME[0]="mimic"
DEST_MODULE_LOCATION[0]="/updates/dkms"
AUTOINSTALL="yes"
EOF
  fi

  dkms add     "mimic/${TARGET_VERSION}" >/dev/null 2>&1 || true
  dkms build   "mimic/${TARGET_VERSION}" \
    || { log "DKMS build failed; ensure kernel headers are installed for $(uname -r)"; return 1; }
  dkms install "mimic/${TARGET_VERSION}" \
    || { log "DKMS install failed"; return 1; }

  _install_mimic_binary_from_src "$src_dir"
  return 0
}

# Build and install mimic WITHOUT dkms — for Alpine or any system where dkms
# is unavailable. The module survives until the next kernel upgrade; after
# that it must be rebuilt manually (or re-run this script).
install_mimic_make_only() {
  local tmp src_dir ko_file kmod_dir
  tmp="$(mktemp -d /tmp/forwardx-mimic-make.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp'" RETURN

  command -v make >/dev/null 2>&1 || { log "make not found; cannot compile mimic kernel module"; return 1; }

  src_dir="$(_fetch_mimic_source "$tmp")" || return 1

  log "compiling mimic kernel module (this may take a minute)"
  ( cd "$src_dir" && make ) \
    || { log "make failed; check that kernel headers are installed for $(uname -r)"; return 1; }

  ko_file="$(find "$src_dir" -name "mimic.ko" | head -1)"
  [ -n "$ko_file" ] || { log "mimic.ko not found after build"; return 1; }

  kmod_dir="/lib/modules/$(uname -r)/extra"
  mkdir -p "$kmod_dir"
  install -m 0644 "$ko_file" "$kmod_dir/mimic.ko"
  depmod -a 2>/dev/null || true

  modprobe mimic \
    || { log "modprobe mimic failed; you may need to reboot or check Secure Boot / MOK signing"; return 1; }

  log "mimic kernel module loaded (no DKMS — will need recompile after kernel upgrade)"
  _install_mimic_binary_from_src "$src_dir"
  return 0
}

# Ask the user whether to proceed with a source compile on systems that have
# no pre-built binary packages. Reads from /dev/tty; defaults to N.
prompt_source_build() {
  local answer=""
  log "pre-built mimic packages are not available for this system (family: ${1:-unknown})"
  log "installing from source requires gcc, make, and kernel headers (~5-10 min)"
  if ! [ -r /dev/tty ]; then
    log "no interactive terminal detected; skipping mimic source build (re-run with FORWARDX_INSTALL_MIMIC=yes to force)"
    return 1
  fi
  exec 3<>/dev/tty
  printf '[ForwardX mimic] Compile and install mimic from source? [y/N]: ' >&3
  IFS= read -r answer <&3 || answer=""
  exec 3>&-
  case "$answer" in
    Y|y|YES|yes) return 0 ;;
    *) log "skipping mimic source build"; return 1 ;;
  esac
}

# Save state of active mimic@ systemd units so they can be restored after reinstall
capture_mimic_units() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local unit enabled active
  while IFS= read -r unit; do
    [ -n "${unit}" ] || continue
    enabled="$(systemctl is-enabled "${unit}" 2>/dev/null || true)"
    active="$(systemctl is-active  "${unit}" 2>/dev/null || true)"
    printf '%s|%s|%s\n' "${unit}" "${enabled}" "${active}"
  done < <(
    systemctl list-units --all --type=service --no-legend \
      'mimic@*.service' 2>/dev/null \
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
        || log "failed to re-enable ${unit}; Agent reconciliation will retry"
    fi
    if [ "${active}" = "active" ]; then
      systemctl start "${unit}" >/dev/null 2>&1 \
        || log "failed to restart ${unit}; Agent reconciliation will retry"
    fi
  done
}

main() {
  require_root

  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v awk  >/dev/null 2>&1 || die "awk is required"
  validate_target_version

  if ! kernel_ge_61; then
    die "Linux kernel $(uname -r) is lower than 6.1; Mimic requires an eBPF/XDP capable kernel"
  fi

  ensure_ethtool || log "ethtool is unavailable; NIC offload management will be skipped"

  local verify_status=0 current_version=""
  verify_mimic || verify_status="$?"
  current_version="$(installed_mimic_version || true)"
  case "$verify_status" in
    0)
      if [ "${current_version}" = "${TARGET_VERSION}" ]; then
        log "mimic ${TARGET_VERSION} command and kernel module are already available"
        exit 0
      fi
      log "mimic ${current_version:-unknown} installed; upgrading to ${TARGET_VERSION}"
      ;;
    2)
      log "mimic ${current_version:-unknown} command exists but kernel module not loaded; repairing DKMS"
      ;;
    *)
      log "mimic not installed; installing ${TARGET_TAG} from ${MIMIC_REPO}"
      ;;
  esac

  local family
  family="$(detect_distro_family)"
  log "distro family: ${family}"

  local -a saved_units=()
  mapfile -t saved_units < <(capture_mimic_units)

  install_dkms_deps "$family"

  local install_ok=0
  case "$family" in
    debian)
      # Pre-built packages preferred; silent fallback to source build on 404
      install_mimic_deb && install_ok=1 \
        || { log "pre-built .deb packages unavailable; falling back to DKMS source build"; true; }
      [ "$install_ok" = "1" ] \
        || { install_mimic_dkms_source && install_ok=1 || true; }
      ;;
    rhel)
      # Pre-built packages preferred; silent fallback to source build on 404
      install_mimic_rpm && install_ok=1 \
        || { log "pre-built .rpm packages unavailable; falling back to DKMS source build"; true; }
      [ "$install_ok" = "1" ] \
        || { install_mimic_dkms_source && install_ok=1 || true; }
      ;;
    *)
      # Arch / openSUSE / Alpine / unknown — no pre-built packages available.
      # Ask the user before starting a potentially lengthy source compile.
      # Non-interactive or FORWARDX_INSTALL_MIMIC=no → skip gracefully.
      if is_enabled_value "${FORWARDX_INSTALL_MIMIC:-}"; then
        # Explicitly forced via env var — skip the prompt
        install_mimic_dkms_source && install_ok=1 || true
      elif prompt_source_build "$family"; then
        install_mimic_dkms_source && install_ok=1 || true
      else
        log "mimic installation skipped by user"
        restore_mimic_units "${saved_units[@]}"
        exit 0
      fi
      ;;
  esac

  restore_mimic_units "${saved_units[@]}"

  [ "$install_ok" = "1" ] \
    || die "mimic installation failed for distro family '${family}'"

  current_version="$(installed_mimic_version || true)"
  if verify_mimic && [ "${current_version}" = "${TARGET_VERSION}" ]; then
    log "mimic ${TARGET_VERSION} is ready"
    log "next: configure the network interface name in ForwardX host management before enabling mimic UDP camouflage"
    exit 0
  fi

  if command -v mimic >/dev/null 2>&1; then
    die "mimic ${current_version:-unknown} installed but target ${TARGET_VERSION} not confirmed. Check DKMS logs, Secure Boot/MOK signing, or reboot into the kernel with the built module."
  fi
  die "mimic installation did not complete"
}

main "$@"
