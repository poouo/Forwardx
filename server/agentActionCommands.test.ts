import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCountingChainCmds,
  buildNftForwardCmds,
  restartMimicServiceIfConfigChangedCmd,
} from "./agentActionCommands";

test("nft rule comments keep nft string quotes after shell parsing", () => {
  const commands = buildNftForwardCmds({
    id: 42,
    sourcePort: 22222,
    targetIp: "203.0.113.10",
    targetPort: 443,
    protocol: "both",
  }).join("\n");

  assert.match(commands, /comment '\"fwx-rule-42-in\"'/);
  assert.match(commands, /comment '\"fwx-rule-42-out\"'/);
  assert.match(commands, /comment '\"fwx-rule-42\"'/);
  assert.doesNotMatch(commands, /comment \"fwx-rule-42-(?:in|out)\"/);
  assert.doesNotMatch(commands, /fwx-rule-42:(?:in|out)/);
});

test("all process forwarding modes use the shared bidirectional counters", () => {
  const commands = buildCountingChainCmds(22022, "target.example", 443, "both").join("\n");

  assert.match(commands, /fwx-stat-22022:in/);
  assert.match(commands, /fwx-stat-22022:out/);
  assert.match(commands, /PREROUTING -p tcp --dport 22022/);
  assert.match(commands, /INPUT -p tcp --dport 22022/);
  assert.match(commands, /OUTPUT -p tcp --sport 22022/);
  assert.match(commands, /POSTROUTING -p tcp --sport 22022/);
  assert.match(commands, /PREROUTING -p udp --dport 22022/);
  assert.match(commands, /OUTPUT -p udp --sport 22022/);
  assert.match(commands, /table inet forwardx_traffic/);
  assert.match(commands, /forwardx_traffic input meta l4proto tcp tcp dport 22022/);
  assert.match(commands, /forwardx_traffic output meta l4proto tcp tcp sport 22022/);
  assert.doesNotMatch(commands, /target\.example/);
});

test("kernel forwarding gets nft forward-hook counters matched on the DNAT target", () => {
  const commands = buildCountingChainCmds(22022, "203.0.113.10", 443, "both").join("\n");

  // DNAT rewrites the destination before the forward hook, so the forward
  // counters match the target endpoint while conntrack keeps the listener
  // identity available after the rewrite.
  assert.match(commands, /forwardx_traffic forward '\{ type filter hook forward priority mangle; policy accept; \}'/);
  assert.match(commands, /forwardx_traffic forward meta l4proto tcp ct original proto-dst 22022 ip daddr 203\.0\.113\.10 tcp dport 443 counter comment '"fwx-stat-22022:in"'/);
  assert.match(commands, /forwardx_traffic forward meta l4proto tcp ct original proto-dst 22022 ip saddr 203\.0\.113\.10 tcp sport 443 counter comment '"fwx-stat-22022:out"'/);
  assert.match(commands, /forwardx_traffic forward meta l4proto udp ct original proto-dst 22022 ip daddr 203\.0\.113\.10 udp dport 443/);
  assert.match(commands, /FORWARD -p tcp -m conntrack --ctorigdstport 22022 -d 203\.0\.113\.10 --dport 443/);
  assert.match(commands, /FORWARD -p tcp -m conntrack --ctorigdstport 22022 -s 203\.0\.113\.10 --sport 443/);
  // Keep the original-port chains as a compatibility fallback on hosts where
  // one counter backend is unavailable.
  assert.match(commands, /PREROUTING -p tcp --dport 22022/);
  assert.match(commands, /POSTROUTING -p tcp --sport 22022/);
  // The cleanup pass must sweep the forward chain too, or stale counters leak.
  assert.match(commands, /for c in input output forward; do/);
});

test("native nft return counters keep shared targets isolated by original listener port", () => {
  const commands = buildNftForwardCmds({
    id: 42,
    sourcePort: 22022,
    targetIp: "203.0.113.10",
    targetPort: 443,
    protocol: "tcp",
  }).join("\n");

  assert.match(commands, /forward meta l4proto tcp ip daddr 203\.0\.113\.10 tcp dport 443 ct original proto-dst 22022 counter accept comment '\"fwx-rule-42-in\"'/);
  assert.match(commands, /forward meta l4proto tcp ip daddr 203\.0\.113\.10 tcp dport 443 ct original proto-dst 22022 comment '\"fwx-rule-42-in\"' counter accept/);
  assert.match(commands, /forward meta l4proto tcp ip saddr 203\.0\.113\.10 tcp sport 443 ct original proto-dst 22022 ct state established,related counter accept comment '\"fwx-rule-42-out\"'/);
  assert.match(commands, /forward meta l4proto tcp ip saddr 203\.0\.113\.10 tcp sport 443 ct original proto-dst 22022 ct state established,related comment '\"fwx-rule-42-out\"' counter accept/);
  assert.match(commands, /forward meta l4proto tcp ip daddr 203\.0\.113\.10 tcp dport 443 ct original proto-dst 22022 accept comment '\"fwx-rule-42\"'/);
  assert.doesNotMatch(commands, /forward meta l4proto tcp ip saddr 203\.0\.113\.10 tcp sport 443 ct state established,related counter accept comment/);
});

test("process counters do not attribute shared target traffic to every listener", () => {
  const commands = buildCountingChainCmds(22022, "203.0.113.10", 443, "tcp").join("\n");

  // Listener hooks account realm/socat/gost/nginx proxy traffic. Target-only
  // local hooks cannot identify which proxy instance opened the connection,
  // so only the conntrack-qualified FORWARD rules remain for kernel DNAT.
  assert.doesNotMatch(commands, /-A OUTPUT .* -d 203\.0\.113\.10 --dport 443 .*fwx-stat-22022:in/);
  assert.doesNotMatch(commands, /-A POSTROUTING .* -d 203\.0\.113\.10 --dport 443 .*fwx-stat-22022:in/);
  assert.doesNotMatch(commands, /-A PREROUTING .* -s 203\.0\.113\.10 --sport 443 .*fwx-stat-22022:out/);
  assert.doesNotMatch(commands, /-A INPUT .* -s 203\.0\.113\.10 --sport 443 .*fwx-stat-22022:out/);
  assert.match(commands, /-A FORWARD .*--ctorigdstport 22022 -d 203\.0\.113\.10 --dport 443 .*fwx-stat-22022:in/);
  assert.match(commands, /-A FORWARD .*--ctorigdstport 22022 -s 203\.0\.113\.10 --sport 443 .*fwx-stat-22022:out/);
});

test("forward-hook counters isolate listeners that share one DNAT target", () => {
  const first = buildCountingChainCmds(22022, "203.0.113.10", 443, "tcp").join("\n");
  const second = buildCountingChainCmds(22023, "203.0.113.10", 443, "tcp").join("\n");

  assert.match(first, /ct original proto-dst 22022 ip daddr 203\.0\.113\.10 tcp dport 443/);
  assert.match(second, /ct original proto-dst 22023 ip daddr 203\.0\.113\.10 tcp dport 443/);
  assert.match(first, /--ctorigdstport 22022 -d 203\.0\.113\.10 --dport 443/);
  assert.match(second, /--ctorigdstport 22023 -d 203\.0\.113\.10 --dport 443/);
  assert.doesNotMatch(first, /ct original proto-dst 22023/);
  assert.doesNotMatch(second, /ct original proto-dst 22022/);
});

test("nft forward-hook counters use the ip6 family for IPv6 targets", () => {
  const commands = buildCountingChainCmds(22022, "2001:db8::10", 443, "tcp").join("\n");

  assert.match(commands, /forwardx_traffic forward meta l4proto tcp ct original proto-dst 22022 ip6 daddr 2001:db8::10 tcp dport 443/);
  assert.match(commands, /forwardx_traffic forward meta l4proto tcp ct original proto-dst 22022 ip6 saddr 2001:db8::10 tcp sport 443/);
});

test("nft forward-hook counters are skipped when the target is not a resolved IP", () => {
  const commands = buildCountingChainCmds(22022, "", 0, "both").join("\n");

  assert.match(commands, /forwardx_traffic input meta l4proto tcp tcp dport 22022/);
  assert.doesNotMatch(commands, /forwardx_traffic forward meta/);
});

test("Mimic service reconciliation cleans stale hooks and has an skb fallback", () => {
  const commands = restartMimicServiceIfConfigChangedCmd("mimic@eth0", "/etc/mimic/eth0.conf", "eth0");

  assert.match(commands, /xdp_mode = /);
  assert.match(commands, /forwardx-xdp-mode/);
  assert.match(commands, /xdpdrv off/);
  assert.match(commands, /\/run\/mimic\/\*_\"\$mimic_ifindex\"\.lock/);
  assert.match(commands, /\$mimic_xdp_mode XDP\/TC hooks were not ready; retrying with \$mimic_fallback_mode mode/);
  assert.match(commands, /if \[ "\$mimic_xdp_mode" = "native" \]; then mimic_fallback_mode=skb; else mimic_fallback_mode=native; fi/);
  assert.match(commands, /mimic_existing_xdp_mode/);
  assert.match(commands, /forwardx-bpf\.conf/);
  assert.match(commands, /CAP_BPF/);
  assert.match(commands, /mimic_dropin_changed/);
  assert.match(commands, /\$\{mimic_force_restart:-0\}/);
  assert.match(commands, /if \[ "\$mimic_needs_start" = "1" \]; then\s+mimic_cleanup_runtime/);
  assert.match(commands, /virtio\|virtio_net\|veth\|tap\|tun\|\*\) mimic_xdp_mode=skb/);
  assert.match(commands, /mimic_start_service\(\)/);
  assert.match(commands, /mimic_start_output="\$\(mimic_start_service 2>&1\)"/);
  assert.match(commands, /service is active but XDP\/TC hooks were not detected/);
  assert.doesNotMatch(commands, /\/sys\/class\/net\/'eth0'\//);
  assert.doesNotMatch(commands, /systemctl disable 'mimic@eth0'/);
});
