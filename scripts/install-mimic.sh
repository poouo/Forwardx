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
MIMIC_BUILD_FLAGS=()
MIMIC_DKMS_FLAGS=()
MIMIC_RESOLVE_BTFIDS=""

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

# Mimic release packages are prefixed by the Debian/Ubuntu codename and use
# Debian's -1 package revision. Keep the candidates ordered so a supported
# local package is always preferred over a compatibility fallback.
detect_deb_codenames() {
  local id="" current=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    id="${ID:-}"
    current="${VERSION_CODENAME:-}"
  fi

  case "${id}" in
    debian|raspbian|kali)
      printf '%s\n' "${current}" bookworm trixie
      ;;
    ubuntu|linuxmint|pop|neon|elementary)
      printf '%s\n' "${current}" noble
      ;;
    *)
      printf '%s\n' "${current}" bookworm trixie noble
      ;;
  esac | awk 'NF && !seen[$0]++'
}

kernel_build_dir() {
  printf '/lib/modules/%s/build\n' "$(uname -r)"
}

kernel_config_path() {
  local build_dir
  if [ -r "/boot/config-$(uname -r)" ]; then
    printf '/boot/config-%s\n' "$(uname -r)"
    return 0
  fi
  build_dir="$(kernel_build_dir)"
  if [ -r "${build_dir}/.config" ]; then
    printf '%s/.config\n' "${build_dir}"
    return 0
  fi
  return 1
}

kernel_config_enabled() {
  local key="$1" config
  config="$(kernel_config_path 2>/dev/null || true)"
  [ -n "${config}" ] || return 2
  grep -Eq "^[[:space:]]*${key}=y[[:space:]]*$" "${config}"
}

mimic_vmlinux_path() {
  local build_dir="$(kernel_build_dir)"
  if [ -r /sys/kernel/btf/vmlinux ]; then
    printf '/sys/kernel/btf/vmlinux\n'
  elif [ -r "${build_dir}/vmlinux" ]; then
    printf '%s/vmlinux\n' "${build_dir}"
  elif [ -r "/usr/lib/debug/lib/modules/$(uname -r)/vmlinux" ]; then
    printf '/usr/lib/debug/lib/modules/%s/vmlinux\n' "$(uname -r)"
  fi
}

mimic_resolve_btfids_path() {
  local build_dir="$(kernel_build_dir)"
  local candidate
  for candidate in \
    "${build_dir}/tools/bpf/resolve_btfids/resolve_btfids" \
    "/usr/lib/mimic/resolve_btfids" \
    /usr/lib/linux-kbuild-*/tools/bpf/resolve_btfids/resolve_btfids; do
    if [ -x "${candidate}" ]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  command -v resolve_btfids 2>/dev/null || true
}

mimic_kfunc_build_ready() {
  local build_dir="$(kernel_build_dir)"
  [ -n "$(mimic_vmlinux_path)" ] || return 1

  # The Mimic kmod Makefile can build directly when both files are present in
  # the kernel build tree. Otherwise it needs bubblewrap and resolve_btfids to
  # create a temporary, BTF-complete build tree.
  if [ -f "${build_dir}/vmlinux" ] \
    && [ -x "${build_dir}/tools/bpf/resolve_btfids/resolve_btfids" ]; then
    return 0
  fi
  command -v bwrap >/dev/null 2>&1 \
    && [ -n "$(mimic_resolve_btfids_path)" ]
}

mimic_checksum_hack_for_kernel() {
  local btf=1 bpf_jit=1 kprobes=1 kretprobes=1 kallsyms=1 config_path=""
  config_path="$(kernel_config_path 2>/dev/null || true)"

  if kernel_config_enabled CONFIG_DEBUG_INFO_BTF && [ -n "$(mimic_vmlinux_path)" ]; then btf=0; fi
  if kernel_config_enabled CONFIG_BPF_JIT; then bpf_jit=0; fi
  if kernel_config_enabled CONFIG_KPROBES; then kprobes=0; fi
  if kernel_config_enabled CONFIG_KRETPROBES; then kretprobes=0; fi
  if kernel_config_enabled CONFIG_KALLSYMS; then kallsyms=0; fi

  # Prefer kfunc when the running kernel exposes the complete BTF toolchain.
  # A kernel with BTF can still be built with kprobe, but kfunc is the upstream
  # default and gives the best checksum-offload coverage.
  if [ "${btf}" -eq 0 ] && [ "${bpf_jit}" -eq 0 ] && mimic_kfunc_build_ready; then
    printf 'kfunc\n'
    return 0
  fi

  # kprobe deliberately does not require kernel BTF. If a custom kernel does
  # not install its .config, let DKMS/Make validate the symbols instead of
  # rejecting a build that the kernel may support.
  if [ "${kprobes}" -eq 0 ] && [ "${kretprobes}" -eq 0 ] && [ "${kallsyms}" -eq 0 ]; then
    printf 'kprobe\n'
    return 0
  fi
  if [ -z "${config_path}" ]; then
    # Custom kernels often keep the config outside /boot. Prefer the BTF-free
    # kprobe variant and let the actual module build validate the symbols.
    printf 'kprobe\n'
    return 0
  fi
  return 1
}

mimic_kprobe_available() {
  local config_path=""
  config_path="$(kernel_config_path 2>/dev/null || true)"
  [ -n "${config_path}" ] || return 0
  kernel_config_enabled CONFIG_KPROBES \
    && kernel_config_enabled CONFIG_KRETPROBES \
    && kernel_config_enabled CONFIG_KALLSYMS
}

mimic_prepare_build_options() {
  local vmlinux="" bpftool_bin=""
  if [ -z "${MIMIC_CHECKSUM_HACK:-}" ]; then
    MIMIC_CHECKSUM_HACK="$(mimic_checksum_hack_for_kernel)" || return 1
  fi
  # Do not pass an empty BPFTOOL assignment to make. The upstream Makefile
  # has a useful /usr/sbin/bpftool default, but an empty command silently
  # overrides it and turns the source fallback into a confusing build error.
  bpftool_bin="$(type -P bpftool 2>/dev/null || true)"
  if [ -z "${bpftool_bin}" ] && [ -x /usr/sbin/bpftool ]; then
    bpftool_bin="/usr/sbin/bpftool"
  elif [ -z "${bpftool_bin}" ] && [ -x /sbin/bpftool ]; then
    bpftool_bin="/sbin/bpftool"
  fi
  [ -x "${bpftool_bin}" ] \
    || { log "bpftool is required for the Mimic source build"; return 1; }
  MIMIC_BUILD_FLAGS=(
    "KERNEL_UNAME=$(uname -r)"
    "BPFTOOL=${bpftool_bin}"
    "USE_LIBXDP=0"
    "CHECKSUM_HACK=${MIMIC_CHECKSUM_HACK}"
  )
  MIMIC_DKMS_FLAGS=(
    "KERNEL_UNAME=\$kernelver"
    "CHECKSUM_HACK=${MIMIC_CHECKSUM_HACK}"
  )
  vmlinux="$(mimic_vmlinux_path 2>/dev/null || true)"
  if [ -n "${vmlinux}" ] && [ "${MIMIC_CHECKSUM_HACK}" = "kfunc" ]; then
    # kfunc needs a matching vmlinux for CO-RE and kernel BTF generation.
    MIMIC_BUILD_FLAGS+=("KERNEL_VMLINUX=${vmlinux}")
  fi
  if [ "${MIMIC_CHECKSUM_HACK}" = "kfunc" ]; then
    MIMIC_RESOLVE_BTFIDS="$(mimic_resolve_btfids_path 2>/dev/null || true)"
    command -v bwrap >/dev/null 2>&1 \
      || { log "bubblewrap is required for the kfunc Mimic kernel module build"; return 1; }
    [ -n "${MIMIC_RESOLVE_BTFIDS}" ] \
      || { log "resolve_btfids is required for the kfunc Mimic kernel module build"; return 1; }
    MIMIC_DKMS_FLAGS+=("RESOLVE_BTFIDS=${MIMIC_RESOLVE_BTFIDS}")
  else
    # kprobe does not require kernel BTF. Stripping BTF.ext also avoids CO-RE
    # relocation against a vmlinux file that the custom kernel does not ship.
    MIMIC_BUILD_FLAGS+=("STRIP_BTF_EXT=1")
    command -v llvm-strip >/dev/null 2>&1 \
      || { log "llvm-strip is required for the kprobe Mimic build"; return 1; }
  fi
  if [ "${MIMIC_CHECKSUM_HACK}" = "kfunc" ]; then
    command -v pahole >/dev/null 2>&1 \
      || { log "pahole is required for the kfunc Mimic kernel module build"; return 1; }
  fi
}

check_kernel_build_requirements() {
  local build_dir config_path vmlinux
  build_dir="$(kernel_build_dir)"
  if [ ! -f "${build_dir}/Makefile" ] || [ ! -d "${build_dir}/scripts" ]; then
    log "kernel headers for $(uname -r) are unavailable at ${build_dir}"
    log "install the exact matching headers or boot a distribution kernel before building Mimic"
    return 1
  fi

  config_path="$(kernel_config_path 2>/dev/null || true)"
  if [ -n "${config_path}" ]; then
    if ! grep -Eq '^[[:space:]]*CONFIG_BPF=y[[:space:]]*$' "${config_path}" || ! grep -Eq '^[[:space:]]*CONFIG_BPF_SYSCALL=y[[:space:]]*$' "${config_path}"; then
      log "kernel $(uname -r) does not expose the BPF configuration required by Mimic"
      return 1
    fi
  fi

  local checksum_hack
  checksum_hack="$(mimic_checksum_hack_for_kernel 2>/dev/null || true)"
  if [ -z "${checksum_hack}" ]; then
    log "kernel $(uname -r) cannot build Mimic's checksum support"
    log "enable BTF/kfunc build support or CONFIG_KRETPROBES + CONFIG_KALLSYMS for the kprobe fallback"
    return 1
  fi
  if [ "${checksum_hack}" = "kprobe" ]; then
    log "Mimic source build will use CHECKSUM_HACK=kprobe; kernel BTF is optional"
  else
    log "Mimic source build will use CHECKSUM_HACK=kfunc with BTF $(mimic_vmlinux_path)"
  fi
  return 0
}

install_mimic_source_deps() {
  local family="${1:-$(detect_distro_family)}"
  case "${family}" in
    debian)
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
        build-essential clang llvm bpftool pahole bubblewrap binutils \
        libbpf-dev libelf-dev zlib1g-dev libffi-dev pkg-config \
        xz-utils lz4 zstd bzip2 lzma \
        >/dev/null 2>&1 || true
      ;;
    rhel)
      if command -v dnf >/dev/null 2>&1; then
        dnf install -y -q gcc gcc-c++ make clang llvm bpftool pahole bubblewrap libbpf-devel elfutils-libelf-devel zlib-devel libffi-devel pkgconf-pkg-config >/dev/null 2>&1 || true
      elif command -v yum >/dev/null 2>&1; then
        yum install -y -q gcc gcc-c++ make clang llvm bpftool pahole bubblewrap libbpf-devel elfutils-libelf-devel zlib-devel libffi-devel pkgconfig >/dev/null 2>&1 || true
      fi
      ;;
    arch)
      pacman -Sy --noconfirm --needed base-devel clang llvm bpftool pahole bubblewrap libbpf libelf zlib libffi pkgconf >/dev/null 2>&1 || true
      ;;
    alpine)
      apk add --no-cache build-base clang llvm bpftool pahole bubblewrap libbpf-dev elfutils-dev zlib-dev libffi-dev pkgconf >/dev/null 2>&1 || true
      ;;
    opensuse)
      zypper -n install gcc gcc-c++ make clang llvm bpftool pahole bubblewrap libbpf-devel libelf-devel zlib-devel libffi-devel pkg-config >/dev/null 2>&1 || true
      ;;
  esac

  local missing=()
  command -v clang >/dev/null 2>&1 || missing+=(clang)
  command -v bpftool >/dev/null 2>&1 || missing+=(bpftool)
  command -v make >/dev/null 2>&1 || missing+=(make)
  command -v gcc >/dev/null 2>&1 || command -v cc >/dev/null 2>&1 || missing+=(gcc)
  command -v pkg-config >/dev/null 2>&1 || missing+=(pkg-config)
  if [ "${#missing[@]}" -gt 0 ]; then
    log "missing Mimic source build tools: ${missing[*]}"
    return 1
  fi
  return 0
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
  local arch tmp rc=0 codename bin_deb dkms_deb
  arch="$(detect_arch)"
  [ -n "$arch" ] || { log "unsupported architecture for .deb install: $(uname -m)"; return 1; }

  tmp="$(mktemp -d /tmp/forwardx-mimic-deb.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp'" RETURN

  while IFS= read -r codename; do
    bin_deb="${codename}_mimic_${TARGET_VERSION}-1_${arch}.deb"
    dkms_deb="${codename}_mimic-dkms_${TARGET_VERSION}-1_${arch}.deb"
    rm -f "$tmp/$bin_deb" "$tmp/$dkms_deb"
    log "trying Mimic Debian assets for ${codename}"
    if ! download_mimic_asset "$bin_deb" "$tmp/$bin_deb"; then
      continue
    fi
    if ! download_mimic_asset "$dkms_deb" "$tmp/$dkms_deb"; then
      continue
    fi

    rc=0
    DEBIAN_FRONTEND=noninteractive dpkg -i "$tmp/$dkms_deb" "$tmp/$bin_deb" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -ne 0 ]; then
      # Fix broken dependencies then retry
      DEBIAN_FRONTEND=noninteractive apt-get install -y -f >/dev/null 2>&1 || true
      DEBIAN_FRONTEND=noninteractive dpkg -i "$tmp/$dkms_deb" "$tmp/$bin_deb" >/dev/null 2>&1 || continue
    fi
    if ! command -v mimic >/dev/null 2>&1 || ! modprobe mimic >/dev/null 2>&1; then
      log "Mimic Debian packages installed but the command or kernel module is unavailable"
      return 1
    fi
    log "installed Mimic Debian assets for ${codename}"
    return 0
  done < <(detect_deb_codenames)

  log "no compatible Mimic Debian assets found for $(uname -m) / $(uname -r)"
  return 1
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
  local src_dir="$1" bin_file
  bin_file="$(find "$src_dir" -maxdepth 3 -type f -path '*/out/mimic' | head -1)"
  if [ -n "$bin_file" ] && [ -x "$bin_file" ]; then
    mkdir -p /usr/local/bin
    install -m 0755 "$bin_file" /usr/local/bin/mimic
    return 0
  fi
  log "userspace mimic binary was not produced by the source build"
  return 1
}

_build_mimic_cli_from_src() {
  local src_dir="$1"
  log "building the Mimic userspace CLI from source"
  ( cd "$src_dir" && make "${MIMIC_BUILD_FLAGS[@]}" build-cli ) \
    || { log "Mimic CLI build failed; inspect the compiler output above"; return 1; }
  _install_mimic_binary_from_src "$src_dir"
}

_write_mimic_dkms_conf() {
  local dkms_src="$1" dkms_options=""
  printf -v dkms_options ' %s' "${MIMIC_DKMS_FLAGS[@]}"
  cat > "${dkms_src}/dkms.conf" <<EOF
PACKAGE_NAME="mimic"
PACKAGE_VERSION="${TARGET_VERSION}"
BUILD_EXCLUSIVE_KERNEL_MIN="6.1"
MAKE[0]="make -C kmod${dkms_options}"
CLEAN="make -C kmod clean${dkms_options}"
BUILT_MODULE_NAME[0]="mimic"
BUILT_MODULE_LOCATION[0]="kmod"
DEST_MODULE_LOCATION[0]="/updates/dkms"
AUTOINSTALL="yes"
EOF
}

_cleanup_mimic_dkms_target() {
  command -v dkms >/dev/null 2>&1 || return 0
  dkms remove -m mimic -v "${TARGET_VERSION}" --all >/dev/null 2>&1 || true
  rm -rf "/var/lib/dkms/mimic/${TARGET_VERSION}" 2>/dev/null || true
}

_cleanup_mimic_dkms_package_state() {
  if command -v dpkg-query >/dev/null 2>&1; then
    local status=""
    status="$(dpkg-query -W -f='${db:Status-Abbrev}' mimic-dkms 2>/dev/null || true)"
    status="${status// /}"
    if [ -n "${status}" ]; then
      dpkg --purge --force-all mimic-dkms >/dev/null 2>&1 || true
    fi
  fi
  _cleanup_mimic_dkms_target
}

_install_mimic_service_from_src() {
  command -v systemctl >/dev/null 2>&1 || return 0

  local mimic_bin modprobe_bin ip_bin sh_bin mkdir_bin unit_path
  mimic_bin="$(command -v mimic || true)"
  [ -x "${mimic_bin}" ] || { log "mimic binary is unavailable while writing its systemd service"; return 1; }
  modprobe_bin="$(command -v modprobe || true)"
  [ -n "${modprobe_bin}" ] || modprobe_bin="/sbin/modprobe"
  ip_bin="$(command -v ip || true)"
  [ -n "${ip_bin}" ] || ip_bin="/sbin/ip"
  sh_bin="$(command -v sh || true)"
  [ -n "${sh_bin}" ] || sh_bin="/bin/sh"
  mkdir_bin="$(command -v mkdir || true)"
  [ -n "${mkdir_bin}" ] || mkdir_bin="/bin/mkdir"
  unit_path="/etc/systemd/system/mimic@.service"

  mkdir -p "$(dirname "${unit_path}")"
  cat > "${unit_path}" <<EOF
[Unit]
Description=Mimic eBPF UDP obfuscator on %i
Documentation=https://github.com/hack3ric/mimic
After=network-online.target systemd-modules-load.service
Wants=network-online.target systemd-modules-load.service
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
ExecStartPre=-${modprobe_bin} -r mimic
ExecStartPre=+${modprobe_bin} mimic
ExecStartPre=+${mkdir_bin} -p /run/mimic
ExecStartPre=-${sh_bin} -c 'idx="\$(cat /sys/class/net/%i/ifindex 2>/dev/null)"; [ -n "\$idx" ] && rm -f /run/mimic/*_"\$idx".lock'
ExecStartPre=-${ip_bin} link set dev %i xdp off
ExecStartPre=-${ip_bin} link set dev %i xdpgeneric off
ExecStartPre=-${ip_bin} link set dev %i xdpdrv off
ExecStartPre=-${ip_bin} link set dev %i xdpoffload off
ExecStart=${mimic_bin} run -F /etc/mimic/%i.conf %i
Restart=on-failure
RestartSec=5s
RuntimeDirectory=mimic
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW CAP_BPF
AmbientCapabilities=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW CAP_BPF
NoNewPrivileges=no

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "${unit_path}"
  systemctl daemon-reload >/dev/null 2>&1 || true
  log "installed source-built Mimic systemd template ${unit_path}"
}

# The upstream packaged unit runs as the dedicated mimic user. On newer
# kernels loading the XDP/TC programs also needs CAP_BPF; keep this as a
# drop-in so package upgrades do not overwrite the permission fix.
install_mimic_bpf_dropin() {
  command -v systemctl >/dev/null 2>&1 || return 0
  local dropin_dir="/etc/systemd/system/mimic@.service.d"
  local dropin_path="${dropin_dir}/forwardx-bpf.conf"
  local tmp_path="${dropin_path}.tmp.$$"
  mkdir -p "${dropin_dir}"
  cat > "${tmp_path}" <<'EOF'
[Service]
CapabilityBoundingSet = CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW CAP_BPF
AmbientCapabilities = CAP_SYS_ADMIN CAP_NET_ADMIN CAP_NET_BIND_SERVICE CAP_NET_RAW CAP_BPF
NoNewPrivileges = no
EOF
  if [ -f "${dropin_path}" ] && cmp -s "${tmp_path}" "${dropin_path}"; then
    rm -f "${tmp_path}"
  else
    install -m 0644 "${tmp_path}" "${dropin_path}"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  log "installed Mimic CAP_BPF systemd drop-in ${dropin_path}"
}

# Build and install mimic from DKMS source tarball.
# Used as primary method for Arch/openSUSE, and as fallback when .deb/.rpm
# pre-built packages are unavailable for the target version.
install_mimic_dkms_source() {
  local family="${1:-$(detect_distro_family)}" tmp src_dir dkms_src
  _cleanup_mimic_dkms_package_state
  install_mimic_source_deps "${family}" || return 1
  check_kernel_build_requirements || return 1
  MIMIC_CHECKSUM_HACK=""
  MIMIC_BUILD_FLAGS=()
  mimic_prepare_build_options || return 1
  tmp="$(mktemp -d /tmp/forwardx-mimic-src.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp'" RETURN

  if ! command -v dkms >/dev/null 2>&1; then
    log "dkms not available; falling back to manual kernel module build"
    install_mimic_make_only "${family}"
    return $?
  fi

  src_dir="$(_fetch_mimic_source "$tmp")" || return 1

  log "building Mimic helper tools"
  ( cd "$src_dir" && make "${MIMIC_BUILD_FLAGS[@]}" build-tools ) \
    || { log "Mimic helper tool build failed; inspect the compiler output above"; return 1; }

  dkms_src="/usr/src/mimic-${TARGET_VERSION}"
  rm -rf "$dkms_src"
  cp -r "$src_dir" "$dkms_src"

  # Always replace a stale/generated config with the official kmod layout.
  # DKMS invokes this file from the copied source tree, so BUILT_MODULE_LOCATION
  # must point at kmod/mimic.ko rather than the repository root.
  _write_mimic_dkms_conf "$dkms_src"

  _cleanup_mimic_dkms_target
  dkms add -m mimic -v "${TARGET_VERSION}" \
    || { log "DKMS could not add Mimic ${TARGET_VERSION}"; return 1; }
  if ! dkms build -m mimic -v "${TARGET_VERSION}" -k "$(uname -r)" --force; then
    if [ "${MIMIC_CHECKSUM_HACK}" = "kfunc" ] && mimic_kprobe_available; then
      log "kfunc DKMS build failed; retrying Mimic with CHECKSUM_HACK=kprobe"
      dkms remove -m mimic -v "${TARGET_VERSION}" --all >/dev/null 2>&1 || true
      MIMIC_CHECKSUM_HACK="kprobe"
      MIMIC_BUILD_FLAGS=()
      mimic_prepare_build_options || return 1
      _write_mimic_dkms_conf "$dkms_src"
      dkms add -m mimic -v "${TARGET_VERSION}" \
        || { log "DKMS could not re-add Mimic for kprobe fallback"; return 1; }
      dkms build -m mimic -v "${TARGET_VERSION}" -k "$(uname -r)" --force \
        || { log "DKMS build failed with both kfunc and kprobe checksum support"; return 1; }
    else
      log "DKMS build failed; ensure headers and the selected Mimic kernel options are available"
      return 1
    fi
  fi
  dkms install -m mimic -v "${TARGET_VERSION}" -k "$(uname -r)" --force \
    || { log "DKMS install failed"; return 1; }

  _build_mimic_cli_from_src "$src_dir" || return 1
  _install_mimic_service_from_src || return 1
  modprobe mimic \
    || { log "modprobe mimic failed after DKMS install; check Secure Boot / MOK signing"; return 1; }
  return 0
}

# Build and install mimic WITHOUT dkms — for Alpine or any system where dkms
# is unavailable. The module survives until the next kernel upgrade; after
# that it must be rebuilt manually (or re-run this script).
install_mimic_make_only() {
  local family="${1:-$(detect_distro_family)}" tmp src_dir ko_file kmod_dir
  tmp="$(mktemp -d /tmp/forwardx-mimic-make.XXXXXX)"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$tmp'" RETURN

  command -v make >/dev/null 2>&1 || { log "make not found; cannot compile mimic kernel module"; return 1; }
  install_mimic_source_deps "${family}" || return 1
  check_kernel_build_requirements || return 1
  MIMIC_CHECKSUM_HACK=""
  MIMIC_BUILD_FLAGS=()
  mimic_prepare_build_options || return 1

  src_dir="$(_fetch_mimic_source "$tmp")" || return 1

  log "compiling mimic kernel module (this may take a minute)"
  if ! ( cd "$src_dir" && make "${MIMIC_BUILD_FLAGS[@]}" build-cli build-kmod ); then
    if [ "${MIMIC_CHECKSUM_HACK}" = "kfunc" ] && mimic_kprobe_available; then
      log "kfunc source build failed; retrying Mimic with CHECKSUM_HACK=kprobe"
      ( cd "$src_dir" && make "${MIMIC_BUILD_FLAGS[@]}" clean >/dev/null 2>&1 || true )
      MIMIC_CHECKSUM_HACK="kprobe"
      MIMIC_BUILD_FLAGS=()
      mimic_prepare_build_options || return 1
      ( cd "$src_dir" && make "${MIMIC_BUILD_FLAGS[@]}" build-cli build-kmod ) \
        || { log "make failed with both kfunc and kprobe checksum support"; return 1; }
    else
      log "make failed; check that kernel headers and Mimic build dependencies are installed"
      return 1
    fi
  fi

  ko_file="$(find "$src_dir" -name "mimic.ko" | head -1)"
  [ -n "$ko_file" ] || { log "mimic.ko not found after build"; return 1; }

  kmod_dir="/lib/modules/$(uname -r)/updates/dkms"
  mkdir -p "$kmod_dir"
  install -m 0644 "$ko_file" "$kmod_dir/mimic.ko"
  depmod -a 2>/dev/null || true

  _install_mimic_binary_from_src "$src_dir" || return 1
  _install_mimic_service_from_src || return 1
  modprobe mimic \
    || { log "modprobe mimic failed; you may need to reboot or check Secure Boot / MOK signing"; return 1; }

  log "mimic kernel module loaded (no DKMS — will need recompile after kernel upgrade)"
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
        install_mimic_bpf_dropin || die "failed to install Mimic systemd capability drop-in"
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

  if [ "$install_ok" = "1" ]; then
    install_mimic_bpf_dropin || { log "failed to install Mimic systemd capability drop-in"; install_ok=0; }
  fi

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
