# Served by the panel with PANEL_URL_DEFAULT set. Enrollment happens before
# invoking the existing installer, so released Agents and recovery commands
# retain the same configuration, encryption and installation identity protocol.
set -euo pipefail
umask 077
PANEL_URL="${PANEL_URL:-${PANEL_URL_DEFAULT:-}}"
PANEL_URL="${PANEL_URL%/}"
DISCOVERY_KEY="${1:-}"
CONFIG_DIR="${FORWARDX_DISCOVERY_CONFIG_DIR:-/etc/forwardx/agent}"
LEGACY_CONFIG_DIR="${FORWARDX_DISCOVERY_LEGACY_CONFIG_DIR:-/etc/forwardx-agent}"
if [ "$(id -u)" != 0 ]; then echo '[错误] 请使用 root 执行安装命令'; exit 1; fi
if [[ ! "$DISCOVERY_KEY" =~ ^[a-f0-9]{64}$ ]]; then echo '[错误] 自动发现密钥无效'; exit 1; fi
case "$PANEL_URL" in http://*|https://*) ;; *) echo '[错误] 面板地址无效'; exit 1 ;; esac
shift
fwx_agent_proxy_args install "$@" || exit 1
if ! command -v jq >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y jq
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache jq
  elif command -v dnf >/dev/null 2>&1; then dnf install -y jq
  elif command -v yum >/dev/null 2>&1; then yum install -y jq
  else echo '[错误] 请先安装 jq'; exit 1; fi
fi
mkdir -p "$CONFIG_DIR"
if command -v flock >/dev/null 2>&1; then
  exec 9> "$CONFIG_DIR/.discovery.lock"
  flock -n 9 || { echo '[错误] 本机已有安装任务正在运行，请稍后重试'; exit 1; }
fi
WORK="$(mktemp -d "$CONFIG_DIR/.discovery.XXXXXX")"
cleanup() { rm -f "$WORK/auth" "$WORK/payload" "$WORK/response" "$WORK/state" "$WORK/install.sh"; rmdir "$WORK"; }
trap cleanup EXIT
STATE="$CONFIG_DIR/discovery.json"
AGENT_TOKEN=''
# An already configured machine must keep its original identity and rules.
for file in "$CONFIG_DIR/config.json" "$LEGACY_CONFIG_DIR/config.json"; do
  if [ -f "$file" ] && [ "$(jq -r '.panelUrl // empty' "$file")" = "$PANEL_URL" ]; then
    AGENT_TOKEN="$(jq -r '.token // empty' "$file")"
    [ -z "$AGENT_TOKEN" ] || break
  fi
done
if [ -z "$AGENT_TOKEN" ] && [ -f "$STATE" ] && [ "$(jq -r '.panelUrl // empty' "$STATE")" = "$PANEL_URL" ]; then
  AGENT_TOKEN="$(jq -r '.token // empty' "$STATE")"
fi
# Fetch the installer before reserving credentials. Failed downloads leave the
# running Agent/configuration untouched.
curl -fsSL --connect-timeout 15 --max-time 120 "$PANEL_URL/api/agent/install.sh" -o "$WORK/install.sh"
[ -s "$WORK/install.sh" ] || exit 1
bash -n "$WORK/install.sh"
if [ -z "$AGENT_TOKEN" ]; then
  REGISTRATION_ID=''
  if [ -f "$STATE" ] && [ "$(jq -r '.panelUrl // empty' "$STATE")" = "$PANEL_URL" ]; then
    REGISTRATION_ID="$(jq -r '.registrationId // empty' "$STATE")"
  fi
  if [[ ! "$REGISTRATION_ID" =~ ^[a-f0-9]{64}$ ]]; then
    REGISTRATION_ID="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    [[ "$REGISTRATION_ID" =~ ^[a-f0-9]{64}$ ]] || exit 1
    jq -n --arg panelUrl "$PANEL_URL" --arg registrationId "$REGISTRATION_ID" \
      '{panelUrl:$panelUrl,registrationId:$registrationId}' > "$WORK/state"
    chmod 600 "$WORK/state"
    mv -f "$WORK/state" "$STATE"
  fi
  printf 'header = "Authorization: Bearer %s"\n' "$DISCOVERY_KEY" > "$WORK/auth"
  jq -n --arg registrationId "$REGISTRATION_ID" --arg hostname "$(hostname | cut -c1-120)" \
    '{registrationId:$registrationId,hostname:$hostname}' > "$WORK/payload"
  if ! curl -fsS --connect-timeout 15 --max-time 60 --config "$WORK/auth" \
    -H 'Content-Type: application/json' --data-binary "@$WORK/payload" \
    "$PANEL_URL/api/agent/discover" -o "$WORK/response"; then
    echo '[错误] 自动发现注册失败；请检查面板地址、接入开关与安装指令。可使用同一指令重试。'; exit 1
  fi
  AGENT_TOKEN="$(jq -er '.token | select(type == "string" and test("^[a-f0-9]{64}$"))' "$WORK/response")"
  jq -n --arg panelUrl "$PANEL_URL" --arg registrationId "$REGISTRATION_ID" --arg token "$AGENT_TOKEN" \
    '{panelUrl:$panelUrl,registrationId:$registrationId,token:$token}' > "$WORK/state"
  chmod 600 "$WORK/state"
  mv -f "$WORK/state" "$STATE"
  echo '[信息] 自动发现注册成功，继续安装 Agent；上线后会自动出现在面板。'
else
  echo '[信息] 使用本机已有 Agent 凭据恢复安装。'
fi
# Keep the enrollment lock in this shell, never in the installed service.
PANEL_URL="$PANEL_URL" bash "$WORK/install.sh" install "$AGENT_TOKEN" 9>&-
