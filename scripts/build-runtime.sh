#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${FORWARDX_RUNTIME_OUT_DIR:-$ROOT_DIR/dist/agent}"
TARGET_ARCH="${1:-all}"
TARGET_OS="${FORWARDX_RUNTIME_GOOS:-linux}"

read_pin() {
  sed -nE "s/^export const $1 = \"([^\"]+)\";.*/\1/p" "$ROOT_DIR/shared/runtimeBuild.ts"
}
RUNTIME_VERSION="$(read_pin FORWARDX_RUNTIME_VERSION)"
UPSTREAM_VERSION="$(read_pin FORWARDX_RUNTIME_UPSTREAM_VERSION)"
SOURCE_COMMIT="$(read_pin FORWARDX_RUNTIME_SOURCE_COMMIT)"
SOURCE_SHA256="$(read_pin FORWARDX_RUNTIME_SOURCE_SHA256)"
[[ "$RUNTIME_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-forwardx\.[0-9]+$ ]]
[[ "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]]
[[ "$SOURCE_SHA256" =~ ^[a-f0-9]{64}$ ]]
if [ -n "${GOST_VERSION:-}" ] && [ "${GOST_VERSION#v}" != "$UPSTREAM_VERSION" ]; then
  echo "[runtime] GOST_VERSION differs from the pinned source; update shared/runtimeBuild.ts explicitly" >&2
  exit 1
fi
case "$TARGET_ARCH" in all) ARCHS=(amd64 arm64) ;; amd64|arm64) ARCHS=("$TARGET_ARCH") ;; *) echo "Unsupported architecture: $TARGET_ARCH" >&2; exit 1 ;; esac
case "$TARGET_OS" in linux|windows) ;; *) echo "Unsupported OS: $TARGET_OS" >&2; exit 1 ;; esac

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
SOURCE_TMP="$(mktemp -d)"
trap 'rm -rf -- "$SOURCE_TMP"' EXIT
SOURCE_URL="https://codeload.github.com/go-gost/gost/tar.gz/$SOURCE_COMMIT"
curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 --max-filesize 10485760 "$SOURCE_URL" -o "$SOURCE_TMP/source.tar.gz"
printf '%s  %s\n' "$SOURCE_SHA256" "$SOURCE_TMP/source.tar.gz" | sha256sum -c -
tar -xzf "$SOURCE_TMP/source.tar.gz" -C "$SOURCE_TMP"
SOURCE_DIR="$SOURCE_TMP/gost-$SOURCE_COMMIT"
MAIN_FILE="$SOURCE_DIR/cmd/gost/main.go"

# Change only the CLI product label; preserve upstream protocols, configuration,
# command flags, dependency checksums and attribution. Do not pack or obfuscate.
[ "$(grep -Fc 'fmt.Fprintf(os.Stdout, "gost %s' "$MAIN_FILE")" = 1 ]
sed -i 's/fmt.Fprintf(os.Stdout, "gost %s/fmt.Fprintf(os.Stdout, "forwardx-runtime %s/' "$MAIN_FILE"

ARTIFACTS=()
for arch in "${ARCHS[@]}"; do
  suffix=""
  [ "$TARGET_OS" != windows ] || suffix=".exe"
  artifact="$OUT_DIR/forwardx-runtime-$TARGET_OS-$arch$suffix"
  candidate="$artifact.building"
  echo "[runtime] building forwardx-runtime $RUNTIME_VERSION from go-gost $SOURCE_COMMIT for $TARGET_OS/$arch"
  (
    cd "$SOURCE_DIR"
    CGO_ENABLED=0 GOOS="$TARGET_OS" GOARCH="$arch" GOAMD64=v1 GOARM64=v8.0 \
      go build -mod=readonly -trimpath -buildvcs=false \
      -ldflags "-s -w -X main.version=$RUNTIME_VERSION" -o "$candidate" ./cmd/gost
  )
  # Distinguish the source build from the audited upstream release artifacts.
  # MD5 is a compatibility check only; SHA-256 below is the integrity checksum.
  md5="$(md5sum "$candidate" | awk '{print $1}')"
  case "$TARGET_OS/$arch/$md5" in
    linux/amd64/648f19f1688c7cd851593d7f9ed6110a|linux/arm64/72b04e24f8133035d10b651664a055df)
      rm -f -- "$candidate"
      echo "[runtime] unexpected upstream binary identity; refusing to publish" >&2
      exit 1 ;;
  esac
  mv -f -- "$candidate" "$artifact"
  ARTIFACTS+=("$artifact")
done
cp "$SOURCE_DIR/LICENSE" "$OUT_DIR/RUNTIME_LICENSE.txt"
{
  printf 'product=forwardx-runtime\nversion=%s\nupstream=go-gost/gost\nupstreamVersion=%s\nsourceCommit=%s\nsourceArchiveSHA256=%s\n' \
    "$RUNTIME_VERSION" "$UPSTREAM_VERSION" "$SOURCE_COMMIT" "$SOURCE_SHA256"
  go version
  printf '\nSHA256\n'
  (cd "$OUT_DIR"; for artifact in "${ARTIFACTS[@]}"; do sha256sum "$(basename "$artifact")"; done)
  printf '\nMD5 (not for integrity verification)\n'
  (cd "$OUT_DIR"; for artifact in "${ARTIFACTS[@]}"; do md5sum "$(basename "$artifact")"; done)
} > "$OUT_DIR/RUNTIME_BUILD.txt"
