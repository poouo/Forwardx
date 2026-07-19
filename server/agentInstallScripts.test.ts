import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { generateInstallScript } from "./agentInstallScripts";

test("panel GitHub accelerator settings reach the Mimic installer", () => {
  const script = generateInstallScript("https://panel.example.com", {
    githubAcceleratorEnabled: true,
    githubAcceleratorUrl: "https://proxy.example.com/",
  });

  assert.match(script, /GITHUB_ACCELERATOR_DEFAULT_ENABLED="true"/);
  assert.match(script, /GITHUB_ACCELERATOR_DEFAULT_URL='https:\/\/proxy\.example\.com'/);
  assert.match(
    script,
    /GITHUB_ACCELERATOR_ENABLED="\$GITHUB_ACCELERATOR_ENABLED" GITHUB_ACCELERATOR_URL="\$GITHUB_ACCELERATOR_URL" FORWARDX_MIMIC_VERSION=/,
  );
});

test("GitHub entry script preserves panel defaults unless explicitly overridden", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-agent.sh"), "utf8");

  assert.match(script, /GITHUB_ACCELERATOR_URL="\$\{GITHUB_ACCELERATOR_URL:-\}"/);
  assert.match(script, /GITHUB_ACCELERATOR_ENABLED="\$\{GITHUB_ACCELERATOR_ENABLED:-\}"/);
  assert.doesNotMatch(script, /GITHUB_ACCELERATOR_ENABLED="\$\{GITHUB_ACCELERATOR_ENABLED:-false\}"/);
});

test("Mimic installer applies the configured accelerator to wrapper and upstream downloads", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  assert.match(script, /url="\$\{GITHUB_ACCELERATOR_URL\}\/\$\{raw_url\}"/);
  assert.match(script, /WMF_GITHUB_MIRRORS="\$github_mirrors" MIMIC_UPSTREAM_TAG=/);
  assert.match(script, /printf '%s\/,%s\\n' "\$GITHUB_ACCELERATOR_URL" "\$mirrors"/);
});
