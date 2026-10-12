# Agent proxies and SSH management

[简体中文](./agent-proxy-manager.md)

Requires a panel installer and Agent containing this feature. Installation/upgrades register the four-letter `fwxm` (ForwardX Manager) command. Local and Docker panels are supported; Docker management runs on the **host**, not inside the container.

## Install through SOCKS

Run as root on the managed host, replacing the proxy, panel URL and Token:

```bash
curl --proxy 'socks5h://127.0.0.1:1080' -fsSL \
  https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-agent.sh \
  -o /tmp/forwardx-install-agent.sh

PANEL_URL='https://panel.example.com' bash /tmp/forwardx-install-agent.sh \
  install YOUR_TOKEN --proxy 'socks5h://127.0.0.1:1080'
```

The first proxy covers downloading the bootstrap; the installer option covers subsequent downloads, registration, runtime management and upgrades. You can also download your panel's `/api/agent/install.sh` and pass the same options. A proxy argument to Bash cannot proxy an earlier curl request.

Supports `socks5h://`, `socks5://` (normalized to remote DNS), `http://` and `https://`, with an explicit port and optional URL-encoded credentials: `socks5h://user:password@proxy.example.com:1080`. Encode special characters, e.g. `@` as `%40`. Arguments can be visible in shell history/process listings; use the hidden prompt below for secrets. Protect config files with mode 600 and do not share them.

The proxy covers registration, heartbeats, traffic reports, event streams and installer/upgrade downloads. It **does not** proxy forwarding/tunnel data, public IP discovery or ping/tcping/iperf tests. Allow long-lived panel connections. Unavailable proxies cause offline status/upgrade failures, not silent direct fallback.

System dependency installation depends on the package manager. Prefer modern Debian/Ubuntu APT or libcurl-based managers. Alpine APK does not reliably support SOCKS; preinstall dependencies or use an HTTP proxy. Download support does not imply every package manager supports SOCKS.

## Existing Agents and direct mode

Upgrade older Agents first. Edit `/etc/forwardx/agent/config.json`, preserving **all existing fields**, especially the Token:

```json
{
  "panelUrl": "https://panel.example.com",
  "token": "KEEP_YOUR_EXISTING_TOKEN",
  "interval": 30,
  "proxyUrl": "socks5h://127.0.0.1:1080"
}
```

Restart with `systemctl restart forwardx-agent` (or your init system). Remove `proxyUrl` or set it to `""` and restart for explicit direct mode, ignoring inherited `HTTP_PROXY` / `ALL_PROXY`.

```bash
fwxm agent proxy show       # Redacts credentials
fwxm agent proxy set        # Hidden URL prompt; saves and restarts Agent
fwxm agent proxy off        # Saves direct mode and restarts Agent
fwxm agent upgrade          # Reuses the configured proxy
```

Proxy changes restart only the Agent, not standalone forwarding runtimes intentionally; upgrades/reinstallation cannot guarantee uninterrupted forwarding. Manual installer upgrades accept `upgrade --proxy URL` or `upgrade --no-proxy`. Panel-triggered upgrades also read protected config inside the upgrade task, without relying on systemd environment inheritance.

## Commands

Run `fwxm` for an interactive menu. Explicit commands:

With one installed role its menu opens directly; with both roles choose panel or Agent first. Menu item **2** shows runtime status, **4** restarts the selected role, and **0** exits. Only the panel menu offers admin password reset. Use `sudo fwxm` as a non-root user. Commands finish after the selected action; run `fwxm` again to reopen the menu.

| Command | Action |
| --- | --- |
| `fwxm agent info` / `fwxm panel info` | Paths, service, redacted proxy, address; no Token/database password |
| `fwxm agent status` / `fwxm panel status` | Service status |
| `fwxm agent logs` / `fwxm panel logs` | Follow logs; Ctrl+C exits |
| `fwxm agent start\|stop\|restart` | Control Agent service |
| `fwxm panel start\|stop\|restart` | Control local service or Docker container |
| `fwxm agent upgrade` / `fwxm panel upgrade` | Upgrade |
| `fwxm agent repair` / `fwxm panel repair` | Reinstall available latest binaries, preserve config/data, restart; may upgrade versions |
| `fwxm agent uninstall` / `fwxm panel uninstall` | Interactive removal; panel installer separately asks about data |
| `fwxm panel reset-admin` | Interactive password reset for local/Docker panel |
| `fwxm panel address` | Port, host address hints, Docker mapping; check reverse proxy for public domain |
| `fwxm panel proxy show\|set\|off` | Maintenance download proxy only |

When both roles are installed, specify `agent` or `panel`. Schedule repairs/removal as maintenance. Small management scripts and cached installers remain after removal to allow reinstallation; no background service is added. `install` on an existing deployment behaves as an upgrade to preserve registration/data.

Panel maintenance proxy only affects download tools that support proxy environment variables, not Node runtime notifications/OAuth; npm/system package SOCKS support varies. **Docker image pulls use the Docker daemon** and require its own HTTP/HTTPS proxy configuration (a SOCKS-only proxy needs an HTTP endpoint/adapter). `fwxm` does not modify global Docker settings.

Official installers record custom paths, service/container names and Compose project names. Manual Compose deployments and older releases without `fwxm` should first upgrade using the matching official installer; do not blindly run default installation against an unknown existing deployment.
