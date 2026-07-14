export type GostProxyProtocolMetadata = {
  proxyProtocol: "1" | "2";
};

export type GostTunnelProxyProtocolPlan = {
  entryListener?: GostProxyProtocolMetadata;
  entryHandler?: GostProxyProtocolMetadata;
  exitBridgeReceive?: GostProxyProtocolMetadata;
  exitBridgeSend?: GostProxyProtocolMetadata;
};

export type GostTunnelProxyProtocolOptions = {
  entryReceive: boolean;
  entrySend: boolean;
  exitReceive: boolean;
  exitSend: boolean;
  version: unknown;
};

export function gostProxyProtocolMetadata(version: unknown): GostProxyProtocolMetadata {
  // GOST v3.2.6 ignores JSON numbers here because metadata values decode as float64.
  return { proxyProtocol: Number(version) === 2 ? "2" : "1" };
}

export function gostTunnelProxyProtocolPlan(options: GostTunnelProxyProtocolOptions): GostTunnelProxyProtocolPlan {
  return {
    entryListener: options.entryReceive ? gostProxyProtocolMetadata(options.version) : undefined,
    entryHandler: options.entrySend ? gostProxyProtocolMetadata(options.version) : undefined,
    exitBridgeReceive: options.exitReceive ? gostProxyProtocolMetadata(options.version) : undefined,
    exitBridgeSend: options.exitSend ? gostProxyProtocolMetadata(options.version) : undefined,
  };
}
