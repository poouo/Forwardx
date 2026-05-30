#!/bin/bash
set -euo pipefail

ACTION="${1:-install}"
APP_DIR="${FORWARDX_DOCKER_DIR:-/opt/forwardx-docker}"
REPO_URL="${FORWARDX_REPO_URL:-https://github.com/poouo/Forwardx.git}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-forwardx}"
CONTAINER_NAME="${FORWARDX_CONTAINER_NAME:-forwardx-panel}"
PORT="${PORT:-3000}"

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

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[错误] 未找到 Docker Compose，请先安装 Docker Compose 插件"
    exit 1
  fi
}

load_existing_env() {
  local env_file="$APP_DIR/.env"
  if [ ! -f "$env_file" ]; then
    return
  fi
  local value
  value="$(grep -E '^PORT=' "$env_file" | tail -1 | cut -d= -f2- || true)"
  if [ -n "$value" ]; then PORT="$value"; fi
  value="$(grep -E '^COMPOSE_PROJECT_NAME=' "$env_file" | tail -1 | cut -d= -f2- || true)"
  if [ -n "$value" ]; then PROJECT_NAME="$value"; fi
  value="$(grep -E '^FORWARDX_CONTAINER_NAME=' "$env_file" | tail -1 | cut -d= -f2- || true)"
  if [ -n "$value" ]; then CONTAINER_NAME="$value"; fi
}

install_base_deps() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl git openssl >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q git curl ca-certificates openssl
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q git curl ca-certificates openssl
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache git curl ca-certificates openssl
  fi
}

install_docker() {
  install_base_deps
  if command -v docker >/dev/null 2>&1; then
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
    return
  fi
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q docker
    systemctl enable --now docker
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q docker
    systemctl enable --now docker
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache docker docker-cli-compose
    rc-update add docker default 2>/dev/null || true
    service docker start 2>/dev/null || true
  fi
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

write_env() {
  local jwt_secret="${JWT_SECRET:-}"
  if [ -f "$APP_DIR/.env" ]; then
    return
  fi
  if [ -z "$jwt_secret" ]; then
    jwt_secret="$(openssl rand -hex 32 2>/dev/null || date +%s%N | sha256sum | awk '{print $1}')"
  fi
  cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
JWT_SECRET=$jwt_secret
COMPOSE_PROJECT_NAME=$PROJECT_NAME
FORWARDX_CONTAINER_NAME=$CONTAINER_NAME
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

start_panel() {
  cd "$APP_DIR"
  remove_existing_panel_containers
  compose_cmd -p "$PROJECT_NAME" up -d --build --remove-orphans forwardx
}

install_panel() {
  require_root
  install_docker
  load_existing_env
  sync_source
  write_env
  start_panel
  echo "[完成] ForwardX Docker 面板已启动：http://服务器IP:$PORT"
  echo "[信息] 首次打开面板后请配置 MySQL；如果连接旧数据库，将自动复用原有管理员和数据。"
}

upgrade_panel() {
  require_root
  load_existing_env
  install_docker
  sync_source
  start_panel
  echo "[完成] ForwardX Docker 面板已覆盖旧容器并重启"
  echo "[信息] 已保留 .env 配置、Docker 数据卷和部署目录内的 data 数据"
}

uninstall_panel() {
  require_root
  cd "$APP_DIR" 2>/dev/null || true
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    compose_cmd -p "$PROJECT_NAME" down --remove-orphans || true
  fi
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

  if confirm_yes "是否删除部署目录 $APP_DIR ? [y/N] "; then
    rm -rf "$APP_DIR"
    echo "[完成] 已删除 $APP_DIR"
  else
    echo "[信息] 已保留 $APP_DIR"
  fi

  if confirm_yes "是否删除 Docker 数据卷 ${PROJECT_NAME}_forwardx-data ? [y/N] "; then
    docker volume rm "${PROJECT_NAME}_forwardx-data" 2>/dev/null || true
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
