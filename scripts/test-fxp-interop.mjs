import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const root = path.resolve(import.meta.dirname, "..");
const rustBinary = process.env.FXP_RUST_BIN || path.join(root, "forwardx-fxp-rust", "target", "debug", isWindows ? "forwardx-fxp.exe" : "forwardx-fxp");
const goBinary = process.env.FXP_GO_BIN || path.join(root, ".tmp", isWindows ? "forwardx-fxp-go.exe" : "forwardx-fxp-go");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "forwardx-fxp-interop-"));
const children = [];

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startEchoServers() {
  const tcp = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen(0, "127.0.0.1", resolve);
  });
  const port = tcp.address().port;
  const udp = dgram.createSocket("udp4");
  udp.on("message", (message, remote) => udp.send(message, remote.port, remote.address));
  await new Promise((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(port, "127.0.0.1", resolve);
  });
  return { port, close: async () => {
    await new Promise((resolve) => tcp.close(resolve));
    await new Promise((resolve) => udp.close(resolve));
  } };
}

async function startRuntime(binary, name, config) {
  const configPath = path.join(temporary, `${name}.json`);
  await fs.writeFile(configPath, JSON.stringify(config));
  const child = spawn(binary, ["-config", configPath], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk) => { output = (output + chunk.toString()).slice(-16_384); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  children.push(child);
  child.resultOutput = () => output;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 250);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${name} exited with ${code}\n${output}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return child;
}

async function tcpRoundTrip(port, payload, host = "127.0.0.1") {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = [];
    const timer = setTimeout(() => socket.destroy(new Error("TCP round trip timeout")), 8_000);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length >= payload.length) {
        clearTimeout(timer);
        socket.end();
        resolve(Buffer.concat(chunks));
      }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function udpRoundTrip(port, payload, host = "127.0.0.1") {
  const socket = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("UDP round trip timeout")), 8_000);
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      socket.once("message", (message) => { clearTimeout(timer); resolve(message); });
      socket.send(payload, port, host);
    });
  } finally {
    socket.close();
  }
}

async function udpBurstRoundTrip(port, label, count = 64) {
  const socket = dgram.createSocket("udp4");
  const expected = new Set(Array.from({ length: count }, (_, index) => `${label}-${index}`));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`UDP burst timeout; missing=${expected.size}`)), 8_000);
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
      socket.on("message", (message) => {
        expected.delete(message.toString());
        if (expected.size === 0) {
          clearTimeout(timer);
          resolve();
        }
      });
      for (let index = 0; index < count; index += 1) {
        socket.send(Buffer.from(`${label}-${index}`), port, "127.0.0.1");
      }
    });
  } finally {
    socket.close();
  }
}

async function stopRuntime(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function runDirectCase(label, entryBinary, exitBinary, echoPort, useIpv6 = false) {
  const tunnelId = 8_000 + children.length;
  const ruleId = tunnelId + 1;
  const exitPort = await reservePort();
  const entryPort = await reservePort();
  const key = `${label}-key`;
  const exit = await startRuntime(exitBinary, `${label}-exit`, {
    role: "exit", tunnelId, ruleId: 0, listenPort: exitPort, listenHost: useIpv6 ? "" : "127.0.0.1", protocol: "both", key,
    udpTargets: [{ ruleId, targetIp: "127.0.0.1", targetPort: echoPort }],
  });
  const entry = await startRuntime(entryBinary, `${label}-entry`, {
    role: "entry", tunnelId, ruleId, listenPort: entryPort, listenHost: useIpv6 ? "" : "127.0.0.1", protocol: "both", key,
    exitHost: useIpv6 ? "::1" : "127.0.0.1", exitPort, targetIp: "127.0.0.1", targetPort: echoPort,
  });
  try {
    const tcpPayload = Buffer.from(`${label}-tcp-${"x".repeat(4096)}`);
    const clientHost = useIpv6 ? "::1" : "127.0.0.1";
    assert.deepEqual(await tcpRoundTrip(entryPort, tcpPayload, clientHost), tcpPayload);
    const smallUdpPayload = Buffer.from(`${label}-udp`);
    assert.deepEqual(await udpRoundTrip(entryPort, smallUdpPayload, clientHost), smallUdpPayload);
    const udpPayload = Buffer.alloc(32 * 1024 + 137);
    for (let index = 0; index < udpPayload.length; index += 1) udpPayload[index] = index % 251;
    assert.deepEqual(await udpRoundTrip(entryPort, udpPayload, clientHost), udpPayload);
    if (label.includes("rust")) {
      const tcpClients = Array.from({ length: 12 }, (_, index) => {
        const payload = Buffer.from(`${label}-parallel-tcp-${index}-${"p".repeat(1024)}`);
        return tcpRoundTrip(entryPort, payload).then((response) => assert.deepEqual(response, payload));
      });
      const udpClients = Array.from({ length: 24 }, (_, index) => {
        const payload = Buffer.from(`${label}-parallel-udp-${index}`);
        return udpRoundTrip(entryPort, payload).then((response) => assert.deepEqual(response, payload));
      });
      await Promise.all([...tcpClients, ...udpClients]);
      if (label === "rust-entry-rust-exit") {
        await udpBurstRoundTrip(entryPort, `${label}-burst`);
      }
    }
  } catch (error) {
    const sockets = isWindows
      ? spawnSync("netstat", ["-ano", "-p", "udp"], { encoding: "utf8" }).stdout.split(/\r?\n/).filter((line) => line.includes(`:${entryPort}`) || line.includes(`:${exitPort}`)).join("\n")
      : "";
    error.message += `\nENTRY:\n${entry.resultOutput()}\nEXIT:\n${exit.resultOutput()}\nSOCKETS:\n${sockets}`;
    throw error;
  } finally {
    await stopRuntime(entry);
    await stopRuntime(exit);
  }
}

async function runRelayCase(echoPort) {
  const tunnelId = 9_001;
  const ruleId = 9_002;
  const exitPort = await reservePort();
  const relayPort = await reservePort();
  const entryPort = await reservePort();
  const upstreamKey = "rust-relay-upstream";
  const downstreamKey = "rust-relay-downstream";
  const exit = await startRuntime(goBinary, "rust-relay-exit", {
    role: "exit", tunnelId, ruleId: 0, listenPort: exitPort, listenHost: "127.0.0.1", protocol: "both", key: downstreamKey,
    udpTargets: [{ ruleId, targetIp: "127.0.0.1", targetPort: echoPort }],
  });
  const relay = await startRuntime(rustBinary, "rust-relay", {
    role: "relay", tunnelId, ruleId: 0, listenPort: relayPort, listenHost: "127.0.0.1", protocol: "both", key: upstreamKey,
    relayExitHost: "127.0.0.1", relayExitPort: exitPort, relayKey: downstreamKey,
  });
  const entry = await startRuntime(goBinary, "rust-relay-entry", {
    role: "entry", tunnelId, ruleId, listenPort: entryPort, listenHost: "127.0.0.1", protocol: "both", key: upstreamKey,
    exitHost: "127.0.0.1", exitPort: relayPort, targetIp: "127.0.0.1", targetPort: echoPort,
  });
  try {
    const tcpPayload = Buffer.from(`rust-relay-tcp-${"y".repeat(4096)}`);
    assert.deepEqual(await tcpRoundTrip(entryPort, tcpPayload), tcpPayload);
    const udpPayload = Buffer.alloc(24 * 1024 + 91, 0x5a);
    assert.deepEqual(await udpRoundTrip(entryPort, udpPayload), udpPayload);
  } catch (error) {
    error.message += `\nENTRY:\n${entry.resultOutput()}\nRELAY:\n${relay.resultOutput()}\nEXIT:\n${exit.resultOutput()}`;
    throw error;
  } finally {
    await stopRuntime(entry);
    await stopRuntime(relay);
    await stopRuntime(exit);
  }
}

try {
  await Promise.all([fs.access(rustBinary), fs.access(goBinary)]);
  const echo = await startEchoServers();
  try {
    await runDirectCase("go-entry-go-exit", goBinary, goBinary, echo.port);
    await runDirectCase("rust-entry-go-exit", rustBinary, goBinary, echo.port);
    await runDirectCase("go-entry-rust-exit", goBinary, rustBinary, echo.port);
    await runDirectCase("rust-entry-rust-exit", rustBinary, rustBinary, echo.port);
    await runDirectCase("rust-ipv6-entry-exit", rustBinary, rustBinary, echo.port, true);
    await runRelayCase(echo.port);
  } finally {
    await echo.close();
  }
  console.log("FXP Rust/Go TCP, UDP, fragmentation, and relay interoperability passed");
} finally {
  await Promise.allSettled(children.map(stopRuntime));
  await fs.rm(temporary, { recursive: true, force: true });
}
