import crypto from "crypto";
import { normalizeForwardXVersion } from "../shared/forwardTypes";

export const AGENT_FORWARDX_WIREGUARD_VERSION = "2.2.154";

export type ForwardXWireGuardNode = {
  hostId: number;
  listenPort?: number;
};

export type ForwardXWireGuardLink = {
  fromHostId: number;
  toHostId: number;
  endpointHost: string;
  endpointPort: number;
};

export type ForwardXWireGuardPeerPlan = {
  id: string;
  hostId: number;
  publicKey: string;
  address: string;
  endpointHost?: string;
  endpointPort?: number;
  persistentKeepalive: number;
};

export type ForwardXWireGuardNodePlan = {
  tunnelId: number;
  generation: number;
  privateKey: string;
  publicKey: string;
  address: string;
  listenPort: number;
  mtu: number;
  peers: ForwardXWireGuardPeerPlan[];
};

export function isForwardXWireGuardV2(tunnel: any) {
  return String(tunnel?.mode || "").trim().toLowerCase() === "forwardx"
    && normalizeForwardXVersion(tunnel?.forwardxVersion) === "v2";
}

function wireGuardPrivateKey(seed: string, tunnelId: number, hostId: number) {
  const key = crypto
    .createHmac("sha256", String(seed || "forwardx-wireguard-v2"))
    .update(`forwardx-wireguard-v2|${tunnelId}|${hostId}`)
    .digest();
  key[0] &= 248;
  key[31] &= 127;
  key[31] |= 64;
  return key;
}

function wireGuardPublicKey(privateKey: Buffer) {
  const pkcs8Prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  const privateObject = crypto.createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, privateKey]),
    format: "der",
    type: "pkcs8",
  });
  const spki = crypto.createPublicKey(privateObject).export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32);
}

export function deriveForwardXWireGuardKeyPair(seed: string, tunnelId: number, hostId: number) {
  const privateKey = wireGuardPrivateKey(seed, tunnelId, hostId);
  const publicKey = wireGuardPublicKey(privateKey);
  return {
    privateKey: privateKey.toString("hex"),
    publicKey: publicKey.toString("hex"),
  };
}

function overlayAddress(seed: string, tunnelId: number, hostId: number, occupied: Set<string>) {
  const digest = crypto
    .createHash("sha256")
    .update(`forwardx-wireguard-address|${seed}|${tunnelId}|${hostId}`)
    .digest();
  let slot = digest.readUInt32BE(0) & 0x3fffff;
  for (let attempt = 0; attempt < 0x400000; attempt += 1) {
    const value = (slot + attempt) & 0x3fffff;
    const address = `100.${64 + ((value >>> 16) & 0x3f)}.${(value >>> 8) & 0xff}.${value & 0xff}`;
    if (!occupied.has(address)) {
      occupied.add(address);
      return address;
    }
  }
  throw new Error("WireGuard 虚拟地址分配失败");
}

export function buildForwardXWireGuardPlans(input: {
  tunnelId: number;
  seed: string;
  generation?: number;
  mtu?: number;
  nodes: ForwardXWireGuardNode[];
  links: ForwardXWireGuardLink[];
}) {
  const tunnelId = Number(input.tunnelId);
  if (!Number.isInteger(tunnelId) || tunnelId <= 0) throw new Error("WireGuard 隧道 ID 无效");
  const nodes = Array.from(new Map(input.nodes
    .map((node) => ({ hostId: Number(node.hostId), listenPort: Number(node.listenPort || 0) }))
    .filter((node) => Number.isInteger(node.hostId) && node.hostId > 0)
    .map((node) => [node.hostId, node] as const)).values()).sort((a, b) => a.hostId - b.hostId);
  if (nodes.length < 2) throw new Error("WireGuard V2 至少需要两个节点");

  const occupied = new Set<string>();
  const identityByHost = new Map<number, { address: string; privateKey: string; publicKey: string }>();
  for (const node of nodes) {
    identityByHost.set(node.hostId, {
      address: overlayAddress(input.seed, tunnelId, node.hostId, occupied),
      ...deriveForwardXWireGuardKeyPair(input.seed, tunnelId, node.hostId),
    });
  }

  const peerMaps = new Map<number, Map<number, ForwardXWireGuardPeerPlan>>();
  const ensurePeer = (localHostId: number, remoteHostId: number) => {
    if (!identityByHost.has(localHostId) || !identityByHost.has(remoteHostId) || localHostId === remoteHostId) return null;
    let peers = peerMaps.get(localHostId);
    if (!peers) {
      peers = new Map();
      peerMaps.set(localHostId, peers);
    }
    let peer = peers.get(remoteHostId);
    if (!peer) {
      const remote = identityByHost.get(remoteHostId)!;
      peer = {
        id: String(remoteHostId),
        hostId: remoteHostId,
        publicKey: remote.publicKey,
        address: remote.address,
        persistentKeepalive: 0,
      };
      peers.set(remoteHostId, peer);
    }
    return peer;
  };

  for (const link of input.links) {
    const fromHostId = Number(link.fromHostId);
    const toHostId = Number(link.toHostId);
    const endpointHost = String(link.endpointHost || "").trim();
    const endpointPort = Number(link.endpointPort || 0);
    const outboundPeer = ensurePeer(fromHostId, toHostId);
    ensurePeer(toHostId, fromHostId);
    if (!outboundPeer || !endpointHost || !Number.isInteger(endpointPort) || endpointPort <= 0 || endpointPort > 65535) {
      throw new Error(`WireGuard V2 节点 ${fromHostId}->${toHostId} 的连接地址或端口无效`);
    }
    outboundPeer.endpointHost = endpointHost;
    outboundPeer.endpointPort = endpointPort;
    outboundPeer.persistentKeepalive = 25;
  }

  const plans = new Map<number, ForwardXWireGuardNodePlan>();
  for (const node of nodes) {
    const identity = identityByHost.get(node.hostId)!;
    plans.set(node.hostId, {
      tunnelId,
      generation: Math.max(0, Number(input.generation || 0)),
      privateKey: identity.privateKey,
      publicKey: identity.publicKey,
      address: identity.address,
      listenPort: Number.isInteger(node.listenPort) && node.listenPort > 0 ? node.listenPort : 0,
      mtu: Math.min(1420, Math.max(1200, Number(input.mtu || 1380))),
      peers: Array.from(peerMaps.get(node.hostId)?.values() || []).sort((a, b) => a.hostId - b.hostId),
    });
  }
  return plans;
}
