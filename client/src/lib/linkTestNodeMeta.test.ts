import assert from "node:assert/strict";
import test from "node:test";
import {
  addHostNodeMeta,
  addTunnelHostNodeMeta,
  countryCodeToEmoji,
  hostNodeMeta,
  targetGeoNodeMeta,
  type LinkTestNodeMeta,
} from "./linkTestNodeMeta";

test("builds host node metadata with a normalized country code", () => {
  const meta = hostNodeMeta({
    id: 7,
    name: "Tokyo Entry",
    ipv4: "203.0.113.7",
    geoCountryCode: "jp",
    geoCountryName: "Japan",
    geoRegion: "Tokyo",
  });

  assert.equal(meta?.countryCode, "JP");
  assert.equal(meta?.emoji, countryCodeToEmoji("JP"));
  assert.equal(meta?.region, "Japan / Tokyo");
});

test("adds host metadata aliases used by link-test nodes", () => {
  const metadata: Record<string, LinkTestNodeMeta | undefined> = {};
  addHostNodeMeta(metadata, {
    id: 9,
    name: "Singapore Exit",
    entryIp: "198.51.100.9",
    geoCountryCode: "SG",
  }, ["Exit"]);

  assert.equal(metadata["Singapore Exit"]?.countryCode, "SG");
  assert.equal(metadata["198.51.100.9"]?.countryCode, "SG");
  assert.equal(metadata["Exit"]?.countryCode, "SG");
  assert.equal(metadata["9"]?.countryCode, "SG");
});

test("keeps target lookup country metadata available for flag rendering", () => {
  const meta = targetGeoNodeMeta("Target", "example.com", {
    geoCountryCode: "us",
    geoCountryName: "United States",
    geoRegion: "California",
    resolvedAddress: "203.0.113.20",
  });

  assert.equal(meta.countryCode, "US");
  assert.equal(meta.region, "United States / California");
  assert.equal(meta.address, "example.com / 203.0.113.20");
});

test("multi-exit metadata includes secondary exits omitted from the primary path", () => {
  const metadata: Record<string, LinkTestNodeMeta | undefined> = {};
  const entry = { id: 30, name: "香港 30", geoCountryCode: "HK" };
  const primary = { id: 44, name: "香港 01", geoCountryCode: "CA" };
  const secondary = { id: 11, name: "香港 11", geoCountryCode: "HK", geoRegion: "Hong Kong" };
  const tunnel = { entryHostId: 30, exitHostId: 44, hopHostIds: [30, 44], entryHost: entry,
    exitHost: primary, loadBalanceExits: [{ hostId: 11, host: secondary }] };
  const originals = JSON.stringify(tunnel);
  const hostById = addTunnelHostNodeMeta(metadata, tunnel, [entry, primary]);
  assert.equal(metadata["44"]?.countryCode, "CA");
  assert.equal(metadata["11"]?.countryCode, "HK");
  assert.equal(metadata["香港 11"]?.region, "HK / Hong Kong");
  assert.equal(hostById.get(11)?.name, "香港 11");
  assert.equal(JSON.stringify(tunnel), originals, "metadata enrichment must not mutate cached API data");
});

test("endpoint groups and sparse options retain geo metadata without inventing unknown flags", () => {
  const metadata: Record<string, LinkTestNodeMeta | undefined> = {};
  const hostById = addTunnelHostNodeMeta(metadata, {
    entryGroup: { members: [{ hostId: 1, host: { id: 1, name: "entry", geoCountryCode: "JP" } }] },
    exitGroup: { members: [{ hostId: 2, host: { id: 2, name: "exit", geoCountryCode: "SG" } }] },
    loadBalanceExits: [{ hostId: 3 }, { hostId: 4 }],
  }, [
    { id: 1, name: "full entry", geoCountryCode: null },
    { id: 2, name: "full exit", geoCountryCode: "US" },
    { id: 3, name: "known without geo" },
  ]);
  assert.equal(hostById.get(1)?.geoCountryCode, "JP");
  assert.equal(metadata["1"]?.countryCode, "JP");
  assert.equal(metadata["2"]?.countryCode, "US", "current host options take precedence over summaries");
  assert.equal(metadata["3"]?.countryCode, null, "do not guess a country's flag from its name");
  assert.equal(metadata["4"], undefined);
});
