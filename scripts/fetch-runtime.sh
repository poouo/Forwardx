#!/usr/bin/env bash
set -euo pipefail

# Release packaging consumes the exact binaries compiled on the maintainer's PC.
# Source compilation remains available separately via build-runtime.sh.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${FORWARDX_RUNTIME_OUT_DIR:-$ROOT_DIR/dist/agent}"
TARGET_ARCH="${1:-all}"
read_pin() {
  sed -nE "s/^export const $1 = \"([^\"]+)\";.*/\1/p" "$ROOT_DIR/shared/runtimeBuild.ts"
}
RUNTIME_VERSION="$(read_pin FORWARDX_RUNTIME_VERSION)"
UPSTREAM_VERSION="$(read_pin FORWARDX_RUNTIME_UPSTREAM_VERSION)"
RELEASE_TAG="$(read_pin FORWARDX_RUNTIME_RELEASE_TAG)"
[[ "$RUNTIME_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-forwardx\.[0-9]+$ ]]
[[ "$RELEASE_TAG" == "runtime-v$RUNTIME_VERSION" ]]
if [ -n "${GOST_VERSION:-}" ] && [ "${GOST_VERSION#v}" != "$UPSTREAM_VERSION" ]; then
  echo "[runtime] GOST_VERSION differs from the pinned runtime; update shared/runtimeBuild.ts explicitly" >&2
  exit 1
fi
case "$TARGET_ARCH" in all) ARCHS=(amd64 arm64) ;; amd64|arm64) ARCHS=("$TARGET_ARCH") ;; *) echo "Unsupported architecture: $TARGET_ARCH" >&2; exit 1 ;; esac
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
DOWNLOAD_TMP="$(mktemp -d "$OUT_DIR/.runtime-download.XXXXXX")"
trap 'rm -rf -- "$DOWNLOAD_TMP"' EXIT
BASE_URL="https://github.com/poouo/Forwardx/releases/download/$RELEASE_TAG"
ARTIFACTS=()
fetch_verified() {
  local file="$1" hash="$2" limit="$3"
  [[ "$hash" =~ ^[a-f0-9]{64}$ ]]
  echo "[runtime] downloading pinned $RELEASE_TAG/$file"
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 15 --max-time 180 \
    --max-filesize "$limit" "$BASE_URL/$file" -o "$DOWNLOAD_TMP/$file"
  printf '%s  %s\n' "$hash" "$DOWNLOAD_TMP/$file" | sha256sum -c -
  ARTIFACTS+=("$file")
}
for arch in "${ARCHS[@]}"; do
  case "$arch" in amd64) hash="$(read_pin FORWARDX_RUNTIME_AMD64_SHA256)" ;; arm64) hash="$(read_pin FORWARDX_RUNTIME_ARM64_SHA256)" ;; esac
  fetch_verified "forwardx-runtime-linux-$arch" "$hash" 104857600
  chmod 0755 "$DOWNLOAD_TMP/forwardx-runtime-linux-$arch"
done
fetch_verified RUNTIME_BUILD.txt "$(read_pin FORWARDX_RUNTIME_BUILD_SHA256)" 1048576
fetch_verified RUNTIME_LICENSE.txt "$(read_pin FORWARDX_RUNTIME_LICENSE_SHA256)" 1048576
# Never replace installed artifacts with a partial or unverified download.
for file in "${ARTIFACTS[@]}"; do
  mv -f -- "$DOWNLOAD_TMP/$file" "$OUT_DIR/$file"
done
