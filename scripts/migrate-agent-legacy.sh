#!/bin/bash
set -euo pipefail

APPLY=false
PLUGIN_ROOT="${FORWARDX_AGENT_PLUGIN_ROOT:-/var/lib/forwardx-agent/plugins}"
STATE_ROOT="${FORWARDX_AGENT_STATE_DIR:-/var/lib/forwardx-agent}"
MIGRATION_ID="legacy-compat-v1"

usage() {
  cat <<'EOF'
ForwardX Agent legacy plugin manifest migration

Usage:
  bash migrate-agent-legacy.sh
  bash migrate-agent-legacy.sh --apply
  bash migrate-agent-legacy.sh --root /var/lib/forwardx-agent/plugins [--apply]

The default mode is read-only. --apply atomically converts pluginVersion to
version and removes pluginVersion. It does not upgrade or restart the Agent.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)
      APPLY=true
      shift
      ;;
    --root)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "[ERROR] --root requires a directory" >&2
        exit 1
      fi
      PLUGIN_ROOT="$2"
      shift 2
      ;;
    --root=*)
      PLUGIN_ROOT="${1#--root=}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[ERROR] Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "[ERROR] jq is required. Install jq, then run this script again." >&2
  exit 1
fi

if [ ! -d "$PLUGIN_ROOT" ]; then
  echo "[INFO] Plugin directory does not exist: $PLUGIN_ROOT"
  echo "[DONE] No Agent plugin manifests require migration."
  exit 0
fi

pending=0
migrated=0
current=0
unresolved=0

while IFS= read -r -d '' manifest; do
  plugin_id="$(basename "$(dirname "$manifest")")"
  case "$plugin_id" in
    .*) continue ;;
  esac

  if ! jq -e 'type == "object"' "$manifest" >/dev/null 2>&1; then
    echo "[WARN] $plugin_id: manifest is not valid JSON; re-sync this plugin."
    unresolved=$((unresolved + 1))
    continue
  fi

  version="$(jq -r 'if (.version | type) == "string" then (.version | gsub("^\\s+|\\s+$"; "")) else "" end' "$manifest")"
  legacy_version="$(jq -r 'if (.pluginVersion | type) == "string" then (.pluginVersion | gsub("^\\s+|\\s+$"; "")) else "" end' "$manifest")"

  if [ -z "$legacy_version" ]; then
    if [ -n "$version" ]; then
      current=$((current + 1))
    else
      echo "[WARN] $plugin_id: manifest has no version; re-sync this plugin."
      unresolved=$((unresolved + 1))
    fi
    continue
  fi

  pending=$((pending + 1))
  if [ -n "$version" ] && [ "$version" != "$legacy_version" ]; then
    echo "[WARN] $plugin_id: version=$version differs from pluginVersion=$legacy_version; keeping version."
  elif [ -z "$version" ]; then
    echo "[PENDING] $plugin_id: pluginVersion=$legacy_version -> version=$legacy_version"
  else
    echo "[PENDING] $plugin_id: remove obsolete pluginVersion=$legacy_version"
  fi

  if [ "$APPLY" != "true" ]; then
    continue
  fi

  tmp="$(mktemp "${manifest}.tmp.XXXXXX")"
  if ! jq '
    def clean:
      if type == "string" then gsub("^\\s+|\\s+$"; "") else "" end;
    if ((.version | clean) == "") and ((.pluginVersion | clean) != "")
    then .version = (.pluginVersion | clean)
    else .
    end
    | del(.pluginVersion)
  ' "$manifest" > "$tmp"; then
    rm -f "$tmp"
    echo "[WARN] $plugin_id: failed to rewrite manifest." >&2
    unresolved=$((unresolved + 1))
    continue
  fi
  chmod --reference="$manifest" "$tmp" 2>/dev/null || chmod 0644 "$tmp"
  chown --reference="$manifest" "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$manifest"
  migrated=$((migrated + 1))
done < <(find "$PLUGIN_ROOT" -mindepth 2 -maxdepth 2 -type f -name manifest.json -print0)

echo "[SUMMARY] current=$current pending=$pending migrated=$migrated unresolved=$unresolved"

if [ "$APPLY" != "true" ]; then
  echo "[INFO] Check only: no files were changed. Re-run with --apply to migrate."
elif [ "$unresolved" -eq 0 ]; then
  mkdir -p "$STATE_ROOT"
  marker="${STATE_ROOT}/${MIGRATION_ID}.json"
  marker_tmp="$(mktemp "${marker}.tmp.XXXXXX")"
  jq -n --arg migrationId "$MIGRATION_ID" --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson migrated "$migrated" '{migrationId: $migrationId, completedAt: $completedAt, migrated: $migrated}' > "$marker_tmp"
  chmod 0644 "$marker_tmp"
  mv -f -- "$marker_tmp" "$marker"
  echo "[DONE] Agent plugin manifests migrated. Upgrade to Agent 2.2.151+ and re-sync plugins."
else
  echo "[WARN] Migration completed with unresolved manifests. Re-sync the listed plugins." >&2
  exit 2
fi
