#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/agent"
GO_CACHE_ROOT="${GOCACHE:-}"
GO_HOME_ROOT="${HOME:-}"
XDG_CACHE_ROOT="${XDG_CACHE_HOME:-}"
REQUESTED_TAG="${1:-}"
MIN_GO_MAJOR=1
MIN_GO_MINOR=22
GOST_VERSION="${GOST_VERSION:-3.2.6}"
UDP2RAW_VERSION="${UDP2RAW_VERSION:-20230206.0}"
UDP2RAW_SOURCE_DIR="${UDP2RAW_SOURCE_DIR:-$ROOT_DIR/udp2raw}"
GOST_VERSION="${GOST_VERSION#v}"
AGENT_VERSION="$(sed -nE "s/.*AGENT_VERSION[[:space:]]*=[[:space:]]*['\"]([^'\"]+)['\"].*/\1/p" "$ROOT_DIR/shared/versions.ts" | head -n 1)"
if [ -z "$AGENT_VERSION" ]; then
  echo "[agent] AGENT_VERSION not found in shared/versions.ts" >&2
  exit 1
fi
VERSION="${AGENT_VERSION#v}"
if [ -n "$REQUESTED_TAG" ] && [ "${REQUESTED_TAG#v}" != "$VERSION" ]; then
  echo "[agent] release tag ${REQUESTED_TAG} detected; building Agent version ${VERSION} from shared/versions.ts"
fi

go_version_number() {
  go version 2>/dev/null | awk '{print $3}' | sed -E 's/^go//; s/[^0-9.].*$//'
}

go_version_supported() {
  local version="$1"
  local major minor patch
  IFS=. read -r major minor patch <<EOF
$version
EOF
  major="${major:-0}"
  minor="${minor:-0}"
  [[ "$major" =~ ^[0-9]+$ ]] || return 1
  [[ "$minor" =~ ^[0-9]+$ ]] || minor=0
  if [ "$major" -gt "$MIN_GO_MAJOR" ]; then
    return 0
  fi
  [ "$major" -eq "$MIN_GO_MAJOR" ] && [ "$minor" -ge "$MIN_GO_MINOR" ]
}

if ! command -v go >/dev/null 2>&1; then
  echo "[agent] Go ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+ is required to build Agent/FXP, but go was not found" >&2
  exit 1
fi
GO_VERSION="$(go_version_number)"
if ! go_version_supported "$GO_VERSION"; then
  echo "[agent] Go ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+ is required to build Agent/FXP; current version is ${GO_VERSION:-unknown}" >&2
  echo "[agent] Run scripts/install-panel-local.sh again or install a newer Go under /usr/local/go" >&2
  exit 1
fi
echo "[agent] using Go $GO_VERSION ($(command -v go))"

mkdir -p "$OUT_DIR"
if [ -z "$GO_CACHE_ROOT" ]; then GO_CACHE_ROOT="$ROOT_DIR/.cache/go-build"; fi
if [ -z "$GO_HOME_ROOT" ]; then GO_HOME_ROOT="$ROOT_DIR/.cache/home"; fi
if [ -z "$XDG_CACHE_ROOT" ]; then XDG_CACHE_ROOT="$ROOT_DIR/.cache"; fi
mkdir -p "$GO_CACHE_ROOT" "$GO_HOME_ROOT" "$XDG_CACHE_ROOT"
export GOCACHE="$GO_CACHE_ROOT"
export HOME="$GO_HOME_ROOT"
export XDG_CACHE_HOME="$XDG_CACHE_ROOT"

build_one() {
  local goarch="$1"
  local out="$2"
  echo "[agent] building linux/$goarch -> $out"
  (
    cd "$ROOT_DIR/agent"
    CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
      go build -trimpath -ldflags "-s -w -X main.Version=$VERSION" -o "$OUT_DIR/$out" .
  )
}

build_one amd64 forwardx-agent-linux-amd64
build_one arm64 forwardx-agent-linux-arm64

build_fxp() {
  local goarch="$1"
  local out="$2"
  echo "[fxp] building linux/$goarch -> $out"
  (
    cd "$ROOT_DIR/forwardx-fxp"
    CGO_ENABLED=0 GOOS=linux GOARCH="$goarch" \
      go build -trimpath -ldflags "-s -w" -o "$OUT_DIR/$out" .
  )
}

build_fxp amd64 forwardx-fxp-linux-amd64
build_fxp arm64 forwardx-fxp-linux-arm64

download_gost_runtime() {
  local gost_arch="$1"
  local out="$2"
  local tmp url gost_bin
  echo "[runtime] downloading go-gost v${GOST_VERSION} linux/${gost_arch} -> ${out}"
  tmp="$(mktemp -d)"
  url="https://github.com/go-gost/gost/releases/download/v${GOST_VERSION}/gost_${GOST_VERSION}_linux_${gost_arch}.tar.gz"
  rm -f "$OUT_DIR/$out"
  curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 -o "$tmp/gost.tgz" "$url"
  tar -xzf "$tmp/gost.tgz" -C "$tmp"
  gost_bin="$(find "$tmp" -type f -name gost | head -n1)"
  if [ -z "$gost_bin" ]; then
    echo "[runtime] gost binary not found in ${url}" >&2
    rm -rf "$tmp"
    exit 1
  fi
  install -m 0755 "$gost_bin" "$OUT_DIR/$out"
  rm -rf "$tmp"
}

download_gost_runtime amd64 forwardx-runtime-linux-amd64
download_gost_runtime arm64 forwardx-runtime-linux-arm64

download_udp2raw_runtime() {
  local arch="$1"
  local out="$2"
  local tmp url bin
  if [ -f "$UDP2RAW_SOURCE_DIR/main.cpp" ]; then
    build_udp2raw_from_source "$arch" "$out"
    return 0
  fi

  echo "[udp2raw] downloading udp2raw ${UDP2RAW_VERSION} ${arch} -> ${out}"
  tmp="$(mktemp -d)"
  url="https://github.com/wangyu-/udp2raw/releases/download/${UDP2RAW_VERSION}/udp2raw_binaries.tar.gz"
  rm -f "$OUT_DIR/$out"
  if curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 -o "$tmp/udp2raw.tgz" "$url"; then
    tar -xzf "$tmp/udp2raw.tgz" -C "$tmp"
    case "$arch" in
      amd64) bin="$(find "$tmp" -type f \( -name udp2raw_amd64 -o -name udp2raw_x86_64 -o -name udp2raw_amd64_hw_aes \) | head -n1)" ;;
      arm64) bin="$(find "$tmp" -type f \( -name udp2raw_arm64 -o -name udp2raw_aarch64 \) | head -n1)" ;;
      *) bin="" ;;
    esac
    if [ -n "$bin" ]; then
      install -m 0755 "$bin" "$OUT_DIR/$out"
      rm -rf "$tmp"
      return 0
    fi
    echo "[udp2raw] official binary not found for ${arch}; building from source" >&2
    find "$tmp" -type f >&2 || true
  else
    echo "[udp2raw] official binary download failed; building from source" >&2
  fi
  rm -rf "$tmp"
  build_udp2raw_from_source "$arch" "$out"
}

build_udp2raw_from_source() {
  local arch="$1"
  local out="$2"
  local tmp url root cxx bin source_dir
  case "$arch" in
    amd64) cxx="${UDP2RAW_CXX_AMD64:-g++}" ;;
    arm64) cxx="${UDP2RAW_CXX_ARM64:-aarch64-linux-gnu-g++}" ;;
    *) echo "[udp2raw] unsupported source build arch: ${arch}" >&2; exit 1 ;;
  esac
  if ! command -v "$cxx" >/dev/null 2>&1; then
    echo "[udp2raw] ${cxx} is required to build udp2raw for ${arch}" >&2
    exit 1
  fi

  tmp="$(mktemp -d)"
  mkdir -p "$tmp/src"
  source_dir="$UDP2RAW_SOURCE_DIR"
  if [ -f "$source_dir/main.cpp" ]; then
    echo "[udp2raw] building bundled source ${arch} from ${source_dir} with ${cxx}"
    cp -a "$source_dir/." "$tmp/src/"
  else
    url="https://github.com/wangyu-/udp2raw/archive/refs/tags/${UDP2RAW_VERSION}.tar.gz"
    echo "[udp2raw] bundled source not found; building ${UDP2RAW_VERSION} ${arch} from ${url} with ${cxx}"
    curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 -o "$tmp/udp2raw-src.tgz" "$url"
    tar -xzf "$tmp/udp2raw-src.tgz" -C "$tmp/src" --strip-components=1
  fi
  root="$tmp/src"
  bin="$tmp/udp2raw-${arch}"
  (
    cd "$root"
    printf 'const char *gitversion = "%s";\n' "$UDP2RAW_VERSION" > git_version.h
    if ! "$cxx" -o "$bin" \
      -I. \
      main.cpp lib/md5.cpp lib/pbkdf2-sha1.cpp lib/pbkdf2-sha256.cpp \
      encrypt.cpp log.cpp network.cpp common.cpp connection.cpp misc.cpp \
      fd_manager.cpp client.cpp server.cpp lib/aes_faster_c/aes.cpp \
      lib/aes_faster_c/wrapper.cpp my_ev.cpp \
      -isystem libev \
      -std=c++11 -Wall -Wextra -Wno-unused-variable -Wno-unused-parameter \
      -Wno-missing-field-initializers -lrt -lpthread -static -O2; then
      echo "[udp2raw] static source build failed for ${arch}; retrying dynamic link" >&2
      "$cxx" -o "$bin" \
        -I. \
        main.cpp lib/md5.cpp lib/pbkdf2-sha1.cpp lib/pbkdf2-sha256.cpp \
        encrypt.cpp log.cpp network.cpp common.cpp connection.cpp misc.cpp \
        fd_manager.cpp client.cpp server.cpp lib/aes_faster_c/aes.cpp \
        lib/aes_faster_c/wrapper.cpp my_ev.cpp \
        -isystem libev \
        -std=c++11 -Wall -Wextra -Wno-unused-variable -Wno-unused-parameter \
        -Wno-missing-field-initializers -lrt -lpthread -O2
    fi
  )
  install -m 0755 "$bin" "$OUT_DIR/$out"
  rm -rf "$tmp"
}

download_udp2raw_runtime amd64 forwardx-udp2raw-linux-amd64
download_udp2raw_runtime arm64 forwardx-udp2raw-linux-arm64

artifacts=("$OUT_DIR"/forwardx-agent-linux-*)
if compgen -G "$OUT_DIR/forwardx-fxp-linux-*" >/dev/null; then
  artifacts+=("$OUT_DIR"/forwardx-fxp-linux-*)
fi
if compgen -G "$OUT_DIR/forwardx-runtime-linux-*" >/dev/null; then
  artifacts+=("$OUT_DIR"/forwardx-runtime-linux-*)
fi
if compgen -G "$OUT_DIR/forwardx-udp2raw-linux-*" >/dev/null; then
  artifacts+=("$OUT_DIR"/forwardx-udp2raw-linux-*)
fi
sha256sum "${artifacts[@]}" > "$OUT_DIR"/SHA256SUMS

echo "[agent] release artifacts:"
ls -lh "$OUT_DIR"
