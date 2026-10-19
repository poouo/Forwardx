/** A retryable, deduplicated module cache. Import failures never poison a page forever. */
export function createModuleResource<T>(importModule: () => Promise<T>) {
  type Snapshot = { status: "idle" | "loading" | "ready" | "error"; value?: T };
  let snapshot: Snapshot = { status: "idle" };
  let pending: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load() {
      if (pending) return pending;
      if (snapshot.status === "ready") return Promise.resolve();
      publish({ status: "loading" });
      pending = Promise.resolve().then(importModule).then(
        value => { publish({ status: "ready", value }); },
        () => { publish({ status: "error" }); },
      ).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
