import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { generateInstallScript } from "./agentInstallScripts";
import { hardenManagedServiceUnit } from "./agentActionCommands";

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

test("Agent services avoid duplicate logs and disable core dumps", () => {
  const script = generateInstallScript("https://panel.example.com");

  assert.match(script, /LimitCORE=0/);
  assert.match(script, /StandardOutput=null/);
  assert.match(script, /LogRateLimitBurst=200/);
  assert.match(script, /output_log="\/dev\/null"/);
  assert.match(script, /error_log="\/var\/log\/forwardx-agent\/\$SERVICE_NAME-stderr\.log"/);
  assert.match(script, /ulimit -c 0 2>\/dev\/null \|\| true; exec \$GO_AGENT_BIN/);
  assert.doesNotMatch(script, /output_log="\/var\/log\/forwardx-agent\/\$SERVICE_NAME\.log"/);
});

test("Managed systemd units receive bounded logging defaults idempotently", () => {
  const unit = [
    "[Unit]",
    "Description=ForwardX runtime",
    "",
    "[Service]",
    "Type=simple",
    "ExecStart=/usr/local/bin/forwardx-runtime -C /etc/forwardx/runtime/gost.json",
    "Restart=always",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");

  const hardened = hardenManagedServiceUnit(unit);
  assert.match(hardened, /LimitCORE=0/);
  assert.match(hardened, /LogRateLimitIntervalSec=30s/);
  assert.match(hardened, /LogRateLimitBurst=200/);
  assert.equal(hardenManagedServiceUnit(hardened), hardened);
});

test("Mimic installer provisions the NIC offload management dependency", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "scripts/install-mimic.sh"), "utf8");

  assert.match(script, /ensure_ethtool\(\)/);
  assert.match(script, /apt-get install -y ethtool/);
  assert.match(script, /ensure_ethtool \|\| log/);
});
