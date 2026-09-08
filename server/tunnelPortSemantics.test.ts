import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitListenPortRequest } from "./routers/tunnels";

test("listen port explicit hint distinguishes re-entered value from form replay", () => {
  assert.equal(isExplicitListenPortRequest(true, 22600, 22600, true), true);
  assert.equal(isExplicitListenPortRequest(true, 22600, 22600, false), false);
  assert.equal(isExplicitListenPortRequest(true, 22600, 22600), false);
  assert.equal(isExplicitListenPortRequest(true, 22601, 22600), true);
  assert.equal(isExplicitListenPortRequest(false, 22600, 22600, true), false);
});
