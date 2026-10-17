import { useEffect, useState, useSyncExternalStore } from "react";
import { useLocation } from "wouter";
import { normalizeOperationsRefresh, operationsRefreshInterval, operationsRefreshStorageKey, type OperationsRefreshSeconds } from "@/lib/operationsRefresh";

function readPreference(userId: number | undefined) {
  try { return normalizeOperationsRefresh(window.localStorage.getItem(operationsRefreshStorageKey(userId))); }
  catch { return normalizeOperationsRefresh(undefined); }
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function isVisible() { return document.visibilityState === "visible"; }

export function useOperationsRefresh(userId: number | undefined) {
  const [location] = useLocation();
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, () => false);
  const [seconds, setSeconds] = useState<OperationsRefreshSeconds>(() => readPreference(userId));
  useEffect(() => { setSeconds(readPreference(userId)); }, [userId]);
  const onChange = (value: string) => {
    const next = normalizeOperationsRefresh(value);
    setSeconds(next);
    try { window.localStorage.setItem(operationsRefreshStorageKey(userId), String(next)); }
    catch { /* Keep the current choice when browser storage is unavailable. */ }
  };
  return { seconds, onChange, interval: operationsRefreshInterval(seconds, visible, location) };
}
