import crypto from "node:crypto";
import * as db from "./db";
import { forwardGroupRouteMembers } from "../shared/forwardGroup";
import type { LinkSpeedProtocol, LinkSpeedStatus } from "../shared/linkSpeed";
import {
  reserveAvailableHostPort,
  releaseHostPortReservations,
  type HostPortReservation,
} from "./portReservations";
import {
  defaultTunnelHostAddress,
  selectTunnelDialAddress,
  selectTunnelHopDialAddress,
} from "./tunnelAddressSelection";
import {
  forwardXV3SpecOptions,
  forwardXTransportVersionForTunnel,
} from "./forwardXTransport";
import { requireTunnelProtocolEnabled } from "./forwardProtocolSettings";
import { hostTrafficExcluded } from "../shared/hostTrafficPolicy";

export type SpeedComponent = {
  kind: "receiver" | "proxy" | "gost" | "fxp";
  port: number;
  listenHost: string;
  target?: string;
  tlsClient?: boolean;
  serverName?: string;
  certPem?: string;
  keyPem?: string;
  config?: any;
};
export type SpeedPlan = {
  hosts: Map<number, SpeedComponent[]>;
  sourceHostId: number;
  target: string;
  route: LinkSpeedStatus["route"];
  reservations: HostPortReservation[];
  limitMbps: number;
};
export const speedEndpoint = (host: string, port: number) =>
  `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
const enabled = (value: unknown) =>
  ![false, 0, "0", "false"].includes(value as any);

/** Temporary listeners follow the selected topology; business targets are never rewritten. */
export async function buildLinkSpeedPlan(
  resource: any,
  type: "tunnel" | "chain",
  protocol: LinkSpeedProtocol,
  token: string,
): Promise<SpeedPlan> {
  const plan: SpeedPlan = {
    hosts: new Map(),
    sourceHostId: 0,
    target: "",
    route: [],
    reservations: [],
    limitMbps: 0,
  };
  const hostCache = new Map<number, any>();
  const limit = (value: unknown) => {
    const n = Number(value);
    if (n > 0)
      plan.limitMbps = plan.limitMbps > 0 ? Math.min(plan.limitMbps, n) : n;
  };
  const host = async (id: number) => {
    if (!hostCache.has(id)) {
      const row = await db.getHostById(id);
      if (!row?.agentToken || !row.isOnline || hostTrafficExcluded(row))
        throw new Error(
          `主机 ${row?.name || id} 离线、未绑定 Agent 或已停止流量服务`,
        );
      hostCache.set(id, row);
    }
    return hostCache.get(id);
  };
  const allocate = async (id: number, tunnel?: any) => {
    await host(id);
    const reservation = await reserveAvailableHostPort({
      hostId: id,
      protocol: "both",
      findPort: (reserved) =>
        db.findAvailablePort(
          id,
          tunnel?.portRangeStart,
          tunnel?.portRangeEnd,
          "both",
          reserved,
        ),
    });
    if (!reservation)
      throw new Error(`主机 ${(await host(id)).name} 没有可用的测速端口`);
    plan.reservations.push(reservation);
    return reservation.port;
  };
  const add = (id: number, component: SpeedComponent) => {
    plan.hosts.set(id, [...(plan.hosts.get(id) || []), component]);
  };
  const routeNode = async (id: number, transport: string) => ({
    hostId: id,
    name: String((await host(id)).name || `#${id}`),
    transport,
  });
  try {
    if (!enabled(resource.isEnabled)) throw new Error("请先启用链路");
    limit(resource.rateLimitMbps);
    const segments: Array<{
      hostId: number;
      tunnel?: any;
      connectHost?: string;
    }> = [];
    if (type === "tunnel")
      segments.push({ hostId: Number(resource.entryHostId), tunnel: resource });
    else {
      if (resource.groupMode !== "chain")
        throw new Error("请选择转发链进行测速");
      if (
        resource.protocol &&
        resource.protocol !== "both" &&
        resource.protocol !== protocol
      )
        throw new Error(`此转发链未启用 ${protocol.toUpperCase()}`);
      if (resource.entryGroupId) {
        const group = await db.getForwardGroupById(
          Number(resource.entryGroupId),
        );
        const entry =
          group &&
          enabled(group.isEnabled) &&
          forwardGroupRouteMembers(group).find(
            (m: any) => m.memberType === "host",
          );
        if (!entry) throw new Error("入口组没有可用入口");
        segments.push({
          hostId: Number(entry.hostId),
          connectHost: entry.connectHost,
        });
      }
      for (const member of forwardGroupRouteMembers(resource)) {
        if (member.memberType === "tunnel") {
          const tunnel = await db.getTunnelById(Number(member.tunnelId));
          if (!tunnel) throw new Error("转发链中的隧道不存在");
          segments.push({
            hostId: Number(tunnel.entryHostId),
            tunnel,
            connectHost: member.connectHost,
          });
        } else
          segments.push({
            hostId: Number(member.hostId),
            connectHost: member.connectHost,
          });
      }
    }
    if (!segments.length) throw new Error("没有可测速的节点");
    const last = segments.at(-1)!;
    const finalHostId = Number(last.tunnel?.exitHostId || last.hostId);
    const receiverPort = await allocate(finalHostId);
    add(finalHostId, {
      kind: "receiver",
      port: receiverPort,
      listenHost: last.tunnel ? "127.0.0.1" : "",
    });
    let next = {
      hostId: finalHostId,
      host: last.tunnel
        ? "127.0.0.1"
        : String(
            last.connectHost ||
              defaultTunnelHostAddress(await host(finalHostId)),
          ),
      port: receiverPort,
    };
    let orderedRoute: LinkSpeedStatus["route"] = last.tunnel
      ? []
      : [await routeNode(finalHostId, "接收端")];
    for (let s = segments.length - 1; s >= 0; s--) {
      const segment = segments[s];
      const tunnel = segment.tunnel;
      if (!tunnel && s === segments.length - 1) continue;
      const entryId = segment.hostId;
      const entryPort = await allocate(entryId, tunnel);
      let target =
        next.hostId === entryId
          ? speedEndpoint("127.0.0.1", next.port)
          : speedEndpoint(next.host, next.port);
      const localOnly = s === 0;
      if (!tunnel) {
        add(entryId, {
          kind: "proxy",
          port: entryPort,
          listenHost: localOnly ? "127.0.0.1" : "",
          target,
        });
        orderedRoute.unshift(
          await routeNode(entryId, `直连 ${protocol.toUpperCase()}`),
        );
      } else {
        if (!enabled(tunnel.isEnabled))
          throw new Error(`隧道 ${tunnel.name} 已停用`);
        await requireTunnelProtocolEnabled(tunnel);
        limit(tunnel.rateLimitMbps);
        const storedHops = await db.getTunnelHops(Number(tunnel.id));
        let hops: any[] =
          storedHops.length >= 2
            ? storedHops
            : [{ hostId: entryId }, { hostId: Number(tunnel.exitHostId) }];
        if (tunnel.relayMode === "failover" && hops.length > 2)
          hops = [hops[0], hops[1], hops.at(-1)];
        if (
          Number(hops[0].hostId) !== entryId ||
          Number(hops.at(-1).hostId) !== Number(tunnel.exitHostId)
        )
          throw new Error("隧道拓扑已变化，请刷新后重试");
        if (new Set(hops.map((h) => Number(h.hostId))).size !== hops.length)
          throw new Error("隧道存在重复节点");
        const ports = [entryPort];
        for (const hop of hops.slice(1))
          ports.push(await allocate(Number(hop.hostId), tunnel));
        const addresses: string[] = ["127.0.0.1"];
        for (let i = 1; i < hops.length; i++) {
          const row = await host(Number(hops[i].hostId));
          const address =
            storedHops.length >= 2
              ? selectTunnelHopDialAddress(hops[i], row, tunnel)
              : selectTunnelDialAddress(tunnel, row);
          if (!address) throw new Error(`主机 ${row.name} 缺少链路地址`);
          addresses.push(address);
        }
        const transport = String(tunnel.mode);
        target =
          next.hostId === Number(tunnel.exitHostId)
            ? speedEndpoint("127.0.0.1", next.port)
            : speedEndpoint(next.host, next.port);
        if (transport === "forwardx") {
          const version = forwardXTransportVersionForTunnel(tunnel);
          if (
            protocol === "udp" &&
            version === "v1" &&
            [true, 1, "1", "true"].includes(tunnel.udpOverTcp)
          )
            throw new Error(
              "此 V1 Mimic 链路暂不支持独立 UDP 测速，请使用 TCP",
            );
          const v3 = version === "v3" ? forwardXV3SpecOptions(tunnel) : {};
          if (!v3) throw new Error("ForwardX V3 传输参数不完整");
          const ruleId = crypto.randomInt(1_000_000_000, 2_000_000_000);
          for (let i = 0; i < hops.length; i++) {
            const isLast = i === hops.length - 1;
            const spec: any = {
              role: i === 0 ? "entry" : isLast ? "exit" : "relay",
              transportVersion: version,
              ...v3,
              tunnelId: Number(tunnel.id),
              ruleId,
              listenPort: ports[i],
              protocol,
              key: token,
              targetIp:
                next.hostId === Number(tunnel.exitHostId)
                  ? "127.0.0.1"
                  : next.host,
              targetPort: next.port,
              udpTargets: [
                {
                  ruleId,
                  targetIp:
                    next.hostId === Number(tunnel.exitHostId)
                      ? "127.0.0.1"
                      : next.host,
                  targetPort: next.port,
                },
              ],
            };
            if (i === 0)
              Object.assign(spec, {
                listenHost: localOnly ? "127.0.0.1" : "",
                exitHost: addresses[1],
                exitPort: ports[1],
                exitPeerId: String(hops[1].hostId),
              });
            else if (!isLast)
              Object.assign(spec, {
                relayExitHost: addresses[i + 1],
                relayExitPort: ports[i + 1],
                relayPeerId: String(hops[i + 1].hostId),
                relayKey: token,
              });
            add(Number(hops[i].hostId), {
              kind: "fxp",
              port: ports[i],
              listenHost: i === 0 && localOnly ? "127.0.0.1" : "",
              config: spec,
            });
          }
        } else if (transport === "nginx_stream") {
          // Nginx UDP streams are plain UDP; TLS is only used for TCP streams.
          for (let i = 0; i < hops.length; i++) {
            const isLast = i === hops.length - 1;
            const tls =
              protocol === "tcp" && !!tunnel.certPem && !!tunnel.certKeyPem;
            add(Number(hops[i].hostId), {
              kind: "proxy",
              port: ports[i],
              listenHost: i === 0 && localOnly ? "127.0.0.1" : "",
              target: isLast
                ? target
                : speedEndpoint(addresses[i + 1], ports[i + 1]),
              tlsClient: !isLast && tls,
              serverName: tunnel.certDomain || "",
              ...(i > 0 && tls
                ? { certPem: tunnel.certPem, keyPem: tunnel.certKeyPem }
                : {}),
            });
          }
        } else if (
          ["tcp", "tls", "wss", "mtcp", "mtls", "mwss"].includes(transport)
        ) {
          const auth = { username: "link-speed", password: token };
          for (let i = 1; i < hops.length; i++)
            add(Number(hops[i].hostId), {
              kind: "gost",
              port: ports[i],
              listenHost: "",
              config: {
                services: [
                  {
                    name: `speed-hop-${i}`,
                    addr: `:${ports[i]}`,
                    handler: {
                      type: "relay",
                      auth,
                      metadata: { nodelay: true },
                    },
                    listener: { type: transport },
                  },
                ],
              },
            });
          const chain = {
            name: "speed-chain",
            hops: hops
              .slice(1)
              .map((_, index) => ({
                name: `hop-${index}`,
                nodes: [
                  {
                    name: `node-${index}`,
                    addr: speedEndpoint(addresses[index + 1], ports[index + 1]),
                    connector: {
                      type: "relay",
                      auth,
                      metadata: { nodelay: true },
                    },
                    dialer: { type: transport },
                  },
                ],
              })),
          };
          add(entryId, {
            kind: "gost",
            port: entryPort,
            listenHost: localOnly ? "127.0.0.1" : "",
            config: {
              services: [
                {
                  name: "speed-entry",
                  addr: speedEndpoint(localOnly ? "127.0.0.1" : "", entryPort),
                  handler: { type: protocol, chain: chain.name },
                  listener: {
                    type: protocol,
                    ...(protocol === "udp"
                      ? {
                          metadata: {
                            keepalive: true,
                            ttl: "90s",
                            readBufferSize: "65535",
                            readQueueSize: "1024",
                          },
                        }
                      : {}),
                  },
                  forwarder: {
                    nodes: [
                      {
                        name: "target",
                        addr: target,
                        connector: { type: protocol },
                        dialer: { type: protocol },
                      },
                    ],
                  },
                },
              ],
              chains: [chain],
            },
          });
        } else throw new Error(`暂不支持 ${transport} 链路测速`);
        orderedRoute = [
          ...(await Promise.all(
            hops.map((h) =>
              routeNode(
                Number(h.hostId),
                transport === "forwardx"
                  ? `ForwardX ${forwardXTransportVersionForTunnel(tunnel)}`
                  : transport,
              ),
            ),
          )),
          ...orderedRoute,
        ];
      }
      next = {
        hostId: entryId,
        host: String(
          segment.connectHost || defaultTunnelHostAddress(await host(entryId)),
        ),
        port: entryPort,
      };
    }
    plan.sourceHostId = segments[0].hostId;
    plan.target = speedEndpoint("127.0.0.1", next.port);
    plan.route = orderedRoute.filter(
      (node, i, all) => i === 0 || all[i - 1].hostId !== node.hostId,
    );
    if (plan.route.length < 2) throw new Error("链路测速至少需要两台主机");
    return plan;
  } catch (error) {
    releaseHostPortReservations(plan.reservations);
    throw error;
  }
}
