import assert from "node:assert/strict";
import test from "node:test";
import { buildForwardXMimicConfig } from "./mimicConfig";

test("uses stable performance-oriented Mimic defaults for V1 and V2", () => {
  const config = buildForwardXMimicConfig([
    "remote=198.51.100.2:32002",
    "local=0.0.0.0:32001",
    "remote=198.51.100.2:32002",
  ]);

  assert.match(config, /^# Managed by ForwardX/m);
  assert.match(config, /^use_libxdp = false$/m);
  assert.match(config, /^keepalive = 300:10:3:600$/m);
  assert.match(config, /^max_window = false$/m);
  assert.doesNotMatch(config, /^link_type =/m);
  assert.doesNotMatch(config, /^xdp_mode =/m);
  assert.deepEqual(config.split("\n").filter((line) => line.startsWith("filter = ")), [
    "filter = local=0.0.0.0:32001",
    "filter = remote=198.51.100.2:32002",
  ]);
});
