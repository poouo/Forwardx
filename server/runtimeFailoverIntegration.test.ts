import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

// Optional native-binary check, in addition to Go tests run during every build:
// FORWARDX_RUNTIME_TEST_BINARY=/path/to/forwardx-runtime node --import tsx --test server/runtimeFailoverIntegration.test.ts
// Set FORWARDX_RUNTIME_EXPECT_LEGACY=1 to reproduce against the old .1 binary.
test("runtime does not send periodic business connections to an offline primary", {
  skip: !process.env.FORWARDX_RUNTIME_TEST_BINARY,
  timeout: 30_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forwardx-failover-"));
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const listen = async (server: net.Server) => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    return (server.address() as net.AddressInfo).port;
  };
  const freePort = async () => {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise<void>(resolve => server.close(() => resolve()));
    return port;
  };
  let failedPrimaryConnections = 0;
  // Accept TCP but never finish TLS: reproduce a real dial/handshake timeout,
  // rather than a refused port. Short deadlines keep this regression test fast.
  const blackhole = net.createServer(socket => { failedPrimaryConnections++; track(socket).resume(); });
  const echo = net.createServer(socket => { track(socket).pipe(socket); });
  let runtime: ReturnType<typeof spawn> | undefined;
  let logs = "";
  try {
    const blackholePort = await listen(blackhole), echoPort = await listen(echo);
    const entryPort = await freePort(), relayPort = await freePort();
    const addr = (port: number) => `127.0.0.1:${port}`;
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({
      log: { level: "error" },
      services: [
        { name: "relay", addr: addr(relayPort), handler: { type: "relay" }, listener: { type: "tcp" } },
        {
          name: "entry", addr: addr(entryPort), listener: { type: "tcp" },
          handler: { type: "tcp", chain: "upstreams", retries: 1 },
          metadata: { dialTimeout: "100ms" },
          forwarder: { nodes: [{ name: "echo", addr: addr(echoPort), connector: { type: "tcp" }, dialer: { type: "tcp" } }] },
        },
      ],
      chains: [{ name: "upstreams", hops: [{
        name: "targets", selector: { strategy: "fifo", maxFails: 1, failTimeout: "5s" },
        nodes: [
          { name: "offline", addr: addr(blackholePort), connector: { type: "relay" }, dialer: { type: "tls", tls: { secure: false } } },
          { name: "healthy", addr: addr(relayPort), connector: { type: "relay" }, dialer: { type: "tcp" } },
        ],
      }] }],
    }));
    runtime = spawn(path.resolve(process.env.FORWARDX_RUNTIME_TEST_BINARY!), ["-C", path.join(directory, "config.json")], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let processError: Error | undefined;
    runtime.on("error", error => { processError = error; });
    const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-65536); };
    runtime.stdout!.on("data", capture);
    runtime.stderr!.on("data", capture);

    const connect = () => new Promise<net.Socket>((resolve, reject) => {
      const socket = track(net.connect(entryPort, "127.0.0.1"));
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("echo deadline")); });
      socket.once("error", reject);
      socket.once("connect", () => resolve(socket));
    });
    const exchange = (socket: net.Socket) => new Promise<void>((resolve, reject) => {
      if (socket.destroyed) { reject(new Error("echo socket already closed")); return; }
      const timer = setTimeout(() => failed(new Error("echo reply deadline")), 3000);
      const closed = () => failed(new Error("echo socket closed before reply"));
      const cleanup = () => { clearTimeout(timer); socket.off("data", received); socket.off("error", failed); socket.off("close", closed); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const received = (data: Buffer) => {
        cleanup();
        try { assert.equal(data.toString(), "ping"); resolve(); } catch (error) { reject(error); }
      };
      socket.once("error", failed);
      socket.once("close", closed);
      socket.once("data", received);
      socket.write("ping");
    });

    let held: net.Socket | undefined;
    const startupDeadline = Date.now() + 5000;
    while (!held) {
      if (processError) throw processError;
      assert.equal(runtime.exitCode, null, logs);
      try { held = await connect(); } catch (error) {
        if (Date.now() >= startupDeadline) throw error;
        await delay(30);
      }
    }
    await exchange(held);
    held.setTimeout(0); // Keep it idle while the other 100 connections run.
    for (let i = 0; i < 100; i++) {
      const socket = await connect();
      try { await exchange(socket); } finally { socket.destroy(); }
      await delay(60); // Run across the actual 5s exclusion window, without latency assertions.
    }
    await exchange(held); // Existing connection must survive the whole run.
    held.destroy();
    t.diagnostic(`101 new connections succeeded; offline primary attempts=${failedPrimaryConnections}`);
    if (process.env.FORWARDX_RUNTIME_EXPECT_LEGACY === "1") {
      assert.ok(failedPrimaryConnections > 1, "baseline did not reproduce the original bug");
    } else {
      assert.equal(failedPrimaryConnections, 1, "failed primary re-entered business traffic without recovery");
    }
  } catch (error) {
    throw new Error(`${String(error)}\nRuntime log:\n${logs}`, { cause: error });
  } finally {
    if (runtime?.pid && runtime.exitCode === null) {
      const exited = new Promise<void>(resolve => runtime!.once("exit", () => resolve()));
      runtime.kill();
      await exited;
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all([blackhole, echo].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
