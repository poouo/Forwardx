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

export type EffectiveTunnelProxyProtocolOptions = {
  entryReceive: boolean;
  entrySend: boolean;
  exitReceive: boolean;
  exitSend: boolean;
  version: 1 | 2;
};

export function gostProxyProtocolMetadata(version: unknown): GostProxyProtocolMetadata {
  // GOST v3.2.6 ignores JSON numbers here because metadata values decode as float64.
  return { proxyProtocol: Number(version) === 2 ? "2" : "1" };
}

export function effectiveTunnelProxyProtocolOptions(options: GostTunnelProxyProtocolOptions): EffectiveTunnelProxyProtocolOptions {
  const entryReceive = options.entryReceive === true;
  const entrySend = options.entrySend === true;
  const exitSend = options.exitSend === true;
  return {
    entryReceive,
    entrySend,
    // The bridge is an implementation detail. When both ends send PROXY,
    // consume the authenticated inner header so its source is not replaced by
    // the bridge's 127.0.0.1 socket address.
    exitReceive: options.exitReceive === true || (entrySend && exitSend),
    exitSend,
    version: Number(options.version) === 2 ? 2 : 1,
  };
}

export function gostTunnelProxyProtocolPlan(options: GostTunnelProxyProtocolOptions): GostTunnelProxyProtocolPlan {
  const effective = effectiveTunnelProxyProtocolOptions(options);
  return {
    entryListener: effective.entryReceive ? gostProxyProtocolMetadata(effective.version) : undefined,
    entryHandler: effective.entrySend ? gostProxyProtocolMetadata(effective.version) : undefined,
    exitBridgeReceive: effective.exitReceive ? gostProxyProtocolMetadata(effective.version) : undefined,
    exitBridgeSend: effective.exitSend ? gostProxyProtocolMetadata(effective.version) : undefined,
  };
}
