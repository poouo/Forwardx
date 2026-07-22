function generationKey(scope: string, refId: unknown) {
  return `${String(scope || "").trim()}:${Number(refId) || 0}`;
}

export class DnsRuntimeGenerationTracker {
  private readonly generations = new Map<string, number>();
  private readonly changeTokens = new Map<string, string>();

  generation(scope: string, refId: unknown, changeToken?: string | null) {
    const key = generationKey(scope, refId);
    const current = this.generations.get(key) || 0;
    const token = String(changeToken || "").trim();
    if (!token || this.changeTokens.get(key) === token) return current;
    const next = current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
    this.generations.set(key, next);
    this.changeTokens.set(key, token);
    return next;
  }
}
