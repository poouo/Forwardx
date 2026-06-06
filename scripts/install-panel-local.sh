#!/bin/bash
set -euo pipefail

ACTION="${1:-install}"
APP_DIR="${FORWARDX_PANEL_DIR:-/opt/forwardx-panel}"
SERVICE_NAME="${FORWARDX_SERVICE_NAME:-forwardx-panel}"
REPO_URL="${FORWARDX_REPO_URL:-https://github.com/poouo/Forwardx.git}"
PORT="${PORT:-3000}"
MIN_GO_MAJOR=1
MIN_GO_MINOR=22
DEFAULT_GO_VERSION="${FORWARDX_GO_VERSION:-1.22.12}"

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

get_env_value() {
  local key="$1"
  local file="$APP_DIR/.env"
  if [ ! -f "$file" ]; then
    return 0
  fi
  grep -E "^${key}=" "$file" | tail -1 | sed -E "s/^${key}=//; s/^\"//; s/\"$//"
}

read_install_port() {
  local default_port="${PORT:-3000}"
  local input=""

  if ! valid_port "$default_port"; then
    default_port="3000"
  fi

  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    PORT="$default_port"
    echo "[信息] 非交互环境，使用默认 Web 端口：$PORT"
    return
  fi

  while true; do
    printf "请输入 Web 服务监听端口 [默认 %s]: " "$default_port" > /dev/tty
    IFS= read -r input < /dev/tty || input=""
    input="${input//[[:space:]]/}"
    if [ -z "$input" ]; then
      PORT="$default_port"
      return
    fi
    if valid_port "$input"; then
      PORT="$input"
      return
    fi
    echo "[错误] 端口必须是 1-65535 的数字，请重新输入。" > /dev/tty
  done
}

resolve_runtime_env() {
  local existing_port existing_jwt
  existing_port="$(get_env_value PORT || true)"
  existing_jwt="$(get_env_value JWT_SECRET || true)"

  if [ -n "$existing_port" ] && valid_port "$existing_port"; then
    PORT="$existing_port"
  elif ! valid_port "$PORT"; then
    PORT="3000"
  fi

  if [ -z "${JWT_SECRET:-}" ] && [ -n "$existing_jwt" ]; then
    JWT_SECRET="$existing_jwt"
  fi
}

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[错误] 请使用 root 权限运行"
    exit 1
  fi
}

confirm_yes() {
  local prompt="$1"
  local answer=""

  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf "%s" "$prompt" > /dev/tty
    IFS= read -r answer < /dev/tty || answer=""
  else
    echo "[信息] 非交互环境，默认选择 N：$prompt"
  fi

  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

latest_tag() {
  git -C "$APP_DIR" tag --sort=-v:refname | head -1 || true
}

fetch_source_refs() {
  git -C "$APP_DIR" fetch --force --prune origin \
    "+refs/heads/*:refs/remotes/origin/*" \
    "+refs/tags/*:refs/tags/*"
}

git_ref_exists() {
  git -C "$APP_DIR" rev-parse --verify --quiet "$1^{commit}" >/dev/null
}

resolve_checkout_target() {
  local target="$1"
  local without_v=""

  if [ -z "$target" ]; then
    return 1
  fi
  if git_ref_exists "$target"; then
    printf '%s\n' "$target"
    return 0
  fi
  without_v="${target#v}"
  if [ "$target" = "$without_v" ] && git_ref_exists "v$target"; then
    printf 'v%s\n' "$target"
    return 0
  fi
  if [ "$target" != "$without_v" ] && git_ref_exists "$without_v"; then
    printf '%s\n' "$without_v"
    return 0
  fi

  return 1
}

go_version_number() {
  local bin="$1"
  "$bin" version 2>/dev/null | awk '{print $3}' | sed -E 's/^go//; s/[^0-9.].*$//'
}

go_version_at_least() {
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

link_official_go_commands() {
  if [ -x /usr/local/go/bin/go ]; then
    ln -sf /usr/local/go/bin/go /usr/local/bin/go
  fi
  if [ -x /usr/local/go/bin/gofmt ]; then
    ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
  fi
}

select_supported_go() {
  local bin version dir
  local candidates=()

  [ -n "${FORWARDX_GO_BIN:-}" ] && candidates+=("$FORWARDX_GO_BIN")
  candidates+=("/usr/local/go/bin/go")
  if command -v go >/dev/null 2>&1; then
    candidates+=("$(command -v go)")
  fi
  candidates+=("/usr/bin/go")

  for bin in "${candidates[@]}"; do
    [ -n "$bin" ] || continue
    [ -x "$bin" ] || continue
    version="$(go_version_number "$bin")"
    if go_version_at_least "$version"; then
      dir="$(dirname "$bin")"
      if [ "$bin" = "/usr/local/go/bin/go" ]; then
        link_official_go_commands
      fi
      export PATH="$dir:$PATH"
      hash -r 2>/dev/null || true
      echo "[信息] 使用 Go $version ($bin)"
      return 0
    fi
  done

  return 1
}

install_official_go() {
  local arch goarch tmp url
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) goarch="amd64" ;;
    aarch64|arm64) goarch="arm64" ;;
    armv6l|armv7l) goarch="armv6l" ;;
    *)
      echo "[错误] 当前架构 $arch 不支持自动安装官方 Go，请手动安装 Go ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+ 后重试"
      return 1
      ;;
  esac

  url="${FORWARDX_GO_DOWNLOAD_URL:-https://go.dev/dl/go${DEFAULT_GO_VERSION}.linux-${goarch}.tar.gz}"
  tmp="$(mktemp -d)"
  echo "[信息] 当前 Go 版本不足，安装官方 Go ${DEFAULT_GO_VERSION}..."
  if ! curl -fsSL --retry 3 --connect-timeout 10 "$url" -o "$tmp/go.tgz"; then
    rm -rf "$tmp"
    echo "[错误] Go 下载失败：$url"
    return 1
  fi

  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$tmp/go.tgz"
  rm -rf "$tmp"
  export PATH="/usr/local/go/bin:$PATH"
  hash -r 2>/dev/null || true
  select_supported_go
}

ensure_go_version() {
  export PATH="/usr/local/go/bin:$PATH"
  hash -r 2>/dev/null || true
  if select_supported_go; then
    return 0
  fi
  install_official_go || {
    echo "[错误] Go ${MIN_GO_MAJOR}.${MIN_GO_MINOR}+ 安装失败，无法构建 Agent/FXP"
    exit 1
  }
}

install_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl git ca-certificates build-essential python3 openssl tar nftables >/dev/null
    if ! command -v node >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y -qq nodejs >/dev/null
    fi
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl git ca-certificates gcc gcc-c++ make python3 openssl tar nftables nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl git ca-certificates gcc gcc-c++ make python3 openssl tar nftables nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl git ca-certificates build-base python3 openssl tar nftables nodejs npm
  fi

  command -v node >/dev/null 2>&1 || { echo "[错误] Node.js 安装失败，请先安装 Node.js 22+"; exit 1; }
  ensure_go_version
  corepack enable >/dev/null 2>&1 || npm install -g pnpm@10
  corepack prepare pnpm@10 --activate >/dev/null 2>&1 || npm install -g pnpm@10
}

sync_source() {
  local target="${FORWARDX_TARGET_VERSION:-}"
  local resolved_target=""
  local env_backup=""
  local data_backup=""
  if [ -f "$APP_DIR/.env" ]; then
    env_backup="$(mktemp /tmp/forwardx-env.XXXXXX)"
    cp "$APP_DIR/.env" "$env_backup"
  fi
  if [ -d "$APP_DIR/data" ]; then
    data_backup="$(mktemp -d /tmp/forwardx-data.XXXXXX)"
    cp -a "$APP_DIR/data/." "$data_backup/"
  fi
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" remote set-url origin "$REPO_URL" || true
    fetch_source_refs
  else
    rm -rf "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
    if [ -n "$env_backup" ] && [ -f "$env_backup" ]; then
      cp "$env_backup" "$APP_DIR/.env"
    fi
    if [ -n "$data_backup" ] && [ -d "$data_backup" ]; then
      mkdir -p "$APP_DIR/data"
      cp -a "$data_backup/." "$APP_DIR/data/"
    fi
    fetch_source_refs
  fi
  if [ -n "$env_backup" ] && [ -f "$env_backup" ]; then
    rm -f "$env_backup"
  fi
  if [ -n "$data_backup" ] && [ -d "$data_backup" ]; then
    rm -rf "$data_backup"
  fi

  if [ -n "$target" ]; then
    if resolved_target="$(resolve_checkout_target "$target")"; then
      :
    elif [ "$ACTION" = "upgrade" ] || [ "$ACTION" = "update" ]; then
      echo "[信息] 未找到目标版本 $target，改为使用 origin/main"
      resolved_target="origin/main"
    else
      echo "[错误] 未找到目标版本 $target"
      exit 1
    fi
  elif [ "$ACTION" = "upgrade" ] || [ "$ACTION" = "update" ]; then
    # Manual one-click upgrade should always refresh to latest main commit,
    # even when version number is unchanged.
    resolved_target="origin/main"
  else
    resolved_target="$(latest_tag)"
    if [ -z "$resolved_target" ]; then
      resolved_target="origin/main"
    fi
  fi

  git -C "$APP_DIR" checkout -f "$resolved_target"
  if [ "$resolved_target" = "origin/main" ]; then
    git -C "$APP_DIR" checkout -B main origin/main
  fi
}

build_panel() {
  cd "$APP_DIR"
  pnpm install --prod=false
  pnpm build
  bash scripts/build-agent-release.sh
}

write_env() {
  local jwt_secret="${JWT_SECRET:-}"
  if [ -z "$jwt_secret" ]; then
    jwt_secret="$(openssl rand -hex 32 2>/dev/null || date +%s%N | sha256sum | awk '{print $1}')"
  fi

  mkdir -p "$APP_DIR/data"
  cat > "$APP_DIR/.env" <<EOF
NODE_ENV=production
PORT=$PORT
DATABASE_CONFIG_PATH=$APP_DIR/data/database.json
SQLITE_PATH=$APP_DIR/data/forwardx.db
MYSQL_CONFIG_PATH=$APP_DIR/data/mysql.json
JWT_SECRET=$jwt_secret
FORWARDX_PORT_CONFIG_PATH=$APP_DIR/.env
FORWARDX_PORT_MANAGEMENT=local
FORWARDX_UPGRADE_COMMAND="/bin/bash $APP_DIR/scripts/install-panel-local.sh upgrade"
EOF
}

write_service() {
  cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=ForwardX Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$(command -v node) dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
}

install_panel() {
  require_root
  resolve_runtime_env
  read_install_port
  install_deps
  sync_source
  build_panel
  write_env
  write_service
  systemctl restart "$SERVICE_NAME"
  echo "[完成] ForwardX 面板已启动：http://服务器IP:$PORT"
  echo "[信息] 首次打开面板后请配置 MySQL；如果连接旧数据库，将自动复用原有管理员和数据。"
}

upgrade_panel() {
  require_root
  resolve_runtime_env
  install_deps
  sync_source
  build_panel
  write_env
  write_service
  systemctl restart "$SERVICE_NAME"
  echo "[完成] ForwardX 面板已升级并重启"
}

uninstall_panel() {
  require_root
  if ! confirm_yes "确认卸载 ForwardX 本地面板，并删除服务和程序目录 $APP_DIR ? [y/N] "; then
    echo "[取消] 未执行卸载"
    return
  fi
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload

  rm -rf "$APP_DIR"
  echo "[完成] 已卸载 ForwardX 本地面板并删除程序目录"
}

case "$ACTION" in
  install) install_panel ;;
  upgrade|update) upgrade_panel ;;
  uninstall|remove) uninstall_panel ;;
  *)
    echo "用法: $0 install|upgrade|uninstall"
    exit 1
    ;;
esac
