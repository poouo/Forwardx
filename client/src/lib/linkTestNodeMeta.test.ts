import assert from "node:assert/strict";
import test from "node:test";
import {
  addHostNodeMeta,
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
