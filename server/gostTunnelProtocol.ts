import crypto from "crypto";
import { normalizeForwardRuleProtocol } from "@shared/forwardTypes";

type GostAuth = {
  username: string;
  password: string;
};

type GostComponent = {
  type: "forward" | "relay";
  auth?: GostAuth;
  metadata?: Record<string, unknown>;
};

export type GostTunnelRuleProtocolPlan = {
  protocol: "tcp" | "udp" | "both";
  entryNeedsTarget: boolean;
  chainConnector: GostComponent;
  exitHandler: GostComponent;
  exitTargetDialType: "tcp" | "udp" | null;
};

export function planGostTunnelRuleProtocol(input: {
  protocol: unknown;
  tunnelId: number;
  ruleId: number;
  secretSeed: string;
}): GostTunnelRuleProtocolPlan {
  const protocol = normalizeForwardRuleProtocol(input.protocol, "tcp");
  if (protocol !== "both") {
    return {
      protocol,
      entryNeedsTarget: false,
      chainConnector: { type: "forward" },
      exitHandler: { type: "forward" },
      exitTargetDialType: protocol,
    };
  }

  const tunnelId = Math.max(0, Math.trunc(Number(input.tunnelId) || 0));
  const ruleId = Math.max(0, Math.trunc(Number(input.ruleId) || 0));
  const password = crypto
    .createHash("sha256")
    .update(`forwardx-gost-relay:v1|${String(input.secretSeed || "")}|${tunnelId}|${ruleId}`)
    .digest("hex");
  const auth = {
    username: `fwx-${tunnelId}-${ruleId}`,
    password,
  };

  return {
    protocol,
    entryNeedsTarget: true,
    chainConnector: {
      type: "relay",
      auth,
      metadata: { nodelay: true },
    },
    exitHandler: {
      type: "relay",
      auth,
      metadata: { nodelay: true },
    },
    exitTargetDialType: null,
  };
}
