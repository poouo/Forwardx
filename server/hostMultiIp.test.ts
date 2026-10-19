import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostAddressOptions, normalizeHostIp, parseHostAddresses } from "../shared/hostAddresses";
import { mergeAgentReportedAddress } from "./agentAddressState";
import { hostDdnsTargets } from "./hostDdns";
import { assertNoDirectSelfForwardLoop } from "./directForwardLoop";

test("address lists validate, canonicalize, deduplicate and retain the primary within limits", () => {
  assert.deepEqual(parseHostAddresses('["8.8.8.8","1.1.1.1","8.8.8.8","bad",null,"256.1.1.1"]', "ipv4"), ["1.1.1.1", "8.8.8.8"]);
  assert.equal(normalizeHostIp("2606:4700:4700:0:0:0:0:1111", "ipv6"), "2606:4700:4700::1111");
  for (const value of ["[::1]", "::1%eth0", "abc", "8.8.8.8", "::1/path"]) assert.equal(normalizeHostIp(value, "ipv6"), "");
  const options = hostAddressOptions({ ipv4: "9.9.9.9", ipv4Addresses: Array.from({ length: 128 }, (_, i) => `1.1.1.${i}`) }, "ipv4");
  assert.equal(options.length, 128); assert.ok(options.includes("9.9.9.9"));
});

test("selected primaries survive full, compact, restart and legacy reports; removed preferences fall back", () => {
  const host = { ip: "8.8.8.8", ipv4: "8.8.8.8", ipv6: "2606:4700:4700::1111", preferredIpv4: "8.8.8.8", ipv4Addresses: '["1.1.1.1","8.8.8.8"]' };
  const full = mergeAgentReportedAddress({ ipv4: "1.1.1.1", ipv4Addresses: ["1.1.1.1", "8.8.8.8"] }, host);
  assert.equal(full.ipv4, "8.8.8.8"); assert.equal(full.ip, "8.8.8.8");
  assert.equal(mergeAgentReportedAddress({ ipv4Addresses: ["1.1.1.1", "8.8.8.8"] }, { ...host, preferredIpv4: null }).ipv4, "8.8.8.8", "compact report retains automatic primary");
  assert.equal(mergeAgentReportedAddress({ ipv4Addresses: [] }, host).ipv4, "8.8.8.8", "startup inventory cannot erase valid addresses");
  assert.equal(mergeAgentReportedAddress({ ipv4: "1.1.1.1" }, host).ipv4, "8.8.8.8", "old Agents cannot erase saved aliases");
  const removed = mergeAgentReportedAddress({ ipv4: "1.1.1.1", ipv4Addresses: ["1.1.1.1"] }, host);
  assert.equal(removed.ipv4, "1.1.1.1"); assert.deepEqual(JSON.parse(removed.ipv4Addresses), ["1.1.1.1"]);
  const restored = mergeAgentReportedAddress({ ipv4: "1.1.1.1", ipv4Addresses: ["1.1.1.1", "8.8.8.8"] }, { ...host, ...removed });
  assert.equal(restored.ipv4, "8.8.8.8");
});

test("dual-stack DDNS distinguishes primary-only and complete inventory", () => {
  const host = { ddnsIpVersion: "both", ipv4: "8.8.8.8", ipv6: "2606:4700:4700::1111", ipv4Addresses: '["8.8.8.8","1.1.1.1"]', ipv6Addresses: '["2606:4700:4700::1111","2606:4700:4700::1001"]' };
  assert.deepEqual(hostDdnsTargets(host).map(item => item.values), [[host.ipv4], [host.ipv6]]);
  assert.deepEqual(hostDdnsTargets({ ...host, ddnsAddressMode: "all" }).map(item => item.values), [["1.1.1.1", "8.8.8.8"], ["2606:4700:4700::1001", host.ipv6]]);
  assert.deepEqual(hostDdnsTargets({ ...host, ddnsIpVersion: "ipv6" }).map(item => item.recordType), ["AAAA"]);
});

test("secondary IPv4 and canonical IPv6 are included in self-forward loop checks", () => {
  const host = { ipv4: "1.1.1.1", ipv4Addresses: '["1.1.1.1","8.8.8.8"]', ipv6Addresses: '["2606:4700:4700::1111"]' };
  for (const targetIp of ["8.8.8.8", "2606:4700:4700:0:0:0:0:1111"]) assert.throws(() => assertNoDirectSelfForwardLoop({ host, sourcePort: 443, targetIp, targetPort: 443 }));
  assert.doesNotThrow(() => assertNoDirectSelfForwardLoop({ host, sourcePort: 443, targetIp: "8.8.8.8", targetPort: 444 }));
});

test("SQLite upgrade, primary selection permissions and DDNS replacement/retry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-multi-ip-"));
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/hostMultiIp.fixture.ts"], { cwd: process.cwd(), encoding: "utf8", timeout: 90000,
      env: { ...process.env, DATABASE_TYPE: "sqlite", FORWARDX_TEST_DB: path.join(directory, "test.db"), FORWARDX_LOG_DIR: path.join(directory, "logs"), JWT_SECRET: "host-multi-ip-test-secret-only-32-characters", TELEGRAM_BOT_TOKEN: "", DISCORD_BOT_TOKEN: "" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
