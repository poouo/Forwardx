#!/bin/bash
set -euo pipefail

ACTION="${1:-install}"
APP_DIR="${FORWARDX_PANEL_DIR:-/opt/forwardx-panel}"
SERVICE_NAME="${FORWARDX_SERVICE_NAME:-forwardx-panel}"
PORT="${PORT:-3000}"
REPO_SLUG="${FORWARDX_GITHUB_REPO:-poouo/Forwardx}"
PANEL_BUNDLE_PREFIX="${FORWARDX_PANEL_BUNDLE_PREFIX:-forwardx-panel-v}"
PNPM_VERSION="${FORWARDX_PNPM_VERSION:-10.28.1}"
ASSETS_PENDING_EXIT_CODE=12

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

normalize_version() {
  local raw="${1:-}"
  raw="${raw#v}"
  printf "%s\n" "$raw"
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
    echo "[INFO] Non-interactive environment, use default web port: $PORT"
    return
  fi

  while true; do
    printf "Enter web listen port [default %s]: " "$default_port" > /dev/tty
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
    echo "[ERROR] Port must be a number in 1-65535, please retry." > /dev/tty
  done
}

json_escape() {
  printf "%s" "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

read_secret() {
  local prompt="$1"
  local value=""
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf "%s" "$prompt" > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true
    IFS= read -r value < /dev/tty || value=""
    stty echo < /dev/tty 2>/dev/null || true
    printf "\n" > /dev/tty
  fi
  printf "%s" "$value"
}

read_database_port() {
  local prompt="$1"
  local default_port="$2"
  local value=""
  while true; do
    printf "%s [%s]: " "$prompt" "$default_port" > /dev/tty
    IFS= read -r value < /dev/tty || value=""
    value="${value//[[:space:]]/}"
    [ -z "$value" ] && value="$default_port"
    if valid_port "$value"; then
      printf "%s" "$value"
      return
    fi
    echo "[ERROR] Port must be a number in 1-65535, please retry." > /dev/tty
  done
}

read_database_config() {
  local config_file="$APP_DIR/data/database.json"
  local choice host port user password database ssl
  if [ "$ACTION" != "install" ] || [ -f "$config_file" ]; then
    return
  fi
  if [ ! -r /dev/tty ] || [ ! -w /dev/tty ]; then
    echo "[INFO] Non-interactive environment, database can be selected on first panel visit."
    return
  fi

  echo "Select database type:" > /dev/tty
  echo "  1) SQLite local database (default)" > /dev/tty
  echo "  2) MySQL external database" > /dev/tty
  echo "  3) PostgreSQL external database" > /dev/tty
  printf "Enter choice [1]: " > /dev/tty
  IFS= read -r choice < /dev/tty || choice=""
  choice="${choice//[[:space:]]/}"
  [ -z "$choice" ] && choice="1"
  if [ "$choice" = "1" ]; then
    mkdir -p "$APP_DIR/data"
    cat > "$config_file" <<EOF
{
  "type": "sqlite",
  "setupPending": true,
  "sqlite": {
    "path": "$(json_escape "$APP_DIR/data/forwardx.db")"
  }
}
EOF
    chmod 600 "$config_file" 2>/dev/null || true
    return
  fi
  if [ "$choice" != "2" ] && [ "$choice" != "3" ]; then
    echo "[INFO] Unknown database choice, database can be selected on first panel visit." > /dev/tty
    return
  fi

  if [ "$choice" = "2" ]; then
    printf "MySQL host [127.0.0.1]: " > /dev/tty
    IFS= read -r host < /dev/tty || host=""
    host="${host:-127.0.0.1}"
    port="$(read_database_port "MySQL port" "3306")"
  else
    printf "PostgreSQL host [127.0.0.1]: " > /dev/tty
    IFS= read -r host < /dev/tty || host=""
    host="${host:-127.0.0.1}"
    port="$(read_database_port "PostgreSQL port" "5432")"
  fi
  printf "Database name [forwardx]: " > /dev/tty
  IFS= read -r database < /dev/tty || database=""
  database="${database:-forwardx}"
  printf "Database user [forwardx]: " > /dev/tty
  IFS= read -r user < /dev/tty || user=""
  user="${user:-forwardx}"
  password="$(read_secret "Database password: ")"
  printf "Enable SSL? [y/N]: " > /dev/tty
  IFS= read -r ssl < /dev/tty || ssl=""
  case "$ssl" in y|Y|yes|YES) ssl="true" ;; *) ssl="false" ;; esac

  mkdir -p "$APP_DIR/data"
  if [ "$choice" = "2" ]; then
    cat > "$config_file" <<EOF
{
  "type": "mysql",
  "setupPending": true,
  "mysql": {
    "host": "$(json_escape "$host")",
    "port": $port,
    "user": "$(json_escape "$user")",
    "password": "$(json_escape "$password")",
    "database": "$(json_escape "$database")",
    "ssl": $ssl
  }
}
EOF
  else
    cat > "$config_file" <<EOF
{
  "type": "postgresql",
  "setupPending": true,
  "postgresql": {
    "host": "$(json_escape "$host")",
    "port": $port,
    "user": "$(json_escape "$user")",
    "password": "$(json_escape "$password")",
    "database": "$(json_escape "$database")",
    "ssl": $ssl
  }
}
EOF
  fi
  chmod 600 "$config_file" 2>/dev/null || true
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
    echo "[ERROR] Please run as root"
    exit 1
  fi
}

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

is_systemd_host() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

write_openrc_service() {
  local node_bin="$1"
  cat > "/etc/init.d/$SERVICE_NAME" <<EOF
#!/sbin/openrc-run
name="$SERVICE_NAME"
description="ForwardX Panel"
command="/bin/sh"
command_args="-lc $(shell_quote "cd $APP_DIR && set -a && . $APP_DIR/.env && set +a && exec $node_bin dist/index.js")"
command_background=true
pidfile="/run/\${RC_SVCNAME}.pid"
output_log="$APP_DIR/data/panel.log"
error_log="$APP_DIR/data/panel.log"
depend() {
  need net
}
EOF
  chmod 755 "/etc/init.d/$SERVICE_NAME"
}

write_sysv_service() {
  local node_bin="$1"
  cat > "/etc/init.d/$SERVICE_NAME" <<EOF
#!/bin/sh
### BEGIN INIT INFO
# Provides:          $SERVICE_NAME
# Required-Start:    \$network
# Required-Stop:     \$network
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: ForwardX Panel
### END INIT INFO
PIDFILE=/run/$SERVICE_NAME.pid
LOGFILE=$APP_DIR/data/panel.log
CMD=$(shell_quote "cd $APP_DIR && set -a && . $APP_DIR/.env && set +a && exec $node_bin dist/index.js")
start() {
  mkdir -p /run "$APP_DIR/data"
  if [ -s "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then return 0; fi
  nohup sh -lc "\$CMD" >> "\$LOGFILE" 2>&1 &
  echo \$! > "\$PIDFILE"
}
stop() {
  if [ -s "\$PIDFILE" ]; then kill "\$(cat "\$PIDFILE")" 2>/dev/null || true; rm -f "\$PIDFILE"; fi
}
case "\$1" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) [ -s "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null ;;
  *) echo "Usage: \$0 {start|stop|restart|status}"; exit 1 ;;
esac
EOF
  chmod 755 "/etc/init.d/$SERVICE_NAME"
}

write_service() {
  local node_bin
  node_bin="$(command -v node)"
  mkdir -p "$APP_DIR/data"
  if is_systemd_host; then
    cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=ForwardX Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$node_bin dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
  elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
    write_openrc_service "$node_bin"
    rc-update add "$SERVICE_NAME" default >/dev/null 2>&1 || true
  elif [ -d /etc/init.d ]; then
    write_sysv_service "$node_bin"
    command -v update-rc.d >/dev/null 2>&1 && update-rc.d "$SERVICE_NAME" defaults >/dev/null 2>&1 || true
    command -v chkconfig >/dev/null 2>&1 && chkconfig "$SERVICE_NAME" on >/dev/null 2>&1 || true
  else
    echo "[ERROR] Unsupported init system, please install systemd/OpenRC/SysV init support"
    exit 1
  fi
}

restart_service() {
  if is_systemd_host; then
    systemctl restart "$SERVICE_NAME"
  elif command -v rc-service >/dev/null 2>&1; then
    rc-service "$SERVICE_NAME" restart
  elif [ -x "/etc/init.d/$SERVICE_NAME" ]; then
    "/etc/init.d/$SERVICE_NAME" restart
  else
    echo "[ERROR] Service manager not found for $SERVICE_NAME"
    exit 1
  fi
}

remove_service() {
  if is_systemd_host; then
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload 2>/dev/null || true
  fi
  if command -v rc-service >/dev/null 2>&1; then
    rc-service "$SERVICE_NAME" stop 2>/dev/null || true
  fi
  if command -v rc-update >/dev/null 2>&1; then
    rc-update del "$SERVICE_NAME" default 2>/dev/null || true
  fi
  if [ -x "/etc/init.d/$SERVICE_NAME" ]; then
    "/etc/init.d/$SERVICE_NAME" stop 2>/dev/null || true
  fi
  command -v update-rc.d >/dev/null 2>&1 && update-rc.d -f "$SERVICE_NAME" remove >/dev/null 2>&1 || true
  command -v chkconfig >/dev/null 2>&1 && chkconfig "$SERVICE_NAME" off >/dev/null 2>&1 || true
  rm -f "/etc/init.d/$SERVICE_NAME"
}

confirm_yes() {
  local prompt="$1"
  local answer=""

  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf "%s" "$prompt" > /dev/tty
    IFS= read -r answer < /dev/tty || answer=""
  else
    echo "[INFO] Non-interactive environment, defaulting to N: $prompt"
  fi

  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

latest_release_version() {
  local api_url="${FORWARDX_GITHUB_API_URL:-https://api.github.com/repos/${REPO_SLUG}/releases/latest}"
  local tag=""
  tag="$(curl -fsSL --retry 3 --connect-timeout 10 "$api_url" \
    | sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/p' \
    | head -1 || true)"

  if [ -z "$tag" ]; then
    echo "[ERROR] Failed to resolve latest release version from GitHub API: $api_url"
    return 1
  fi
  printf "%s\n" "$tag"
}

resolve_release_version() {
  local requested="${FORWARDX_TARGET_VERSION:-}"
  local normalized=""

  if [ -n "$requested" ]; then
    normalized="$(normalize_version "$requested")"
  else
    normalized="$(latest_release_version)"
  fi

  if [[ ! "$normalized" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[ERROR] Invalid release version: ${normalized:-<empty>}"
    return 1
  fi
  printf "%s\n" "$normalized"
}

panel_bundle_url() {
  local version="$1"
  local filename="${PANEL_BUNDLE_PREFIX}${version}.tar.gz"
  printf "https://github.com/%s/releases/download/v%s/%s\n" "$REPO_SLUG" "$version" "$filename"
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "0"
    return
  fi
  node -p "Number(process.versions.node.split('.')[0] || 0)" 2>/dev/null || echo "0"
}

ensure_node_runtime() {
  local major="0"
  major="$(node_major_version)"
  if [ "$major" -ge 22 ]; then
    return
  fi

  echo "[INFO] Installing Node.js 22+ ..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y -q nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    yum install -y -q nodejs
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n install nodejs22 npm22 || zypper -n install nodejs npm
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm nodejs npm
  else
    echo "[ERROR] Unsupported package manager, please install Node.js 22+ manually"
    exit 1
  fi

  major="$(node_major_version)"
  if [ "$major" -lt 22 ]; then
    echo "[ERROR] Node.js 22+ is required, current major version is $major"
    exit 1
  fi
}

install_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates tar xz-utils openssl >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl ca-certificates tar xz openssl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl ca-certificates tar xz openssl
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n install curl ca-certificates tar xz openssl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates tar xz openssl
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm curl ca-certificates tar xz openssl
  fi

  ensure_node_runtime

  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1 || npm install -g "pnpm@${PNPM_VERSION}"
  else
    npm install -g "pnpm@${PNPM_VERSION}"
  fi
}

download_panel_bundle() {
  local version="$1"
  local tmp_dir url archive http_code
  tmp_dir="$(mktemp -d)"
  archive="$tmp_dir/panel.tar.gz"
  url="$(panel_bundle_url "$version")"

  echo "[INFO] Downloading panel bundle: $url"
  http_code="$(curl -fL --retry 3 --connect-timeout 10 --write-out "%{http_code}" --output "$archive" "$url" 2>/dev/null || true)"
  if [ "$http_code" = "404" ]; then
    rm -rf "$tmp_dir"
    echo "[INFO] Panel bundle for v$version is not available yet."
    echo "[INFO] GitHub Actions may still be building or uploading release assets. Please retry later."
    exit "$ASSETS_PENDING_EXIT_CODE"
  fi
  if [ "$http_code" != "200" ]; then
    rm -rf "$tmp_dir"
    echo "[ERROR] Failed to download panel bundle from GitHub release (HTTP ${http_code:-unknown})"
    exit 1
  fi

  mkdir -p "$APP_DIR"
  rm -rf "$APP_DIR/dist" "$APP_DIR/client" "$APP_DIR/drizzle" "$APP_DIR/scripts"
  rm -f "$APP_DIR/package.json" "$APP_DIR/pnpm-lock.yaml" "$APP_DIR/pnpm-workspace.yaml"

  if ! tar -xzf "$archive" -C "$APP_DIR"; then
    rm -rf "$tmp_dir"
    echo "[ERROR] Failed to extract panel bundle"
    exit 1
  fi
  rm -rf "$tmp_dir"
}

install_runtime_dependencies() {
  cd "$APP_DIR"
  rm -rf node_modules
  if [ -f pnpm-lock.yaml ]; then
    pnpm install --prod --frozen-lockfile
  else
    npm install --omit=dev
  fi
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

install_panel() {
  local release_version
  require_root
  resolve_runtime_env
  read_install_port
  install_deps
  release_version="$(resolve_release_version)"
  download_panel_bundle "$release_version"
  install_runtime_dependencies
  write_env
  read_database_config
  write_service
  restart_service
  echo "[DONE] ForwardX panel started (release v$release_version): http://SERVER_IP:$PORT"
}

upgrade_panel() {
  local release_version
  require_root
  resolve_runtime_env
  install_deps
  release_version="$(resolve_release_version)"
  download_panel_bundle "$release_version"
  install_runtime_dependencies
  write_env
  write_service
  restart_service
  echo "[DONE] ForwardX panel upgraded to release v$release_version and restarted"
}

uninstall_panel() {
  require_root
  if ! confirm_yes "Confirm uninstall ForwardX local panel and remove service files? [y/N] "; then
    echo "[INFO] Uninstall cancelled"
    return
  fi
  remove_service

  if confirm_yes "Remove panel directory $APP_DIR ? [y/N] "; then
    rm -rf "$APP_DIR"
    echo "[DONE] Removed $APP_DIR"
  else
    echo "[DONE] Service uninstalled, kept $APP_DIR"
  fi
}

case "$ACTION" in
  install) install_panel ;;
  upgrade|update) upgrade_panel ;;
  uninstall|remove) uninstall_panel ;;
  *)
    echo "Usage: $0 install|upgrade|uninstall"
    exit 1
    ;;
esac
