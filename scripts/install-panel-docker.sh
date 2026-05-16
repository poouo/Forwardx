#!/bin/bash
set -euo pipefail

ACTION="${1:-install}"
APP_DIR="${FORWARDX_DOCKER_DIR:-/opt/forwardx-docker}"
REPO_URL="${FORWARDX_REPO_URL:-https://github.com/poouo/Forwardx.git}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-forwardx}"
CONTAINER_NAME="${FORWARDX_CONTAINER_NAME:-forwardx-panel}"
PORT="${PORT:-3000}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"

require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "[错误] 请使用 root 权限运行"
    exit 1
  fi
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

sync_source() {
  local target="${FORWARDX_TARGET_VERSION:-}"
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --tags origin
  else
    rm -rf "$APP_DIR"
    git clone "$REPO_URL" "$APP_DIR"
    git -C "$APP_DIR" fetch --tags origin
  fi

  if [ -z "$target" ]; then
    target="$(latest_tag)"
  fi
  if [ -n "$target" ]; then
    git -C "$APP_DIR" checkout -f "$target"
  else
    git -C "$APP_DIR" checkout -f main
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
ADMIN_PASSWORD=$ADMIN_PASSWORD
COMPOSE_PROJECT_NAME=$PROJECT_NAME
FORWARDX_CONTAINER_NAME=$CONTAINER_NAME
EOF
}

start_panel() {
  cd "$APP_DIR"
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  compose_cmd -p "$PROJECT_NAME" up -d --build --remove-orphans forwardx
}

install_panel() {
  require_root
  install_docker
  sync_source
  write_env
  start_panel
  echo "[完成] ForwardX Docker 面板已启动：http://服务器IP:$PORT"
  echo "[信息] 默认账号：admin"
  echo "[信息] 默认密码：$ADMIN_PASSWORD"
}

upgrade_panel() {
  require_root
  install_docker
  sync_source
  start_panel
  echo "[完成] ForwardX Docker 面板已覆盖旧容器并重启"
}

uninstall_panel() {
  require_root
  cd "$APP_DIR" 2>/dev/null || true
  if [ -f "$APP_DIR/docker-compose.yml" ]; then
    compose_cmd -p "$PROJECT_NAME" down --remove-orphans || true
  fi
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

  read -r -p "是否删除部署目录 $APP_DIR ? [y/N] " confirm_dir
  case "$confirm_dir" in
    y|Y|yes|YES) rm -rf "$APP_DIR"; echo "[完成] 已删除 $APP_DIR" ;;
    *) echo "[信息] 已保留 $APP_DIR" ;;
  esac

  read -r -p "是否删除 Docker 数据卷 ${PROJECT_NAME}_forwardx-data ? [y/N] " confirm_volume
  case "$confirm_volume" in
    y|Y|yes|YES) docker volume rm "${PROJECT_NAME}_forwardx-data" 2>/dev/null || true ;;
  esac
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
