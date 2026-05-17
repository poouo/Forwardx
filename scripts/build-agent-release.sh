#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/dist/agent"
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
fi
VERSION="${VERSION#v}"

mkdir -p "$OUT_DIR"

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

if [ -n "${FORWARDX_FXP_RELEASE_DIR:-}" ]; then
  for arch in amd64 arm64; do
    src="$FORWARDX_FXP_RELEASE_DIR/forwardx-fxp-linux-$arch"
    if [ -f "$src" ]; then
      cp "$src" "$OUT_DIR/forwardx-fxp-linux-$arch"
      chmod 0755 "$OUT_DIR/forwardx-fxp-linux-$arch"
      echo "[agent] bundled closed runtime -> forwardx-fxp-linux-$arch"
    fi
  done
fi

sha256sum "$OUT_DIR"/forwardx-agent-linux-* > "$OUT_DIR"/SHA256SUMS

echo "[agent] release artifacts:"
ls -lh "$OUT_DIR"
