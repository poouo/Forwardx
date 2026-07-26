import { randomUUID } from "node:crypto";

type MimicRuntimeLifecycleState = {
  planSignature: string;
  resourceRevisionSignature: string;
  repairNeeded: boolean;
  generation: number;
  revision: number;
  token: string;
};

function nextGeneration(current: number) {
  return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
}

export class MimicRuntimeLifecycleTracker {
  private readonly states = new Map<number, MimicRuntimeLifecycleState>();

  constructor(private readonly fallbackEpoch: string = randomUUID()) {}

  observe(input: {
    hostId: number;
    planSignature: string;
    resourceRevisionSignature?: string;
    desired: boolean;
    repairNeeded: boolean;
    revision?: number;
  }) {
    const hostId = Math.floor(Number(input.hostId));
    const planSignature = String(input.planSignature || "");
    const resourceRevisionSignature = String(input.resourceRevisionSignature || "");
    const repairNeeded = !!input.desired && !!input.repairNeeded;
    const revision = Math.max(0, Math.floor(Number(input.revision) || 0));
    const previous = this.states.get(hostId);
    let generation = previous?.generation || 0;
    let token = previous?.token || "";

    if (
      !previous
      || previous.planSignature !== planSignature
      || previous.resourceRevisionSignature !== resourceRevisionSignature
      || (repairNeeded && !previous.repairNeeded)
    ) {
      generation = nextGeneration(generation);
      if (revision > 0) {
        token = previous?.revision === revision
          ? `config:${revision}:${generation}`
          : `config:${revision}`;
      } else {
        token = `${this.fallbackEpoch}:${generation}`;
      }
    }

    this.states.set(hostId, { planSignature, resourceRevisionSignature, repairNeeded, generation, revision, token });
    return token;
  }
}

export const mimicRuntimeLifecycles = new MimicRuntimeLifecycleTracker();
