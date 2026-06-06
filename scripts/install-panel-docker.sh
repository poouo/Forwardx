#!/bin/bash
set -euo pipefail

ACTION="${1:-install}"
APP_DIR="${FORWARDX_DOCKER_DIR:-/opt/forwardx-docker}"
REPO_URL="${FORWARDX_REPO_URL:-https://github.com/poouo/Forwardx.git}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-forwardx}"
CONTAINER_NAME="${FORWARDX_CONTAINER_NAME:-forwardx-panel}"
PORT="${PORT:-3000}"
TARGET_IMAGE="${FORWARDX_IMAGE:-ghcr.io/poouo/forwardx:latest}"

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

fetch_source_refs() {
  git -C "$APP_DIR" fetch --force --prune origin \
    "+refs/heads/*:refs/remotes/origin/*" \
    "+refs/tags/*:refs/tags/*"
}

sync_source() {
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

  if [ -n "${FORWARDX_TARGET_VERSION:-}" ]; then
    echo "[信息] Docker 部署统一拉取 latest 镜像，并校验目标版本 ${FORWARDX_TARGET_VERSION}"
  fi

  git -C "$APP_DIR" checkout -f origin/main
  git -C "$APP_DIR" checkout -B main origin/main
}

write_env() {
  local jwt_secret="${JWT_SECRET:-}"
  if [ -z "$TARGET_IMAGE" ]; then
    TARGET_IMAGE="ghcr.io/poouo/forwardx:latest"
  fi
  if [ -f "$APP_DIR/.env" ]; then
    if grep -qE '^FORWARDX_IMAGE=' "$APP_DIR/.env"; then
      sed -i "s|^FORWARDX_IMAGE=.*|FORWARDX_IMAGE=$TARGET_IMAGE|" "$APP_DIR/.env"
    else
      printf '\nFORWARDX_IMAGE=%s\n' "$TARGET_IMAGE" >> "$APP_DIR/.env"
    fi
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
FORWARDX_IMAGE=$TARGET_IMAGE
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

normalize_version() {
  printf '%s\n' "${1#v}"
}

image_panel_version() {
  docker run --rm --entrypoint node "$TARGET_IMAGE" -p "require('./package.json').version"
}

assert_target_image_ready() {
  local target="${FORWARDX_TARGET_VERSION:-}"
  local expected=""
  local actual=""
  if [ -z "$target" ]; then
    return
  fi
  expected="$(normalize_version "$target")"
  actual="$(image_panel_version 2>/dev/null || true)"
  actual="$(normalize_version "$actual")"
  if [ -z "$actual" ]; then
    echo "[错误] 无法读取镜像 $TARGET_IMAGE 内的面板版本，请稍后重试或检查镜像是否可用。"
    exit 12
  fi
  if [ "$actual" != "$expected" ]; then
    echo "[错误] Docker 镜像尚未同步到目标版本 v$expected，当前拉取到的镜像版本为 v$actual。"
    echo "[提示] GitHub Actions 可能仍在构建 ghcr.io/poouo/forwardx:latest，请等待几分钟后重新执行升级。旧容器未被停止。"
    exit 12
  fi
}

start_panel() {
  cd "$APP_DIR"
  if [ -z "$TARGET_IMAGE" ]; then
    TARGET_IMAGE="$(grep -E '^FORWARDX_IMAGE=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  fi
  if [ -z "$TARGET_IMAGE" ]; then
    TARGET_IMAGE="ghcr.io/poouo/forwardx:latest"
  fi
  echo "[ForwardX] Pulling Docker image: $TARGET_IMAGE"
  compose_cmd -p "$PROJECT_NAME" pull forwardx
  assert_target_image_ready
  remove_existing_panel_containers
  compose_cmd -p "$PROJECT_NAME" up -d --remove-orphans forwardx
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
  write_env
  start_panel
  echo "[完成] ForwardX Docker 面板已覆盖旧容器并重启"
  echo "[信息] 已保留 .env 配置、Docker 数据卷和部署目录内的 data 数据"
}

uninstall_panel() {
  require_root
  load_existing_env
  if ! confirm_yes "确认卸载 ForwardX Docker 面板，并删除部署目录 $APP_DIR 和 Docker 数据卷 ${PROJECT_NAME}_forwardx-data ? [y/N] "; then
    echo "[取消] 未执行卸载"
    return
  fi
  cd "$APP_DIR" 2>/dev/null || true
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    compose_cmd -p "$PROJECT_NAME" down --remove-orphans || true
  fi
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

  rm -rf "$APP_DIR"
  docker volume rm "${PROJECT_NAME}_forwardx-data" 2>/dev/null || true
  echo "[完成] 已卸载 ForwardX Docker 面板并删除数据"
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
