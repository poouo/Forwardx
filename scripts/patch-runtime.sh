#!/usr/bin/env bash
set -euo pipefail

# Work only on the build's private source copy, NEVER edit the shared Go cache.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$(cd "${1:?runtime source directory required}" && pwd)"
cd "$SOURCE_DIR"
VERSION="$(go list -m -f '{{.Version}}' github.com/go-gost/x)"
[ "$VERSION" = v0.8.1 ] || { echo "[runtime] unsupported go-gost/x version: $VERSION" >&2; exit 1; }
go mod download "github.com/go-gost/x@$VERSION"
MODULE_DIR="$(go list -m -f '{{.Dir}}' github.com/go-gost/x)"
[ -n "$MODULE_DIR" ] && [ -d "$MODULE_DIR" ]
[ ! -e "$SOURCE_DIR/.forwardx-gost-x" ]
mkdir "$SOURCE_DIR/.forwardx-gost-x"
cp -R "$MODULE_DIR/." "$SOURCE_DIR/.forwardx-gost-x/"
chmod -R u+w "$SOURCE_DIR/.forwardx-gost-x"
PATCHED="$SOURCE_DIR/.forwardx-gost-x"
cp "$ROOT_DIR/scripts/runtime-patches/selector/forwardx_failover"*.go "$PATCHED/selector/"
PARSER="$PATCHED/config/parsing/selector/parse.go"
[ "$(grep -Fc 'strategy = xs.FIFOStrategy[*chain.Node]()' "$PARSER")" = 1 ]
sed -i 's/strategy = xs.FIFOStrategy\[\*chain.Node\]()/return xs.ForwardXFailoverNodeSelector(cfg.MaxFails, cfg.FailTimeout)/' "$PARSER"
go mod edit -replace=github.com/go-gost/x=./.forwardx-gost-x
# Test the exact dependency source subsequently linked into the runtime.
(cd "$PATCHED"; go test ./selector ./config/parsing/selector)
