import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";

type UseUrlTabOptions<T extends string> = {
  values: readonly T[];
  defaultValue: T;
  storageKey?: string;
  queryKey?: string;
  clearDefaultFromUrl?: boolean;
};

function getQueryValue(location: string, queryKey: string) {
  const query = location.split("?")[1] || "";
  return new URLSearchParams(query).get(queryKey);
}

function readStoredTab<T extends string>(storageKey: string | undefined, coerce: (value: unknown) => T | null) {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    return coerce(window.localStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

function writeStoredTab(storageKey: string | undefined, value: string) {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    // URL state still works when localStorage is unavailable.
  }
}

export function useUrlTab<T extends string>({
  values,
  defaultValue,
  storageKey,
  queryKey = "tab",
  clearDefaultFromUrl = true,
}: UseUrlTabOptions<T>) {
  const [location, setLocation] = useLocation();
  const valuesKey = values.join("\0");
  const allowedValues = useMemo(() => new Set<T>(values), [valuesKey]);

  const coerce = useCallback((value: unknown): T | null => {
    const raw = String(value || "");
    return allowedValues.has(raw as T) ? (raw as T) : null;
  }, [allowedValues]);

  const resolveTab = useCallback(() => {
    return coerce(getQueryValue(location, queryKey))
      || readStoredTab(storageKey, coerce)
      || defaultValue;
  }, [coerce, defaultValue, location, queryKey, storageKey]);

  const [tab, setTabState] = useState<T>(() => resolveTab());

  useEffect(() => {
    const next = resolveTab();
    setTabState((current) => (current === next ? current : next));
    writeStoredTab(storageKey, next);
  }, [resolveTab, storageKey]);

  const setTab = useCallback((nextValue: T | string) => {
    const next = coerce(nextValue) || defaultValue;
    setTabState(next);
    writeStoredTab(storageKey, next);

    const [path, query = ""] = location.split("?");
    const params = new URLSearchParams(query);
    if (clearDefaultFromUrl && next === defaultValue) {
      params.delete(queryKey);
    } else {
      params.set(queryKey, next);
    }
    const nextQuery = params.toString();
    const nextLocation = `${path || "/"}${nextQuery ? `?${nextQuery}` : ""}`;
    if (nextLocation !== location) setLocation(nextLocation);
  }, [clearDefaultFromUrl, coerce, defaultValue, location, queryKey, setLocation, storageKey]);

  return [tab, setTab] as const;
}
