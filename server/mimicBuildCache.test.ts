import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import express from "express";
import {
  mimicTokenId,
  parseMimicArtifactDescriptor,
  registerMimicBuildCacheRoutes,
  signMimicArtifactRequest,
  validateMimicArtifact,
  verifyMimicArtifactRequest,
  type MimicArtifactDescriptor,
} from "./mimicBuildCache";

const run = promisify(execFile);
const TOKEN = "agent-token-for-mimic-cache-tests";
const KERNEL_BUILD = "a".repeat(64);

function kmodHeaders(overrides: Record<string, string> = {}) {
  return {
    "x-mimic-kind": "kmod",
    "x-mimic-version": "0.7.1",
    "x-mimic-arch": "x86_64",
    "x-mimic-hack": "kfunc",
    "x-mimic-kernel-release": "6.12.9+bpo-cloud-amd64",
    "x-mimic-kernel-build": KERNEL_BUILD,
    "x-mimic-libc": "",
    ...overrides,
  };
}

function fakeModule(kernelRelease: string) {
  return Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(128, 1),
    Buffer.from(`\0vermagic=${kernelRelease} SMP preempt mod_unload modversions \0name=mimic\0license=GPL\0`),
  ]);
}

async function withCacheServer<T>(work: (baseUrl: string, cacheDir: string) => Promise<T>) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-mimic-cache-test-"));
  const previous = process.env.FORWARDX_MIMIC_CACHE_DIR;
  process.env.FORWARDX_MIMIC_CACHE_DIR = cacheDir;
  const app = express();
  const router = express.Router();
  registerMimicBuildCacheRoutes(router, { loadTokens: async () => [TOKEN], log: () => undefined });
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    return await work(`http://127.0.0.1:${address.port}`, cacheDir);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.FORWARDX_MIMIC_CACHE_DIR;
    else process.env.FORWARDX_MIMIC_CACHE_DIR = previous;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

test("artifact descriptions are strictly validated", () => {
  assert.ok(parseMimicArtifactDescriptor(kmodHeaders()));
  assert.equal(parseMimicArtifactDescriptor(kmodHeaders({ "x-mimic-kernel-release": "../../etc/passwd" })), null);
  assert.equal(parseMimicArtifactDescriptor(kmodHeaders({ "x-mimic-kernel-build": "short" })), null);
  assert.equal(parseMimicArtifactDescriptor(kmodHeaders({ "x-mimic-hack": "other" })), null);
  assert.equal(parseMimicArtifactDescriptor(kmodHeaders({ "x-mimic-version": "0.7.1; rm" })), null);
  assert.ok(parseMimicArtifactDescriptor({
    "x-mimic-kind": "cli", "x-mimic-version": "0.7.1", "x-mimic-arch": "aarch64", "x-mimic-hack": "kprobe", "x-mimic-libc": "musl",
  }));
  assert.equal(parseMimicArtifactDescriptor({
    "x-mimic-kind": "cli", "x-mimic-version": "0.7.1", "x-mimic-arch": "aarch64", "x-mimic-hack": "kprobe", "x-mimic-libc": "uclibc",
  }), null);
});

test("requests are bound to the token, method, artifact and body", () => {
  const descriptor = parseMimicArtifactDescriptor(kmodHeaders()) as MimicArtifactDescriptor;
  const signature = signMimicArtifactRequest(TOKEN, "PUT", descriptor, "b".repeat(64));
  const base = { tokens: [TOKEN], tokenId: mimicTokenId(TOKEN), signature, method: "PUT", descriptor, bodySha256: "b".repeat(64) };
  assert.equal(verifyMimicArtifactRequest(base), true);
  assert.equal(verifyMimicArtifactRequest({ ...base, method: "GET" }), false);
  assert.equal(verifyMimicArtifactRequest({ ...base, bodySha256: "c".repeat(64) }), false);
  assert.equal(verifyMimicArtifactRequest({ ...base, descriptor: { ...descriptor, kernelRelease: "6.12.10-amd64" } }), false);
  assert.equal(verifyMimicArtifactRequest({ ...base, tokens: ["another-token"] }), false);
  assert.equal(verifyMimicArtifactRequest({ ...base, signature: "not-hex" }), false);
});

test("only a mimic module built for the declared kernel is accepted", () => {
  const descriptor = parseMimicArtifactDescriptor(kmodHeaders()) as MimicArtifactDescriptor;
  assert.equal(validateMimicArtifact(descriptor, fakeModule(descriptor.kernelRelease)), "");
  assert.equal(validateMimicArtifact(descriptor, fakeModule("6.1.0-18-amd64")), "vermagic");
  assert.equal(validateMimicArtifact(descriptor, Buffer.alloc(256, 7)), "not-elf");
  const renamed = Buffer.from(fakeModule(descriptor.kernelRelease).toString("latin1").replace("name=mimic", "name=other"), "latin1");
  assert.equal(validateMimicArtifact(descriptor, renamed), "module-name");
});

test("the cache rejects unsigned and tampered requests over HTTP", async () => {
  await withCacheServer(async (baseUrl) => {
    const descriptor = parseMimicArtifactDescriptor(kmodHeaders()) as MimicArtifactDescriptor;
    const body = fakeModule(descriptor.kernelRelease);
    const sha = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
    const signed = (method: string, bodySha = "") => ({
      ...kmodHeaders(),
      "x-forwardx-token-id": mimicTokenId(TOKEN),
      "x-forwardx-signature": signMimicArtifactRequest(TOKEN, method, descriptor, bodySha),
    });
    const url = `${baseUrl}/api/agent/mimic-cache`;
    assert.equal((await fetch(url, { headers: kmodHeaders() })).status, 401);
    assert.equal((await fetch(url, { headers: signed("GET") })).status, 404);
    // A GET signature cannot be replayed as an upload.
    assert.equal((await fetch(url, { method: "PUT", body, headers: { ...signed("GET"), "x-mimic-sha256": sha, "content-type": "application/octet-stream" } })).status, 401);
    // A module for another kernel is refused even with a valid signature.
    const wrong = fakeModule("6.1.0-18-amd64");
    const wrongSha = (await import("node:crypto")).createHash("sha256").update(wrong).digest("hex");
    assert.equal((await fetch(url, { method: "PUT", body: wrong, headers: { ...signed("PUT", wrongSha), "x-mimic-sha256": wrongSha, "content-type": "application/octet-stream" } })).status, 422);
    assert.equal((await fetch(url, { method: "PUT", body, headers: { ...signed("PUT", sha), "x-mimic-sha256": sha, "content-type": "application/octet-stream" } })).status, 200);
    const hit = await fetch(url, { headers: signed("GET") });
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get("x-mimic-sha256"), sha);
    assert.deepEqual(Buffer.from(await hit.arrayBuffer()), body);
  });
});

test("the installer script uploads and downloads through the panel cache", { skip: process.platform === "win32" }, async () => {
  await withCacheServer(async (baseUrl) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-mimic-script-test-"));
    try {
      const script = path.join(process.cwd(), "scripts/install-mimic.sh");
      const bash = (body: string, token = TOKEN) => run("bash", ["-c", `
        set -Eeuo pipefail
        FORWARDX_MIMIC_SOURCE_ONLY=1 . "${script}"
        ${body}
      `], { env: { ...process.env, FORWARDX_PANEL_URL: `${baseUrl}/`, FORWARDX_AGENT_TOKEN: token, WORK: work } });

      // First host: nothing cached yet, so it builds and shares the result.
      await assert.rejects(bash(`mimic_cache_download kmod kfunc "$WORK/miss.ko"`));
      await bash(`
        printf '\\177ELF' > "$WORK/built.ko"
        head -c 512 /dev/zero | tr '\\0' 'x' >> "$WORK/built.ko"
        printf '\\0vermagic=%s SMP mod_unload \\0name=mimic\\0' "$(uname -r)" >> "$WORK/built.ko"
        mimic_cache_upload kmod kfunc "$WORK/built.ko"
        printf '\\177ELF' > "$WORK/built-cli"
        head -c 256 /dev/zero | tr '\\0' 'y' >> "$WORK/built-cli"
        mimic_cache_upload cli kprobe "$WORK/built-cli"
      `);
      // Second host with the same kernel: downloads instead of compiling.
      await bash(`
        mimic_cache_download kmod kfunc "$WORK/got.ko"
        cmp "$WORK/built.ko" "$WORK/got.ko"
        mimic_cache_download cli kprobe "$WORK/got-cli"
        cmp "$WORK/built-cli" "$WORK/got-cli"
      `);
      // The whole fast path, with the kernel-facing commands stubbed out.
      const fastPath = await bash(`
        modprobe() { return 0; }
        depmod() { return 0; }
        mimic_has_packaged_install() { return 1; }
        mimic_cached_kmod_dir() { printf '%s\n' "$WORK/modules"; }
        obtain_prebuilt_mimic_cli() { printf '%s' "$1" > "$WORK/cli-variant"; }
        _install_mimic_service_from_src() { return 0; }
        install_mimic_from_panel_cache debian
        cmp "$WORK/built.ko" "$WORK/modules/mimic.ko"
        echo "from-cache=$MIMIC_INSTALLED_FROM_CACHE variant=$(cat "$WORK/cli-variant")"
      `);
      assert.match(fastPath.stdout, /from-cache=1 variant=kfunc/);
      // A cached module that does not load is removed again and reported as a miss.
      await assert.rejects(bash(`
        modprobe() { [ "\${1:-}" = "-r" ]; }
        depmod() { return 0; }
        mimic_has_packaged_install() { return 1; }
        mimic_cached_kmod_dir() { printf '%s\n' "$WORK/rejected"; }
        install_mimic_from_panel_cache debian
      `));
      assert.equal(fs.existsSync(path.join(work, "rejected", "mimic.ko")), false);
      // A locally built module is shared, even when the distro compresses it.
      await bash(`
        printf '\\177ELF' > "$WORK/dkms.ko"
        head -c 300 /dev/zero | tr '\\0' 'z' >> "$WORK/dkms.ko"
        printf '\\0vermagic=%s SMP \\0name=mimic\\0' "$(uname -r)" >> "$WORK/dkms.ko"
        gzip -k "$WORK/dkms.ko"
        modinfo() { printf '%s\n' "$WORK/dkms.ko.gz"; }
        MIMIC_BUILT_VARIANT=kprobe
        upload_mimic_build_artifacts
        mimic_cache_download kmod kprobe "$WORK/shared.ko"
        cmp "$WORK/dkms.ko" "$WORK/shared.ko"
      `);
      // A foreign token gets nothing.
      await assert.rejects(bash(`mimic_cache_download kmod kfunc "$WORK/stolen.ko"`, "not-a-panel-token"));
      assert.equal(fs.existsSync(path.join(work, "stolen.ko")), false);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
