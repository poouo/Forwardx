// Page-owned dashboard shells remount on navigation. Keep only scroll offsets,
// scoped by account and sidebar mode, for the lifetime of the current app.
export function createSidebarScrollMemory() {
  const offsets = new Map<string, number>();

  return (content: Pick<HTMLElement, "scrollTop">, key: string) => {
    const target = offsets.get(key) ?? 0;
    let restoring = true;
    const save = () => {
      // An asynchronously populated menu may temporarily clamp scrollTop.
      // Don't replace the remembered offset with that incomplete position.
      if (!restoring) offsets.set(key, content.scrollTop);
    };
    return {
      restore() {
        if (!restoring) return;
        content.scrollTop = target;
        restoring = Math.abs(content.scrollTop - target) > 1;
      },
      save,
      interrupt() {
        // A user's new scrolling intent takes precedence over pending restore.
        restoring = false;
        save();
      },
    };
  };
}

export const rememberSidebarScroll = createSidebarScrollMemory();
