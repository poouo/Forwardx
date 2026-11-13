import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
        duration: 10,
        rateMbps: 0,
      },
      plan,
      token,
    );
    assert.equal(created.state, "preparing");
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
