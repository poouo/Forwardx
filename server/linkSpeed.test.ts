import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_VERSION } from "../shared/versions";

test("speed paths preserve multi-hop transports and the job coordinates/cleans every Agent", async () => {
  process.env.DATABASE_TYPE = "sqlite";
  const { connectDatabase, closeDatabase, executeRaw, queryRaw } = await import(
    "./dbRuntime"
  );
  const { ensureDatabaseSchema } = await import("./dbSchema");
  const { buildLinkSpeedPlan, speedEndpoint } = await import("./linkSpeedPlan");
  const { releaseHostPortReservations } = await import("./portReservations");
  const {
    createLinkSpeedJob,
    takeLinkSpeedTasks,
    reportLinkSpeedTask,
    getLinkSpeedJob,
    cancelLinkSpeedJob,
    claimLinkSpeedTask,
    latestLinkSpeedJob,
    recordLinkSpeedCapability,
  } = await import("./linkSpeedTasks");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "forwardx-link-speed-"),
  );
  const insert = async (table: string, values: Record<string, any>) =>
    executeRaw(
      `INSERT INTO "${table}" (${Object.keys(values)
        .map((key) => `"${key}"`)
        .join(",")}) VALUES (${Object.keys(values)
        .map(() => "?")
        .join(",")})`,
      Object.values(values),
    );
  try {
    await connectDatabase({
      type: "sqlite",
      sqlite: { path: path.join(directory, "test.db") },
    });
    await ensureDatabaseSchema();
    for (let id = 1; id <= 4; id++)
      await insert("hosts", {
        id,
        name: `host-${id}`,
        ip: `198.51.100.${id}`,
        ipv4: `198.51.100.${id}`,
        agentToken: `speed-test-${id}`,
        agentVersion: id === 1 ? "2.2.212" : null,
        osInfo: id === 1 ? "Debian 12" : null,
        userId: 1,
        isOnline: 1,
        lastHeartbeat: Math.floor(Date.now() / 1000),
      });
    await insert("tunnels", {
      id: 10,
      name: "three-hop",
      entryHostId: 1,
      exitHostId: 3,
      mode: "tls",
      listenPort: 15000,
      userId: 1,
      isEnabled: 1,
    });
    for (let i = 0; i < 3; i++)
      await insert("tunnel_hops", {
        tunnelId: 10,
        hostId: i + 1,
        seq: i,
        listenPort: 15000 + i,
      });
    const tunnel = {
      id: 10,
      name: "three-hop",
      entryHostId: 1,
      exitHostId: 3,
      mode: "tls",
      listenPort: 15000,
      userId: 1,
      isEnabled: true,
    };
    const token = "ab".repeat(32);
    const plan = await buildLinkSpeedPlan(tunnel, "tunnel", "tcp", token);
    assert.deepEqual(
      plan.route.map((node) => node.hostId),
      [1, 2, 3],
    );
    assert.equal(plan.route[0].agentVersion, "2.2.212");
    assert.equal(plan.route[0].osInfo, "Debian 12");
    const entry = plan.hosts.get(1)!.find((c) => c.kind === "gost")!;
    assert.equal(entry.listenHost, "127.0.0.1");
    assert.equal(entry.config.chains[0].hops.length, 2);
    for (const hop of entry.config.chains[0].hops)
      assert.equal(hop.nodes[0].dialer.type, "tls");
    assert.equal(
      plan.hosts.get(3)!.find((c) => c.kind === "receiver")!.listenHost,
      "127.0.0.1",
    );
    assert.equal(
      (
        (await queryRaw(
          'SELECT count(*) AS count FROM "forward_rules"',
        )) as any[]
      )[0].count,
      0,
      "must not create business rules",
    );
    assert.equal(speedEndpoint("2001:db8::1", 1234), "[2001:db8::1]:1234");

    const created = createLinkSpeedJob(
      1,
      {
        resourceType: "tunnel",
        resourceId: 10,
        name: "three-hop",
        protocol: "tcp",
        duration: 30,
        rateMbps: 0,
      },
      plan,
      token,
    );
    assert.equal(created.state, "preparing");
    assert.deepEqual(created.benchmark?.routeHostIds, [1, 2, 3]);
    assert.equal(created.benchmark?.agentVersions["1"], "2.2.212");
    assert.equal(created.benchmark?.panelVersion, APP_VERSION);
    assert.throws(
      () => getLinkSpeedJob(created.id, { id: 2, role: "user" }),
      /无权/,
    );
    assert.equal(latestLinkSpeedJob("tunnel", 10, 2), null);
    assert.equal(latestLinkSpeedJob("tunnel", 10, 1)?.id, created.id);
    for (const id of [1, 2, 3]) {
      const [task] = takeLinkSpeedTasks(id);
      assert.equal(task.op, "prepare");
      assert.equal(claimLinkSpeedTask(99, task.taskId, created.id), false);
      assert.equal(
        reportLinkSpeedTask(99, {
          jobId: created.id,
          taskId: task.taskId,
          state: "ready",
        }),
        false,
      );
      assert.equal(
        reportLinkSpeedTask(id, {
          jobId: created.id,
          taskId: task.taskId,
          state: "ready",
        }),
        true,
      );
    }
    const [run] = takeLinkSpeedTasks(1);
    assert.equal(run.op, "run");
    assert.equal(created.state, "upload");
    assert.equal(
      reportLinkSpeedTask(2, {
        jobId: created.id,
        taskId: run.taskId,
        state: "completed",
      }),
      false,
    );
    reportLinkSpeedTask(1, {
      jobId: created.id,
      taskId: run.taskId,
      sample: { direction: "upload", elapsedMs: 500, bytes: 1000, mbps: 0.016 },
    });
    reportLinkSpeedTask(1, {
      jobId: created.id,
      taskId: run.taskId,
      sample: { direction: "upload", elapsedMs: NaN, bytes: 1000, mbps: 1 },
    });
    assert.equal(created.samples.length, 1);
    const sendSamples = (samples: unknown[]) => reportLinkSpeedTask(1, {
      jobId: created.id, taskId: run.taskId, samples,
    });
    const batch = Array.from({ length: 5 }, (_, i) => ({
      direction: "upload", elapsedMs: 600 + i * 100, bytes: 2000 + i * 1000, mbps: 1,
    }));
    sendSamples(batch);
    sendSamples(batch); // HTTP retries must not replay or duplicate points.
    sendSamples([null, { direction: "upload", elapsedMs: 1100, bytes: 1, mbps: 1 }]);
    assert.equal(created.samples.length, 6);
    for (const direction of ["upload", "download"]) {
      for (let offset = direction === "upload" ? 10 : 0; offset < 300; offset += 50) {
        sendSamples(Array.from({ length: Math.min(50, 300 - offset) }, (_, i) => ({
          direction, elapsedMs: (offset + i + 1) * 100,
          bytes: (offset + i + 1) * 1000, mbps: 1,
        })));
      }
    }
    assert.ok(created.samples.length > 590, "retain 100ms points for both 30s phases");
    const count = created.samples.length;
    sendSamples([{ direction: "upload", elapsedMs: 30100, bytes: 301000, mbps: 1 }]);
    assert.equal(created.samples.length, count);
    assert.equal(created.state, "download", "late upload must not reverse the phase");
    const result = {
      bytes: 125_000_000,
      durationMs: 10000,
      mbps: 999,
      peakMbps: 120,
    };
    reportLinkSpeedTask(1, {
      jobId: created.id,
      taskId: run.taskId,
      upload: result,
      download: result,
      state: "completed",
    });
    assert.equal(created.state, "completed");
    assert.equal(
      created.upload?.mbps,
      100,
      "compute throughput from received bytes and elapsed time",
    );
    for (const id of [1, 2, 3]) {
      const [stop] = takeLinkSpeedTasks(id);
      assert.equal(stop.op, "stop");
      assert.equal(
        reportLinkSpeedTask(id, {
          jobId: created.id,
          taskId: stop.taskId,
          state: "stopped",
        }),
        true,
      );
    }
    assert.equal(
      reportLinkSpeedTask(1, {
        jobId: created.id,
        taskId: run.taskId,
        state: "error",
        error: "late",
      }),
      false,
    );
    assert.equal(created.state, "completed");

    for (const version of ["v1", "v2", "v3"]) {
      const fxp = await buildLinkSpeedPlan(
        {
          ...tunnel,
          mode: "forwardx",
          forwardxVersion: version,
          v3Transport: "ws",
          v3Path: "/speed",
        },
        "tunnel",
        "udp",
        token,
      );
      try {
        assert.deepEqual(
          fxp.route.map((node) => node.hostId),
          [1, 2, 3],
        );
        const entry = fxp.hosts.get(1)![0].config;
        const middle = fxp.hosts.get(2)![0].config;
        const exit = fxp.hosts.get(3)!.find((c) => c.kind === "fxp")!.config;
        assert.equal(entry.transportVersion, version);
        assert.equal(entry.exitPeerId, "2");
        assert.equal(middle.role, "relay");
        assert.equal(middle.relayPeerId, "3");
        assert.equal(exit.udpTargets[0].ruleId, entry.ruleId);
        assert.equal(exit.udpTargets[0].targetIp, "127.0.0.1");
        assert.equal(exit.udpListenPort, exit.listenPort);
        assert.equal(entry.udpExitPort, entry.exitPort);
        assert.equal(middle.udpRelayExitPort, middle.relayExitPort);
        const localProxy = fxp.hosts.get(1)!.find((c) => c.kind === "proxy");
        if (version !== "v2") {
          assert.equal(entry.listenHost, "", "FXP UDP must send remote packets from a routable socket");
          assert.equal(localProxy?.listenHost, "127.0.0.1");
          assert.equal(localProxy?.target, speedEndpoint("127.0.0.1", entry.listenPort));
          assert.equal(fxp.target, speedEndpoint("127.0.0.1", localProxy!.port));
          assert.notEqual(localProxy!.port, entry.listenPort);
        } else assert.equal(localProxy, undefined, "WireGuard already provides a loopback outbound proxy");
        if (version === "v3") assert.equal(entry.v3Path, "/speed");
      } finally {
        releaseHostPortReservations(fxp.reservations);
      }
    }
    const mixed = await buildLinkSpeedPlan(
      {
        id: 30,
        name: "mixed",
        isEnabled: true,
        groupMode: "chain",
        protocol: "both",
        members: [
          {
            id: 1,
            memberType: "tunnel",
            tunnelId: 10,
            isEnabled: true,
            priority: 0,
          },
          {
            id: 2,
            memberType: "host",
            hostId: 4,
            isEnabled: true,
            priority: 1,
          },
        ],
      },
      "chain",
      "udp",
      token,
    );
    assert.deepEqual(
      mixed.route.map((node) => node.hostId),
      [1, 2, 3, 4],
    );
    assert.match(
      mixed.hosts.get(1)!.find((c) => c.kind === "gost")!.config.services[0]
        .forwarder.nodes[0].addr,
      /^198\.51\.100\.4:/,
    );
    const cancelled = createLinkSpeedJob(
      1,
      {
        resourceType: "chain",
        resourceId: 30,
        name: "mixed",
        protocol: "udp",
        duration: 10,
        rateMbps: 100,
      },
      mixed,
      token,
    );
    cancelLinkSpeedJob(cancelled.id, { id: 1, role: "user" });
    for (const hostId of [1, 2, 3, 4]) {
      const tasks = takeLinkSpeedTasks(hostId);
      assert.deepEqual(
        tasks.map((t) => t.op),
        ["stop"],
      );
      reportLinkSpeedTask(hostId, {
        jobId: cancelled.id,
        taskId: tasks[0].taskId,
        state: "stopped",
      });
    }
    assert.equal(cancelled.state, "cancelled");
    await assert.rejects(
      buildLinkSpeedPlan(
        { ...tunnel, isEnabled: false },
        "tunnel",
        "tcp",
        token,
      ),
      /启用/,
    );
    await assert.rejects(
      buildLinkSpeedPlan(
        {
          ...tunnel,
          mode: "forwardx",
          forwardxVersion: "v1",
          udpOverTcp: true,
        },
        "tunnel",
        "udp",
        token,
      ),
      /Mimic/,
    );
    const { linkSpeedRouter } = await import("./routers/linkSpeed");
    const caller = (id: number, role: string) =>
      linkSpeedRouter.createCaller({
        user: { id, role },
        req: { headers: {} },
        res: {},
      } as any);
    await assert.rejects(
      caller(1, "admin").start({ resourceType: "tunnel", resourceId: 10 }),
      /更新.*Agent/,
    );
    for (const hostId of [1, 2, 3]) recordLinkSpeedCapability(hostId, true);
    await assert.rejects(
      caller(2, "user").start({ resourceType: "tunnel", resourceId: 10 }),
      /permission/,
    );
    const defaults = await caller(1, "admin").start({
      resourceType: "tunnel",
      resourceId: 10,
    });
    assert.equal(defaults.protocol, "tcp");
    assert.equal(defaults.duration, 10);
    const stalePrepare = takeLinkSpeedTasks(1)[0];
    await caller(1, "admin").cancel({ id: defaults.id });
    assert.equal(
      claimLinkSpeedTask(1, stalePrepare.taskId, defaults.id),
      false,
    );
    for (const hostId of [1, 2, 3]) {
      const [stop] = takeLinkSpeedTasks(hostId);
      reportLinkSpeedTask(hostId, {
        jobId: defaults.id,
        taskId: stop.taskId,
        state: "stopped",
      });
    }
    await assert.rejects(
      caller(1, "admin").start({
        resourceType: "tunnel",
        resourceId: 10,
        protocol: "udp",
        rateMbps: 1001,
      }),
    );
    // Optional fixtures feed the actual planner output to native runtime tests.
    const fixtures = process.env.FORWARDX_SPEED_FIXTURES_DIR;
    if (fixtures) {
      fs.mkdirSync(fixtures, { recursive: true });
      for (let id = 1; id <= 4; id++)
        await executeRaw(
          'UPDATE "hosts" SET "ip" = ?, "ipv4" = ?, "portRangeStart" = ?, "portRangeEnd" = ? WHERE "id" = ?',
          ["127.0.0.1", "127.0.0.1", 20000 + id * 2000, 21999 + id * 2000, id],
        );
      for (const mode of ["tls", "wss", "mtls", "tcp", "v1", "v3"])
        for (const protocol of ["tcp", "udp"] as const) {
          const fixturePlan = await buildLinkSpeedPlan(
            {
              ...tunnel,
              mode: mode.startsWith("v") ? "forwardx" : mode,
              forwardxVersion: mode,
              v3Transport: "ws",
              v3Path: "/speed",
            },
            "tunnel",
            protocol,
            token,
          );
          fs.writeFileSync(
            path.join(fixtures, `${mode}-${protocol}.json`),
            JSON.stringify({
              task: {
                taskId: "a".repeat(36),
                jobId: "b".repeat(36),
                token,
                protocol,
                duration: 1,
                rateMbps: 5,
                target: fixturePlan.target,
                expiresAt: Date.now() + 150000,
              },
              components: [...fixturePlan.hosts.entries()]
                .sort((a, b) => b[0] - a[0])
                .flatMap(([, components]) => components),
            }),
          );
          releaseHostPortReservations(fixturePlan.reservations);
        }
    }
  } finally {
    await closeDatabase();
    assert.ok(
      path
        .resolve(directory)
        .startsWith(`${path.resolve(os.tmpdir())}${path.sep}`),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
