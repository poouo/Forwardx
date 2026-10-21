import assert from "node:assert/strict";
import test from "node:test";
import { BBR_FQ_PRESET, isSupportedSysctlKey, parseSysctlConfig, updateSysctlConfig } from "./sysctlConfig";

test("minimal BBR preset contains exactly congestion control and default queue", () => {
  assert.deepEqual([...parseSysctlConfig(BBR_FQ_PRESET)], [["net.core.default_qdisc", "fq"], ["net.ipv4.tcp_congestion_control", "bbr"]]);
});

test("sysctl parser accepts tuples, CRLF and comments", () => {
  const values = parseSysctlConfig("# preset\r\n; comment\r\nnet.ipv4.tcp_rmem = 4096\t131072 6291456 # bytes\r\nnet.core.somaxconn=4096\r\n");
  assert.equal(values.get("net.ipv4.tcp_rmem"), "4096 131072 6291456");
  assert.equal(values.get("net.core.somaxconn"), "4096");
  assert.equal(parseSysctlConfig("# empty").size, 0);
});

test("sysctl parser rejects commands, includes, wildcards and duplicate keys", () => {
  for (const text of ["net.ipv4.tcp_syncookies=$(id)", "net.core.default_qdisc=fq;reboot", "include /etc/sysctl.conf",
    "net.ipv4.tcp_*=1", "kernel.panic=1", "net.ipv4.ip_forward=1", "net.ipv4.tcp_congestion_control=",
    "net.core.somaxconn=1\nnet.core.somaxconn=2", "net.ipv4.tcp_syncookies=1\u0000"]) {
    assert.throws(() => parseSysctlConfig(text), Error, text);
  }
  assert.throws(() => parseSysctlConfig("#" + "x".repeat(12000)), /12000/);
  assert.throws(() => parseSysctlConfig("#" + "中".repeat(4000)), /12000/);
});

test("visual updates preserve unknown supported keys, comments and ordering", () => {
  const original = "# custom\nnet.ipv4.tcp_syncookies = 1 # keep\nnet.ipv4.tcp_congestion_control = cubic # algorithm\n";
  const updated = updateSysctlConfig(original, "net.ipv4.tcp_congestion_control", "bbr");
  assert.equal(updated, original.replace("= cubic", "= bbr"));
  assert.equal(parseSysctlConfig(updated).get("net.ipv4.tcp_syncookies"), "1");
  const appended = updateSysctlConfig(updated, "net.core.default_qdisc", "fq");
  assert.equal(parseSysctlConfig(appended).get("net.core.default_qdisc"), "fq");
  assert.equal(appended.indexOf("tcp_syncookies") < appended.indexOf("tcp_congestion_control"), true);
  const removed = updateSysctlConfig(appended, "net.ipv4.tcp_congestion_control", "");
  assert.equal(parseSysctlConfig(removed).has("net.ipv4.tcp_congestion_control"), false);
  assert.match(removed, /# algorithm/);
  assert.equal(parseSysctlConfig(updateSysctlConfig("net.core.default_qdisc=fq\n", "net.core.default_qdisc", "")).size, 0);
});

test("supported key scope is limited to TCP and selected core parameters", () => {
  for (const key of ["net.ipv4.tcp_syncookies", "net.core.rmem_default", "net.core.default_qdisc"]) assert.equal(isSupportedSysctlKey(key), true);
  for (const key of ["kernel.panic", "vm.swappiness", "net.ipv4.ip_forward", "net.core.bpf_jit_enable", "net.core.unknown"]) assert.equal(isSupportedSysctlKey(key), false);
});
