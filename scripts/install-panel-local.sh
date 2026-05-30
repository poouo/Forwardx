#!/bin/bash
set -euo pipefail

ACTION="${1:-install}"
APP_DIR="${FORWARDX_PANEL_DIR:-/opt/forwardx-panel}"
SERVICE_NAME="${FORWARDX_SERVICE_NAME:-forwardx-panel}"
REPO_URL="${FORWARDX_REPO_URL:-https://github.com/poouo/Forwardx.git}"
PORT="${PORT:-3000}"

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

install_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl git ca-certificates build-essential python3 openssl >/dev/null
    if ! command -v node >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y -qq nodejs >/dev/null
    fi
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl git ca-certificates gcc gcc-c++ make python3 openssl nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl git ca-certificates gcc gcc-c++ make python3 openssl nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl git ca-certificates build-base python3 openssl nodejs npm
  fi

  command -v node >/dev/null 2>&1 || { echo "[错误] Node.js 安装失败，请先安装 Node.js 22+"; exit 1; }
  corepack enable >/dev/null 2>&1 || npm install -g pnpm@10
  corepack prepare pnpm@10 --activate >/dev/null 2>&1 || npm install -g pnpm@10
}

sync_source() {
  local target="${FORWARDX_TARGET_VERSION:-}"
  local resolved_target=""
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" remote set-url origin "$REPO_URL" || true
    fetch_source_refs
  else
    rm -rf "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
    fetch_source_refs
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
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload

  if confirm_yes "是否删除面板程序目录 $APP_DIR ? [y/N] "; then
    rm -rf "$APP_DIR"
    echo "[完成] 已删除 $APP_DIR"
  else
    echo "[完成] 已卸载服务，保留 $APP_DIR"
  fi
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
