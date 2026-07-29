#!/bin/bash
set -euo pipefail

ACTION="${1:-install}"
APP_DIR="${FORWARDX_DOCKER_DIR:-/opt/forwardx-docker}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-forwardx}"
CONTAINER_NAME="${FORWARDX_CONTAINER_NAME:-forwardx-panel}"
EXPLICIT_PORT="${PORT:-}"
PORT="${EXPLICIT_PORT:-9810}"
REPO_SLUG="${FORWARDX_GITHUB_REPO:-poouo/Forwardx}"
IMAGE_REPO="${FORWARDX_IMAGE_REPO:-ghcr.io/poouo/forwardx}"
ASSETS_PENDING_EXIT_CODE=12
EXPLICIT_FORWARDX_IMAGE="${FORWARDX_IMAGE:-}"
DATA_VOLUME_REUSE_NOTIFIED="false"
RESOLVED_IMAGE=""
EXPECTED_PANEL_VERSION=""

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

get_compose_host_port() {
  local file="$APP_DIR/docker-compose.yml"
  local port=""
  if [ ! -f "$file" ]; then
    return 0
  fi

  port="$(sed -nE 's/^[[:space:]]*-[[:space:]]*"?([0-9]{1,5}):3000(\/[a-zA-Z]+)?"?[[:space:]]*$/\1/p' "$file" | head -1 || true)"
  if valid_port "$port"; then
    printf "%s" "$port"
    return
  fi

  port="$(sed -nE 's/^[[:space:]]*-[[:space:]]*"?[^"]+:([0-9]{1,5}):3000(\/[a-zA-Z]+)?"?[[:space:]]*$/\1/p' "$file" | head -1 || true)"
  if valid_port "$port"; then
    printf "%s" "$port"
    return
  fi
}

get_container_host_port() {
  local id=""
  local output=""
  local port=""
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi

  output="$(docker port "$CONTAINER_NAME" 3000/tcp 2>/dev/null || true)"
  port="$(printf "%s\n" "$output" | sed -nE 's/.*:([0-9]{1,5})$/\1/p' | head -1 || true)"
  if valid_port "$port"; then
    printf "%s" "$port"
    return
  fi

  id="$(docker ps -aq \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=forwardx" 2>/dev/null | head -1 || true)"
  if [ -z "$id" ]; then
    return 0
  fi
  output="$(docker port "$id" 3000/tcp 2>/dev/null || true)"
  port="$(printf "%s\n" "$output" | sed -nE 's/.*:([0-9]{1,5})$/\1/p' | head -1 || true)"
  if valid_port "$port"; then
    printf "%s" "$port"
  fi
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
  if docker volume inspect "$(data_volume_name)" >/dev/null 2>&1; then
    echo "[WARN] Existing Docker data volume detected; preserving its database configuration and administrator data."
    echo "[INFO] Database selection is skipped on reinstall. Use the existing administrator account, or fully uninstall and confirm volume deletion before a clean install."
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
  ensure_data_volume
  printf "%s\n" "$DATABASE_CONFIG_JSON" | docker run --rm -i -v "$(data_volume_name):/data" busybox sh -c 'umask 077; cat > /data/database.json'
}

data_volume_name() {
  printf "%s_forwardx-data" "$PROJECT_NAME"
}

panel_container_ids() {
  {
    docker inspect --format '{{.Id}}' "$CONTAINER_NAME" 2>/dev/null || true
    docker ps -aq --filter "name=^/${CONTAINER_NAME}$" 2>/dev/null || true
    docker ps -aq \
      --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
      --filter "label=com.docker.compose.service=forwardx" 2>/dev/null || true
  } | awk 'NF && !seen[$0]++'
}

panel_data_volume_names() {
  local ids=""
  local id=""
  ids="$(panel_container_ids)"
  if [ -z "$ids" ]; then
    return
  fi
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}{{end}}' "$id" 2>/dev/null || true
  done <<< "$ids" | awk 'NF && !seen[$0]++'
}

uninstall_volume_state_file() {
  printf "%s/.forwardx-uninstall-volumes" "$APP_DIR"
}

uninstall_data_volume_names() {
  local state_file=""
  state_file="$(uninstall_volume_state_file)"
  {
    printf "%s\n" "$(data_volume_name)"
    if [ -f "$state_file" ]; then
      awk 'NF' "$state_file"
    fi
    panel_data_volume_names
  } | awk 'NF && !seen[$0]++'
}

persist_uninstall_data_volume_names() {
  local volume_names="$1"
  local state_file=""
  state_file="$(uninstall_volume_state_file)"
  mkdir -p "$APP_DIR"
  (umask 077; printf "%s\n" "$volume_names" > "$state_file")
}

ensure_data_volume() {
  local volume_name
  volume_name="$(data_volume_name)"
  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    if [ "$ACTION" = "install" ] && [ "$DATA_VOLUME_REUSE_NOTIFIED" != "true" ]; then
      echo "[WARN] Existing Docker data volume will be reused: $volume_name"
      echo "[WARN] Existing SQLite data and administrator credentials are retained. Run the uninstall action and confirm volume deletion before a clean reinstall."
      DATA_VOLUME_REUSE_NOTIFIED="true"
    fi
    return
  fi
  docker volume create \
    --label "com.docker.compose.project=${PROJECT_NAME}" \
    --label "com.docker.compose.volume=forwardx-data" \
    "$volume_name" >/dev/null
}

load_existing_env() {
  local value public_value compose_port container_port port_source
  value="$(get_env_value COMPOSE_PROJECT_NAME || true)"
  if [ -n "$value" ]; then PROJECT_NAME="$value"; fi
  value="$(get_env_value FORWARDX_CONTAINER_NAME || true)"
  if [ -n "$value" ]; then CONTAINER_NAME="$value"; fi

  if [ -n "$EXPLICIT_PORT" ] && valid_port "$EXPLICIT_PORT"; then
    PORT="$EXPLICIT_PORT"
    port_source="environment"
  else
    container_port="$(get_container_host_port || true)"
    compose_port="$(get_compose_host_port || true)"
    value="$(get_env_value PORT || true)"
    public_value="$(get_env_value FORWARDX_PUBLIC_PORT || true)"
    if [ -n "$container_port" ] && valid_port "$container_port"; then
      PORT="$container_port"
      port_source="running container"
    elif [ -n "$compose_port" ] && valid_port "$compose_port"; then
      PORT="$compose_port"
      port_source="docker-compose.yml"
    elif [ -n "$value" ] && valid_port "$value"; then
      PORT="$value"
      port_source=".env PORT"
    elif [ -n "$public_value" ] && valid_port "$public_value"; then
      PORT="$public_value"
      port_source=".env FORWARDX_PUBLIC_PORT"
    fi
  fi
  if [ -n "${port_source:-}" ]; then
    echo "[INFO] Reusing Docker public port from ${port_source}: ${PORT}"
  fi

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
    echo "[ERROR] Failed to resolve latest release version from GitHub API: $api_url" >&2
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
    echo "[ERROR] Invalid release version: ${normalized:-<empty>}" >&2
    return 1
  fi
  printf "%s\n" "$normalized"
}

resolve_image_selection() {
  local version=""
  RESOLVED_IMAGE=""
  EXPECTED_PANEL_VERSION=""

  if [ -n "$EXPLICIT_FORWARDX_IMAGE" ]; then
    RESOLVED_IMAGE="$EXPLICIT_FORWARDX_IMAGE"
    if [ -n "${FORWARDX_TARGET_VERSION:-}" ]; then
      if ! EXPECTED_PANEL_VERSION="$(resolve_release_version)"; then
        return 1
      fi
    fi
    return
  fi

  if ! version="$(resolve_release_version)"; then
    return 1
  fi
  EXPECTED_PANEL_VERSION="$version"
  RESOLVED_IMAGE="${IMAGE_REPO}:v${version}"
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
    logging:
      driver: local
      options:
        max-size: "${FORWARDX_LOG_MAX_SIZE:-20m}"
        max-file: "${FORWARDX_LOG_MAX_FILES:-3}"

volumes:
  forwardx-data:
    name: ${COMPOSE_PROJECT_NAME:-forwardx}_forwardx-data
    external: true
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
  local ids=""
  local id=""
  ids="$(panel_container_ids)"
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    if docker rm -f "$id" >/dev/null 2>&1; then
      echo "[INFO] Removed previous ForwardX container: $id"
    fi
  done <<< "$ids"
}

image_panel_version() {
  local image="$1"
  docker run --rm --entrypoint node "$image" -p "require('./package.json').version"
}

image_label_version() {
  local image="$1"
  docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image"
}

image_id() {
  local image="$1"
  docker image inspect --format '{{.Id}}' "$image"
}

assert_target_image_ready() {
  local image="$1"
  local expected="${2:-}"
  local package_version=""
  local label_version=""
  local normalized_label=""
  if [ -z "$expected" ]; then
    return
  fi
  expected="$(normalize_version "$expected")"
  package_version="$(image_panel_version "$image" 2>/dev/null || true)"
  package_version="$(normalize_version "$package_version")"
  label_version="$(image_label_version "$image" 2>/dev/null || true)"
  label_version="$(normalize_version "$label_version")"
  normalized_label="$(printf "%s" "$label_version" | tr '[:upper:]' '[:lower:]')"

  if [ "$package_version" != "$expected" ]; then
    echo "[ERROR] Pulled ForwardX image failed version verification: $image"
    echo "[ERROR] Expected v$expected; package=${package_version:-unreadable}; label=${label_version:-unreadable}"
    echo "[INFO] The release image may still be publishing, or a Docker registry mirror/proxy may be serving stale content."
    echo "[INFO] Check 'docker info' for Registry Mirrors, bypass or purge the stale mirror cache, then retry the upgrade."
    exit "$ASSETS_PENDING_EXIT_CODE"
  fi

  case "$normalized_label" in
    ""|unknown|"<no value>"|null)
      echo "[WARN] Image OCI version label is unavailable; verified the embedded package version instead."
      ;;
    "$expected")
      ;;
    *)
      echo "[ERROR] Pulled ForwardX image label conflicts with its expected version: $image"
      echo "[ERROR] Expected v$expected; package=v$package_version; label=v$label_version"
      echo "[INFO] A Docker registry mirror/proxy may be serving stale or inconsistent image metadata."
      echo "[INFO] Check 'docker info' for Registry Mirrors, bypass or purge the stale mirror cache, then retry the upgrade."
      exit "$ASSETS_PENDING_EXIT_CODE"
      ;;
  esac

  echo "[INFO] Verified pulled image version: v$expected"
}

running_panel_version() {
  docker exec "$CONTAINER_NAME" node -p "require('/app/package.json').version"
}

assert_running_panel_ready() {
  local expected_image_id="$1"
  local expected_version="${2:-}"
  local running=""
  local active_image_id=""
  local running_version=""
  local attempt=0

  while [ "$attempt" -lt 15 ]; do
    running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
    active_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
    if [ "$running" = "true" ]; then
      running_version="$(running_panel_version 2>/dev/null || true)"
      if [ -n "$running_version" ]; then
        break
      fi
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  if [ "$running" != "true" ]; then
    echo "[ERROR] ForwardX container did not remain running after recreation: $CONTAINER_NAME"
    echo "[INFO] Inspect it with: docker logs --tail 100 $CONTAINER_NAME"
    return 1
  fi
  if [ -z "$running_version" ]; then
    echo "[ERROR] Unable to read the ForwardX version from the running container: $CONTAINER_NAME"
    echo "[INFO] Inspect it with: docker logs --tail 100 $CONTAINER_NAME"
    return 1
  fi
  if [ -z "$expected_image_id" ] || [ "$active_image_id" != "$expected_image_id" ]; then
    echo "[ERROR] Recreated container is not using the image that was just pulled."
    echo "[ERROR] Pulled image ID: ${expected_image_id:-unreadable}"
    echo "[ERROR] Running image ID: ${active_image_id:-unreadable}"
    echo "[INFO] Check for duplicate Compose projects/containers and retry the upgrade."
    return 1
  fi

  running_version="$(normalize_version "$running_version")"
  expected_version="$(normalize_version "$expected_version")"
  if [ -n "$expected_version" ] && [ "$running_version" != "$expected_version" ]; then
    echo "[ERROR] Running ForwardX version mismatch: expected v$expected_version, got ${running_version:+v}${running_version:-unreadable}"
    echo "[INFO] The container image ID is correct, but its runtime package is inconsistent. Check Docker storage and registry mirror integrity."
    return 1
  fi

  echo "[INFO] Verified running ForwardX container: image=$active_image_id version=${running_version:+v}$running_version"
}

image_repository_from_ref() {
  local image_ref="${1%%@*}"
  local last_component="${image_ref##*/}"
  if [[ "$last_component" == *:* ]]; then
    printf "%s\n" "${image_ref%:*}"
  else
    printf "%s\n" "$image_ref"
  fi
}

cleanup_old_panel_images() {
  local image="$1"
  local repository=""
  local current_image_id=""
  local running=""
  local rows=""
  local listed_repository=""
  local tag=""
  local image_id=""
  local image_ref=""

  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [ "$running" != "true" ]; then
    echo "[WARN] ForwardX container is not running; old image cleanup skipped."
    return
  fi

  current_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  repository="$(image_repository_from_ref "$image")"
  if [ -z "$current_image_id" ] || [ -z "$repository" ]; then
    echo "[WARN] Unable to identify the active ForwardX image; old image cleanup skipped."
    return
  fi

  rows="$(docker image ls --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}' "$repository" 2>/dev/null || true)"
  while IFS='|' read -r listed_repository tag image_id; do
    if [ "$listed_repository" != "$repository" ] || [ -z "$tag" ] || [ "$tag" = "<none>" ]; then
      continue
    fi
    if [ "$image_id" = "$current_image_id" ]; then
      continue
    fi

    image_ref="${listed_repository}:${tag}"
    if docker image rm "$image_ref" >/dev/null 2>&1; then
      echo "[INFO] Removed old ForwardX image: $image_ref"
    else
      echo "[WARN] Could not remove old ForwardX image (it may still be in use): $image_ref"
    fi
  done <<< "$rows"
}

start_panel() {
  local image="$1"
  local expected_version="${2:-}"
  local pulled_image_id=""
  cd "$APP_DIR"
  echo "[INFO] Pulling image: $image"
  if ! docker pull "$image"; then
    echo "[INFO] Docker image $image is not available yet."
    echo "[INFO] GitHub Actions may still be building or uploading release assets. Please retry later."
    exit "$ASSETS_PENDING_EXIT_CODE"
  fi
  assert_target_image_ready "$image" "$expected_version"
  pulled_image_id="$(image_id "$image" 2>/dev/null || true)"
  if [ -z "$pulled_image_id" ]; then
    echo "[ERROR] Unable to resolve the pulled image ID: $image"
    echo "[INFO] Check Docker daemon storage and retry the upgrade."
    return 1
  fi
  remove_existing_panel_containers
  ensure_data_volume
  compose_cmd --env-file "$APP_DIR/.env" -p "$PROJECT_NAME" up -d --remove-orphans forwardx
  assert_running_panel_ready "$pulled_image_id" "$expected_version"
  cleanup_old_panel_images "$image"
}

install_panel() {
  local image
  require_root
  install_docker
  load_existing_env
  read_database_config_json
  resolve_image_selection
  image="$RESOLVED_IMAGE"
  write_compose_file
  write_env "$image"
  write_database_config_to_volume
  start_panel "$image" "$EXPECTED_PANEL_VERSION"
  echo "[DONE] ForwardX Docker panel started: http://SERVER_IP:$PORT"
  echo "[INFO] Image: $image"
}

upgrade_panel() {
  local image
  require_root
  load_existing_env
  install_docker
  resolve_image_selection
  image="$RESOLVED_IMAGE"
  write_compose_file
  write_env "$image"
  start_panel "$image" "$EXPECTED_PANEL_VERSION"
  echo "[DONE] ForwardX Docker panel upgraded and restarted"
  echo "[INFO] Image: $image"
}

uninstall_panel() {
  local volume_names=""
  local volume_name=""
  local volume_remove_failed="false"
  require_root
  load_existing_env
  if ! confirm_yes "Confirm uninstall ForwardX Docker panel and delete deployment dir + Docker volume? [y/N] "; then
    echo "[INFO] Uninstall cancelled"
    return
  fi
  volume_names="$(uninstall_data_volume_names)"
  persist_uninstall_data_volume_names "$volume_names"
  cd "$APP_DIR" 2>/dev/null || true
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    compose_cmd --env-file "$APP_DIR/.env" -p "$PROJECT_NAME" down --remove-orphans || true
  fi
  remove_existing_panel_containers
  cd /
  while IFS= read -r volume_name; do
    [ -z "$volume_name" ] && continue
    if ! docker volume inspect "$volume_name" >/dev/null 2>&1; then
      continue
    fi
    if docker volume rm "$volume_name" >/dev/null 2>&1; then
      echo "[INFO] Removed Docker data volume: $volume_name"
    else
      echo "[ERROR] Failed to remove Docker data volume: $volume_name"
      echo "[ERROR] The volume is still in use or Docker refused the removal. Existing administrator credentials remain in that volume."
      volume_remove_failed="true"
    fi
  done <<< "$volume_names"
  if [ "$volume_remove_failed" = "true" ]; then
    echo "[ERROR] ForwardX containers were removed, but persistent data was not fully deleted."
    echo "[INFO] Deployment metadata is retained at $APP_DIR so the remaining volume can be located and the uninstall retried."
    return 1
  fi
  rm -rf "$APP_DIR"
  echo "[INFO] External MySQL/PostgreSQL database contents, if configured, were not deleted."
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
