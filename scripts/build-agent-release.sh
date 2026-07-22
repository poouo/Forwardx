#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/agent"
GO_CACHE_ROOT="${GOCACHE:-}"
GO_HOME_ROOT="${HOME:-}"
XDG_CACHE_ROOT="${XDG_CACHE_HOME:-}"
REQUESTED_TAG="${1:-}"
MIN_GO_MAJOR=1
MIN_GO_MINOR=23
GOST_VERSION="${GOST_VERSION:-3.2.6}"
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


artifacts=("$OUT_DIR"/forwardx-agent-linux-*)
if compgen -G "$OUT_DIR/forwardx-fxp-linux-*" >/dev/null; then
  artifacts+=("$OUT_DIR"/forwardx-fxp-linux-*)
fi
if compgen -G "$OUT_DIR/forwardx-runtime-linux-*" >/dev/null; then
  artifacts+=("$OUT_DIR"/forwardx-runtime-linux-*)
fi
sha256sum "${artifacts[@]}" > "$OUT_DIR"/SHA256SUMS

echo "[agent] release artifacts:"
ls -lh "$OUT_DIR"
