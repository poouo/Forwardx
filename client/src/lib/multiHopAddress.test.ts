import assert from "node:assert/strict";
import test from "node:test";
import {
  multiHopAddressSelection,
  selectedMultiHopConnectHost,
} from "./multiHopAddress";

const host = {
  entryIp: "103.177.163.138",
  ipv4: "148.135.253.138",
  ipv6: "2400:8a20:114:2::bd",
  tunnelEntryIp: "103.177.163.138",
};

test("keeps public and private modes distinct when their configured addresses match", () => {
  assert.equal(selectedMultiHopConnectHost({
    host,
    index: 1,
    externalEntry: false,
    useTunnelEntryIp: false,
    useIpv6: false,
  }), null);
  assert.equal(selectedMultiHopConnectHost({
    host,
    index: 1,
    externalEntry: false,
    useTunnelEntryIp: true,
    useIpv6: false,
  }), "103.177.163.138");

  assert.deepEqual(multiHopAddressSelection({
    host,
    connectHost: null,
    index: 1,
    externalEntry: false,
  }), { useTunnelEntryIp: false, useIpv6: false });
  assert.deepEqual(multiHopAddressSelection({
    host,
    connectHost: "103.177.163.138",
    index: 1,
    externalEntry: false,
  }), { useTunnelEntryIp: true, useIpv6: false });
});

test("restores an explicit IPv6 selection independently of private mode", () => {
  assert.equal(selectedMultiHopConnectHost({
    host,
    index: 1,
    externalEntry: false,
    useTunnelEntryIp: false,
    useIpv6: true,
  }), "2400:8a20:114:2::bd");
  assert.deepEqual(multiHopAddressSelection({
    host,
    connectHost: "[2400:8a20:114:2::bd]",
    index: 1,
    externalEntry: false,
  }), { useTunnelEntryIp: false, useIpv6: true });
});
