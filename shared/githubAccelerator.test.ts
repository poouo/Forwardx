import assert from "node:assert/strict";
import test from "node:test";

import {
  applyGithubAccelerator,
  buildPanelInstallerCommand,
  githubDownloadCandidates,
  normalizeGithubAcceleratorUrl,
  panelUpdateGithubAccelerator,
} from "./githubAccelerator";

const accelerator = { enabled: true, url: "https://mirror.example.com/" };

test("prefixes GitHub URLs and keeps a direct fallback candidate", () => {
  const raw = "https://github.com/poouo/Forwardx/releases/download/v1.2.3/panel.tar.gz";
  assert.equal(
    applyGithubAccelerator(raw, accelerator),
    `https://mirror.example.com/${raw}`,
  );
  assert.deepEqual(githubDownloadCandidates(raw, accelerator), [
    `https://mirror.example.com/${raw}`,
    raw,
  ]);
});

test("does not prefix unrelated or already accelerated URLs", () => {
  assert.equal(applyGithubAccelerator("https://example.com/file", accelerator), "https://example.com/file");
  assert.equal(
    applyGithubAccelerator("https://mirror.example.com/https://github.com/org/repo", accelerator),
    "https://mirror.example.com/https://github.com/org/repo",
  );
});

test("normalizes base paths but rejects query strings and fragments", () => {
  assert.equal(normalizeGithubAcceleratorUrl(" https://mirror.example.com/proxy/// "), "https://mirror.example.com/proxy");
  assert.equal(normalizeGithubAcceleratorUrl("https://mirror.example.com/proxy?token=1"), "");
  assert.equal(normalizeGithubAcceleratorUrl("https://mirror.example.com/#proxy"), "");
});

test("panel updates require both the main accelerator and panel switch", () => {
  assert.deepEqual(panelUpdateGithubAccelerator({ enabled: true, panelUpdateEnabled: false, url: accelerator.url }), {
    enabled: false,
    url: "https://mirror.example.com",
  });
  assert.deepEqual(panelUpdateGithubAccelerator({ enabled: true, panelUpdateEnabled: true, url: accelerator.url }), {
    enabled: true,
    url: "https://mirror.example.com",
  });
});

test("builds an accelerated installer command with a persistent script argument", () => {
  assert.equal(
    buildPanelInstallerCommand({ deployment: "docker", action: "upgrade", accelerator }),
    "curl -fsSL 'https://mirror.example.com/https://raw.githubusercontent.com/poouo/Forwardx/main/scripts/install-panel-docker.sh' | sudo bash -s -- upgrade --github-accelerator 'https://mirror.example.com'",
  );
});
