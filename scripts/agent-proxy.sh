# Shared by the self-contained Agent installer and management command.
# No proxy credentials are printed, sourced as shell code, or put in curl argv.
fwx_proxy_normalize() {
  local value="$1" endpoint authority port
  [ -z "$value" ] && return 0
  case "$value" in http://*|https://*|socks5://*|socks5h://*) ;; *) echo '[ERROR] Proxy scheme must be http, https, socks5 or socks5h.' >&2; return 1 ;; esac
  case "$value" in *$'\n'*|*$'\r'*|*$'\t'*|*' '*|*'?'*|*'#'*) echo '[ERROR] Invalid proxy URL; URL-encode credentials.' >&2; return 1 ;; esac
  authority="${value#*://}"
  case "$authority" in */*|'') echo '[ERROR] Proxy URL must contain host:port without a path.' >&2; return 1 ;; esac
  endpoint="${authority##*@}"
  port="${endpoint##*:}"
  case "$port" in ''|*[!0-9]*) echo '[ERROR] Proxy requires a numeric port.' >&2; return 1 ;; esac
  if [ "${#port}" -gt 5 ] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ] || [ "$endpoint" = "$port" ] || [ "${endpoint%:*}" = '' ]; then
    echo '[ERROR] Proxy requires a host and port between 1 and 65535.' >&2; return 1
  fi
  case "$value" in socks5://*) value="socks5h://${value#socks5://}" ;; esac
  printf '%s' "$value"
}

fwx_proxy_environment() {
  local value
  value="$(fwx_proxy_normalize "$1")" || return 1
  # Explicit direct means direct, regardless of inherited shell variables.
  unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY no_proxy NO_PROXY
  export http_proxy="$value" https_proxy="$value" all_proxy="$value"
  export HTTP_PROXY="$value" HTTPS_PROXY="$value" ALL_PROXY="$value" no_proxy='' NO_PROXY=''
}

fwx_agent_proxy_args() {
  ACTION='' TOKEN=''
  FWX_PROXY_EXPLICIT=false
  if [ "${FORWARDX_AGENT_PROXY+x}" = x ]; then FWX_PROXY_EXPLICIT=true; fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      install|upgrade|update|uninstall|remove|delete)
        [ -z "$ACTION" ] || { echo '[ERROR] Multiple actions.' >&2; return 1; }
        ACTION="$1"; shift ;;
      --proxy)
        [ "$#" -ge 2 ] && [ -n "$2" ] || { echo '[ERROR] --proxy requires a URL.' >&2; return 1; }
        FORWARDX_AGENT_PROXY="$2"; FWX_PROXY_EXPLICIT=true; shift 2 ;;
      --proxy=*) FORWARDX_AGENT_PROXY="${1#*=}"; FWX_PROXY_EXPLICIT=true; shift ;;
      --no-proxy) FORWARDX_AGENT_PROXY=''; FWX_PROXY_EXPLICIT=true; shift ;;
      -h|--help) ACTION=help; shift ;;
      --*) echo "[ERROR] Unknown option: ${1%%=*}" >&2; return 1 ;;
      *) [ -z "$TOKEN" ] || { echo '[ERROR] Unexpected argument.' >&2; return 1; }; TOKEN="$1"; shift ;;
    esac
  done
  # Offline removal/help must also work with a broken config or missing jq.
  case "$ACTION" in uninstall|remove|delete|help|'') return 0 ;; esac
  if [ "$FWX_PROXY_EXPLICIT" != true ]; then
    FORWARDX_AGENT_PROXY=''
    local file
    for file in "$CONFIG_DIR/config.json" "$LEGACY_CONFIG_DIR/config.json"; do
      if [ -f "$file" ]; then
        command -v jq >/dev/null 2>&1 || { echo '[ERROR] jq is required to safely read existing proxy settings.' >&2; return 1; }
        FORWARDX_AGENT_PROXY="$(jq -er 'if type == "object" and (.proxyUrl == null or (.proxyUrl | type == "string")) then (.proxyUrl // "") else error("invalid proxy config") end' "$file" 2>/dev/null)" || { echo '[ERROR] Invalid Agent proxy configuration.' >&2; return 1; }
        break
      fi
    done
  fi
  FORWARDX_AGENT_PROXY="$(fwx_proxy_normalize "$FORWARDX_AGENT_PROXY")" || return 1
  export FORWARDX_AGENT_PROXY
  fwx_proxy_environment "$FORWARDX_AGENT_PROXY"
}

fwx_agent_proxy_save() {
  local file="$CONFIG_DIR/config.json" tmp
  tmp="$(mktemp "$CONFIG_DIR/.proxy-config.XXXXXX")" || return 1
  if jq --arg proxy "$FORWARDX_AGENT_PROXY" 'if type == "object" then .proxyUrl = $proxy else error("invalid config") end' "$file" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$file"; then return 0; fi
  rm -f "$tmp"
  echo '[ERROR] Cannot save Agent proxy configuration.' >&2
  return 1
}
