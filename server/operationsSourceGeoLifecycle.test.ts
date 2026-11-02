import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("offline IP data reloads after idle release and recovers from a failed load", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
    import assert from "node:assert/strict";
    import path from "node:path";
    import { mock } from "node:test";
    const { lookupOperationsSourceGeo: lookup } = await import("./server/operationsSourceGeo.ts");
    globalThis.fetch = () => { throw new Error("offline lookup used the network"); };
    mock.timers.enable({ apis: ["setTimeout"] });
    const ready = [];
    const log = console.info;
    console.info = message => { if (message.includes("[OperationsGeo]")) ready.push(message); };
    try {
      process.env.FORWARDX_SOURCE_GEO_DIR = path.resolve(".dev/nonexistent-geo-assets-for-test");
      await assert.rejects(lookup("8.8.8.8"), /ENOENT/);
      process.env.FORWARDX_SOURCE_GEO_DIR = path.resolve("server/assets/ip2region");
      const [one, two] = await Promise.all([lookup("8.8.8.8"), lookup("113.118.113.77")]);
      assert.equal(one.countryCode, "US");
      assert.equal(two.region, "广东");
      assert.equal(ready.length, 1); // Concurrent IPv4 calls share one decompression.
      mock.timers.tick(30_000);
      assert.equal((await lookup("240e:3b7:3272:d8d0:db09:c067:8d59:539e")).region, "广东");
      assert.equal(ready.length, 2);
      mock.timers.tick(30_001); // IPv4 expired, IPv6 still retained.
      assert.equal((await lookup("8.8.8.8")).countryCode, "US");
      assert.equal(ready.length, 3);
      assert.equal((await lookup("2001:4860:4860::8888")).countryCode, "US");
      assert.equal(ready.length, 3);
      mock.timers.tick(60_001); // Both idle families expire.
      assert.equal((await lookup("8.8.8.8")).countryCode, "US");
      assert.equal((await lookup("2001:4860:4860::8888")).countryCode, "US");
      assert.equal(ready.length, 5);
    } finally { console.info = log; mock.timers.reset(); }
  `], { encoding: "utf8", timeout: 30_000, env: { ...process.env, JWT_SECRET: "geo-lifecycle-test-only-secret" } });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
});
