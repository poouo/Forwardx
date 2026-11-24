import { createHmac, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpenSsl } from "./panelSsl";

export const REVERSE_GOST_TLS_NAME = "forwardx-reverse.invalid";

export async function reverseGostCertificate(previous?: { reverseCertPem?: string | null; reverseKeyPem?: string | null }) {
  if (previous?.reverseCertPem && previous.reverseKeyPem
    && Date.parse(new X509Certificate(previous.reverseCertPem).validTo) > Date.now() + 30 * 86400_000) {
    return { reverseCertPem: previous.reverseCertPem, reverseKeyPem: previous.reverseKeyPem };
  }
  const directory = await mkdtemp(join(tmpdir(), "forwardx-reverse-"));
  try {
    const cert = join(directory, "cert.pem");
    const key = join(directory, "key.pem");
    await runOpenSsl([
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
      "-nodes", "-sha256", "-days", "3650", "-subj", `/CN=${REVERSE_GOST_TLS_NAME}`,
      "-addext", `subjectAltName=DNS:${REVERSE_GOST_TLS_NAME}`,
      "-keyout", key, "-out", cert,
    ]);
    return { reverseCertPem: await readFile(cert, "utf8"), reverseKeyPem: await readFile(key, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type ReverseGostTunnel = {
  id: number;
  secret: string;
  reverseListenPort: number;
};

function routeDigest(tunnel: ReverseGostTunnel, purpose: string) {
  return createHmac("sha256", tunnel.secret)
    .update(`forwardx/gost-reverse/${tunnel.id}/${purpose}`).digest("hex");
}

export function reverseGostRoute(tunnel: ReverseGostTunnel, route: string) {
  const token = routeDigest(tunnel, route);
  const id = `${token.slice(0, 8)}-${token.slice(8, 12)}-4${token.slice(13, 16)}-8${token.slice(17, 20)}-${token.slice(20, 32)}`;
  return { id, address: "127.0.0.1:0" };
}

export function reverseGostAuth(tunnel: ReverseGostTunnel) {
  return { username: "forwardx", password: routeDigest(tunnel, "authentication") };
}

export function reverseGostCertificatePaths(directory: string, tunnelId: number) {
  return { certFile: `${directory}/gost-reverse-${tunnelId}.pem`, keyFile: `${directory}/gost-reverse-${tunnelId}.key` };
}

export function reverseGostHealthProbe(tunnel: ReverseGostTunnel, directory: string) {
  return {
    ...reverseGostAuth(tunnel),
    routeId: reverseGostRoute(tunnel, "health").id,
    caFile: reverseGostCertificatePaths(directory, tunnel.id).certFile,
    serverName: REVERSE_GOST_TLS_NAME,
  };
}

export function reverseGostListener(tunnel: ReverseGostTunnel, files: { certFile: string; keyFile: string }) {
  return {
    name: `fwx-reverse-${tunnel.id}`,
    addr: `:${tunnel.reverseListenPort}`,
    handler: { type: "tunnel", auth: reverseGostAuth(tunnel), metadata: {
      "tunnel.direct": true,
      "mux.keepaliveInterval": "5s",
      "mux.keepaliveTimeout": "15s",
      readTimeout: "10s",
    } },
    listener: { type: "tls", tls: files },
  };
}

export function reverseGostChain(
  tunnel: ReverseGostTunnel, name: string, route: string, endpoint: string, caFile: string,
) {
  return { name, hops: [{ name: `${name}-hop`, nodes: [{
    name: `${name}-node`,
    addr: endpoint,
    connector: { type: "tunnel", auth: reverseGostAuth(tunnel), metadata: {
      "tunnel.id": reverseGostRoute(tunnel, route).id,
      connectTimeout: "5s",
      "mux.keepaliveInterval": "5s",
      "mux.keepaliveTimeout": "15s",
    } },
    dialer: { type: "tls", tls: { caFile, secure: true, serverName: REVERSE_GOST_TLS_NAME } },
  }] }] };
}

export function reverseGostExit(tunnel: ReverseGostTunnel, route: string, chain: string, protocol: "tcp" | "udp", target?: string) {
  return {
    name: `fwx-reverse-exit-${tunnel.id}-${route}`,
    addr: reverseGostRoute(tunnel, route).address,
    listener: { type: protocol === "tcp" ? "rtcp" : "rudp", chain },
    handler: { type: protocol },
    ...(target ? { forwarder: { nodes: [{ name: "target", addr: target }] } } : {}),
  };
}

export function reverseGostHealthExit(tunnel: ReverseGostTunnel, chain: string) {
  return {
    ...reverseGostExit(tunnel, "health", chain, "tcp"),
    handler: { type: "tunnel", auth: reverseGostAuth(tunnel) },
  };
}
