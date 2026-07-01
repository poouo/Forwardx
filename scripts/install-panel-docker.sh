#!/bin/bash
set -euo pipefail

ACTION="${1:-install}"
APP_DIR="${FORWARDX_DOCKER_DIR:-/opt/forwardx-docker}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-forwardx}"
CONTAINER_NAME="${FORWARDX_CONTAINER_NAME:-forwardx-panel}"
PORT="${PORT:-9810}"
REPO_SLUG="${FORWARDX_GITHUB_REPO:-poouo/Forwardx}"
IMAGE_REPO="${FORWARDX_IMAGE_REPO:-ghcr.io/poouo/forwardx}"
ASSETS_PENDING_EXIT_CODE=12
EXPLICIT_FORWARDX_IMAGE="${FORWARDX_IMAGE:-}"

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[ERROR] Please run as root"
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
    echo "[INFO] Non-interactive environment, defaulting to N: $prompt"
  fi

  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

valid_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]
}

start_docker_service() {
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    systemctl enable --now docker 2>/dev/null || systemctl restart docker 2>/dev/null || true
  elif command -v rc-service >/dev/null 2>&1; then
    rc-update add docker default 2>/dev/null || true
    rc-service docker restart 2>/dev/null || rc-service docker start 2>/dev/null || true
  elif command -v service >/dev/null 2>&1; then
    service docker restart 2>/dev/null || service docker start 2>/dev/null || true
  elif [ -x /etc/init.d/docker ]; then
    /etc/init.d/docker restart 2>/dev/null || /etc/init.d/docker start 2>/dev/null || true
  fi
}

normalize_version() {
  local raw="${1:-}"
  raw="${raw#v}"
  printf "%s\n" "$raw"
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[ERROR] Docker Compose not found, please install Docker Compose plugin first"
    exit 1
  fi
}

get_env_value() {
  local key="$1"
  local file="$APP_DIR/.env"
  if [ ! -f "$file" ]; then
    return 0
  fi
  grep -E "^${key}=" "$file" | tail -1 | sed -E "s/^${key}=//; s/^\"//; s/\"$//"
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

read_database_config_json() {
  local choice host port user password database ssl
  DATABASE_CONFIG_JSON=""
  if [ "$ACTION" != "install" ]; then
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
    DATABASE_CONFIG_JSON="$(cat <<EOF
{
  "type": "sqlite",
  "setupPending": true,
  "sqlite": {
    "path": "/data/forwardx.db"
  }
}
EOF
)"
    return
  fi
  if [ "$choice" != "2" ] && [ "$choice" != "3" ]; then
    echo "[INFO] Unknown database choice, database can be selected on first panel visit." > /dev/tty
    return
  fi

  echo "[INFO] Database host must be reachable from inside the ForwardX panel container." > /dev/tty
  echo "[INFO] If the database runs on the host, try host.docker.internal or the host LAN IP instead of 127.0.0.1." > /dev/tty
  echo "[INFO] If the database runs in another container, make sure both containers share a Docker network and use the database service/container name." > /dev/tty

  if [ "$choice" = "2" ]; then
    printf "MySQL host [host.docker.internal]: " > /dev/tty
    IFS= read -r host < /dev/tty || host=""
    host="${host:-host.docker.internal}"
    port="$(read_database_port "MySQL port" "3306")"
  else
    printf "PostgreSQL host [host.docker.internal]: " > /dev/tty
    IFS= read -r host < /dev/tty || host=""
    host="${host:-host.docker.internal}"
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

  if [ "$choice" = "2" ]; then
    DATABASE_CONFIG_JSON="$(cat <<EOF
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
)"
  else
    DATABASE_CONFIG_JSON="$(cat <<EOF
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
)"
  fi
}

write_database_config_to_volume() {
  if [ -z "${DATABASE_CONFIG_JSON:-}" ]; then
    return
  fi
  printf "%s\n" "$DATABASE_CONFIG_JSON" | docker run --rm -i -v "${PROJECT_NAME}_forwardx-data:/data" busybox sh -c 'umask 077; cat > /data/database.json'
}

load_existing_env() {
  local value
  value="$(get_env_value PORT || true)"
  if [ -n "$value" ] && valid_port "$value"; then PORT="$value"; fi
  value="$(get_env_value COMPOSE_PROJECT_NAME || true)"
  if [ -n "$value" ]; then PROJECT_NAME="$value"; fi
  value="$(get_env_value FORWARDX_CONTAINER_NAME || true)"
  if [ -n "$value" ]; then CONTAINER_NAME="$value"; fi
  value="$(get_env_value FORWARDX_IMAGE || true)"
  if [ -n "$value" ] && [ -z "${FORWARDX_IMAGE:-}" ] && [ "$ACTION" = "install" ]; then FORWARDX_IMAGE="$value"; fi
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

resolve_image_ref() {
  local version=""
  if [ -n "$EXPLICIT_FORWARDX_IMAGE" ]; then
    printf "%s\n" "$EXPLICIT_FORWARDX_IMAGE"
    return
  fi
  version="$(resolve_release_version)"
  printf "%s:v%s\n" "$IMAGE_REPO" "$version"
}

install_base_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl openssl >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q curl ca-certificates openssl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q curl ca-certificates openssl
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n install curl ca-certificates openssl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates openssl
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm curl ca-certificates openssl
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "[INFO] Docker is already installed, skip package manager update."
    start_docker_service
    return
  fi
  install_base_deps
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
    start_docker_service
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q docker
    start_docker_service
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q docker
    start_docker_service
  elif command -v zypper >/dev/null 2>&1; then
    zypper -n install docker docker-compose-plugin || zypper -n install docker docker-compose
    start_docker_service
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache docker docker-cli-compose
    start_docker_service
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm docker docker-compose
    start_docker_service
  fi
}

write_compose_file() {
  mkdir -p "$APP_DIR"
  cat > "$APP_DIR/docker-compose.yml" <<'EOF'
name: ${COMPOSE_PROJECT_NAME:-forwardx}

services:
  forwardx:
    image: ${FORWARDX_IMAGE}
    container_name: ${FORWARDX_CONTAINER_NAME:-forwardx-panel}
    restart: unless-stopped
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "${PORT:-9810}:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      FORWARDX_PUBLIC_PORT: ${PORT:-9810}
      FORWARDX_PORT_MANAGEMENT: docker
      DATABASE_CONFIG_PATH: /data/database.json
      SQLITE_PATH: /data/forwardx.db
      MYSQL_CONFIG_PATH: /data/mysql.json
      POSTGRES_URL: ${POSTGRES_URL:-}
      POSTGRES_HOST: ${POSTGRES_HOST:-}
      POSTGRES_PORT: ${POSTGRES_PORT:-5432}
      POSTGRES_USER: ${POSTGRES_USER:-}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-}
      POSTGRES_DATABASE: ${POSTGRES_DATABASE:-}
      POSTGRES_SSL: ${POSTGRES_SSL:-false}
      JWT_SECRET: ${JWT_SECRET:-change-me-to-a-random-string}
    volumes:
      - forwardx-data:/data

volumes:
  forwardx-data:
    driver: local
EOF
}

write_env() {
  local image="$1"
  local existing_jwt jwt_secret
  if ! valid_port "$PORT"; then
    PORT="9810"
  fi

  existing_jwt="$(get_env_value JWT_SECRET || true)"
  jwt_secret="${JWT_SECRET:-$existing_jwt}"
  if [ -z "$jwt_secret" ]; then
    jwt_secret="$(openssl rand -hex 32 2>/dev/null || date +%s%N | sha256sum | awk '{print $1}')"
  fi

  cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
FORWARDX_PUBLIC_PORT=$PORT
JWT_SECRET=$jwt_secret
COMPOSE_PROJECT_NAME=$PROJECT_NAME
FORWARDX_CONTAINER_NAME=$CONTAINER_NAME
FORWARDX_IMAGE=$image
EOF
}

remove_existing_panel_containers() {
  local ids_by_name=""
  local ids_by_compose=""
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  ids_by_name="$(docker ps -aq --filter "name=^/${CONTAINER_NAME}$" 2>/dev/null || true)"
  ids_by_compose="$(docker ps -aq \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=forwardx" 2>/dev/null || true)"
  if [ -n "$ids_by_name" ] || [ -n "$ids_by_compose" ]; then
    printf "%s\n%s\n" "$ids_by_name" "$ids_by_compose" | awk 'NF && !seen[$0]++' | while IFS= read -r id; do
      docker rm -f "$id" 2>/dev/null || true
    done
  fi
}

image_panel_version() {
  local image="$1"
  docker run --rm --entrypoint node "$image" -p "require('./package.json').version"
}

assert_target_image_ready() {
  local image="$1"
  local target="${FORWARDX_TARGET_VERSION:-}"
  local expected=""
  local actual=""
  if [ -z "$target" ]; then
    return
  fi
  expected="$(normalize_version "$target")"
  actual="$(image_panel_version "$image" 2>/dev/null || true)"
  actual="$(normalize_version "$actual")"
  if [ -z "$actual" ]; then
    echo "[INFO] Unable to read panel version from image $image"
    echo "[INFO] GitHub Actions may still be building or uploading release assets. Please retry later."
    exit "$ASSETS_PENDING_EXIT_CODE"
  fi
  if [ "$actual" != "$expected" ]; then
    echo "[INFO] Image version mismatch: expected v$expected, got v$actual"
    echo "[INFO] Release image may still be building/pushing. Please retry later."
    exit "$ASSETS_PENDING_EXIT_CODE"
  fi
}

start_panel() {
  local image="$1"
  cd "$APP_DIR"
  echo "[INFO] Pulling image: $image"
  if ! docker pull "$image"; then
    echo "[INFO] Docker image $image is not available yet."
    echo "[INFO] GitHub Actions may still be building or uploading release assets. Please retry later."
    exit "$ASSETS_PENDING_EXIT_CODE"
  fi
  assert_target_image_ready "$image"
  remove_existing_panel_containers
  compose_cmd --env-file "$APP_DIR/.env" -p "$PROJECT_NAME" up -d --remove-orphans forwardx
}

install_panel() {
  local image
  require_root
  install_docker
  load_existing_env
  read_database_config_json
  image="$(resolve_image_ref)"
  write_compose_file
  write_env "$image"
  write_database_config_to_volume
  start_panel "$image"
  echo "[DONE] ForwardX Docker panel started: http://SERVER_IP:$PORT"
  echo "[INFO] Image: $image"
}

upgrade_panel() {
  local image
  require_root
  load_existing_env
  install_docker
  image="$(resolve_image_ref)"
  write_compose_file
  write_env "$image"
  start_panel "$image"
  echo "[DONE] ForwardX Docker panel upgraded and restarted"
  echo "[INFO] Image: $image"
}

uninstall_panel() {
  require_root
  load_existing_env
  if ! confirm_yes "Confirm uninstall ForwardX Docker panel and delete deployment dir + Docker volume? [y/N] "; then
    echo "[INFO] Uninstall cancelled"
    return
  fi
  cd "$APP_DIR" 2>/dev/null || true
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    compose_cmd --env-file "$APP_DIR/.env" -p "$PROJECT_NAME" down --remove-orphans || true
  fi
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

  rm -rf "$APP_DIR"
  docker volume rm "${PROJECT_NAME}_forwardx-data" 2>/dev/null || true
  echo "[DONE] ForwardX Docker panel uninstalled"
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
