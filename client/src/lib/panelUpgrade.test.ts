import assert from "node:assert/strict";
import test from "node:test";

import { getPanelChangelogUrl } from "./panelUpgrade";

const enabledAccelerator = {
  enabled: true,
  panelUpdateEnabled: true,
  url: "https://mirror.example.com",
};

test("builds a direct changelog URL unless panel update acceleration is fully enabled", () => {
  const directUrl = "https://github.com/poouo/Forwardx/releases/tag/v2.3.275";

  assert.equal(getPanelChangelogUrl("2.3.275"), directUrl);
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, panelUpdateEnabled: false }),
    directUrl,
  );
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, enabled: false }),
    directUrl,
  );
  assert.equal(
    getPanelChangelogUrl("2.3.275", null, { ...enabledAccelerator, url: "not-a-url" }),
    directUrl,
  );
});

test("accelerates generated and supplied GitHub release URLs", () => {
  const releaseUrl = "https://github.com/poouo/Forwardx/releases/tag/v2.3.275";
  const acceleratedUrl = `https://mirror.example.com/${releaseUrl}`;

  assert.equal(getPanelChangelogUrl("2.3.275", null, enabledAccelerator), acceleratedUrl);
  assert.equal(getPanelChangelogUrl(null, releaseUrl, enabledAccelerator), acceleratedUrl);
});
