# Sourced only by the panel installers after a successful deployment.
install_panel_management() {
  local kind="$1" assets="$2" dir=/etc/forwardx/manage name
  for name in agent-proxy.sh install-agent.sh forwardx-manage.sh "install-panel-$kind.sh"; do
    [ -s "$assets/$name" ] && bash -n "$assets/$name" || { echo '[WARN] Management assets missing/invalid; fwxm was not updated.' >&2; return 1; }
  done
  mkdir -p "$dir" /usr/local/bin
  chmod 700 "$dir"
  for name in agent-proxy.sh install-agent.sh forwardx-manage.sh "install-panel-$kind.sh"; do
    install -m 600 "$assets/$name" "$dir/$name.new" && mv -f "$dir/$name.new" "$dir/$name" || return 1
  done
  # Plain metadata: never evaluate configuration as shell code.
  (umask 077
    printf '%s\n' "$kind" > "$dir/panel-kind"
    printf '%s\n' "$APP_DIR" > "$dir/panel-dir"
    printf '%s\n' "${SERVICE_NAME:-forwardx-panel}" > "$dir/panel-service"
    printf '%s\n' "${CONTAINER_NAME:-forwardx-panel}" > "$dir/panel-container"
    printf '%s\n' "${PROJECT_NAME:-forwardx}" > "$dir/panel-project"
  )
  install -m 755 "$assets/forwardx-manage.sh" /usr/local/bin/fwxm.new && mv -f /usr/local/bin/fwxm.new /usr/local/bin/fwxm || return 1
  echo '[INFO] SSH management: fwxm panel'
}
