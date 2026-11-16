set -u
cd /root/fxtest
mkdir -p img && cat > img/Dockerfile <<'D'
FROM debian:13
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus curl ca-certificates iproute2 iptables nftables procps kmod python3 socat iperf3 jq openssl xz-utils conntrack unzip >/dev/null && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-resolved.service systemd-networkd.service getty.target console-getty.service >/dev/null 2>&1 || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
D
docker build -q -t fxt-node img 2>&1 | tail -2
i=11
for h in h1 h2 h3; do
  docker rm -f fxt-$h >/dev/null 2>&1
  docker run -d --name fxt-$h --hostname fxt-$h --network fxtest --ip 172.30.0.$i --privileged --cgroupns=host \
    --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw fxt-node >/dev/null
  i=$((i+1))
done
docker rm -f fxt-target fxt-client >/dev/null 2>&1
docker run -d --name fxt-target --hostname fxt-target --network fxtest --ip 172.30.0.20 fxt-node sleep infinity >/dev/null
docker run -d --name fxt-client --hostname fxt-client --network fxtest --ip 172.30.0.30 fxt-node sleep infinity >/dev/null
sleep 6
docker ps --format '{{.Names}} {{.Status}}' | grep fxt-
TOKENS="$(bash ./n.sh s2.mjs)"; echo "$TOKENS" > tokens.json; echo "tokens: $(echo "$TOKENS" | jq -r 'keys|join(",")')"
for pair in h1:h1-entry h2:h2-relay h3:h3-exit; do
  h="${pair%%:*}"; key="${pair##*:}"; tok="$(jq -r --arg k "$key" '.[$k]' tokens.json)"
  echo "== install agent on $h"
  docker exec fxt-$h bash -c "curl -fsSL http://172.30.0.2:3000/api/agent/install.sh -o /tmp/i.sh && FORWARDX_INSTALL_MIMIC=no bash /tmp/i.sh install '$tok' </dev/null" 2>&1 | tail -6 | cut -c1-200
  docker exec fxt-$h systemctl is-active forwardx-agent
done
echo S2_DONE
