import { useEffect, useMemo, useRef, useState, type ElementType } from "react";
import { cn } from "@/lib/utils";

const CACHE_PREFIX = "forwardx.stat.";

type AnimatedStatValueProps = {
  value: string | number | null | undefined;
  loading?: boolean;
  cacheKey?: string;
  fallbackCacheKeys?: string[];
  mirrorCacheKeys?: string[];
  fallbackValue?: string | number | null;
  as?: ElementType;
  className?: string;
  title?: string;
};

function textValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "0";
  return String(value);
}

function readCachedValue(
  cacheKey: string | undefined,
  fallbackCacheKeys: string[] = [],
) {
  if (typeof window === "undefined") return null;
  try {
    const keys = [cacheKey, ...fallbackCacheKeys].filter((key): key is string => !!key);
    for (const key of keys) {
      const cached = window.localStorage.getItem(`${CACHE_PREFIX}${key}`);
      if (cached !== null && cached !== "") return cached;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCachedValue(cacheKey: string | undefined, value: string, mirrorCacheKeys: string[] = []) {
  if (typeof window === "undefined") return;
  try {
    const keys = [cacheKey, ...mirrorCacheKeys].filter((key): key is string => !!key);
    keys.forEach((key) => window.localStorage.setItem(`${CACHE_PREFIX}${key}`, value));
  } catch {
    // The value is purely presentational, so private-mode storage failures can be ignored.
  }
}

export default function AnimatedStatValue({
  value,
  loading = false,
  cacheKey,
  fallbackCacheKeys = [],
  mirrorCacheKeys = [],
  fallbackValue,
  as: Component = "span",
  className,
  title,
}: AnimatedStatValueProps) {
  const nextValue = textValue(value);
  const fallback = useMemo(() => textValue(fallbackValue ?? value), [fallbackValue, value]);
  const fallbackCacheKeySignature = fallbackCacheKeys.join("\u0000");
  const mirrorCacheKeySignature = mirrorCacheKeys.join("\u0000");
  const currentCacheKey = cacheKey || "";
  const [cachedState, setCachedState] = useState(() => {
    const cached = readCachedValue(cacheKey, fallbackCacheKeys);
    return { key: currentCacheKey, value: cached ?? fallback, hasCachedValue: cached !== null };
  });
  const lastResolvedValueRef = useRef({
    key: currentCacheKey,
    value: cachedState.hasCachedValue ? cachedState.value : "",
  });

  useEffect(() => {
    const cached = readCachedValue(cacheKey, fallbackCacheKeys);
    setCachedState({ key: currentCacheKey, value: cached ?? fallback, hasCachedValue: cached !== null });
  }, [cacheKey, currentCacheKey, fallback, fallbackCacheKeySignature]);

  useEffect(() => {
    if (loading) return;
    lastResolvedValueRef.current = { key: currentCacheKey, value: nextValue };
    setCachedState({ key: currentCacheKey, value: nextValue, hasCachedValue: true });
    writeCachedValue(cacheKey, nextValue, mirrorCacheKeys);
  }, [cacheKey, currentCacheKey, loading, mirrorCacheKeySignature, nextValue]);

  const cachedValue = cachedState.key === currentCacheKey
    ? cachedState.value
    : readCachedValue(cacheKey, fallbackCacheKeys) ?? "";
  const hasCachedValue = cachedState.key === currentCacheKey
    ? cachedState.hasCachedValue
    : cachedValue !== "";
  const lastResolvedValue = lastResolvedValueRef.current.key === currentCacheKey
    ? lastResolvedValueRef.current.value
    : "";
  const loadingValue = hasCachedValue ? cachedValue : lastResolvedValue;
  const displayValue = loading ? loadingValue : nextValue;
  const isLoadingPlaceholder = loading && !displayValue;
  const previousDisplayRef = useRef(displayValue);
  const [animationState, setAnimationState] = useState({ key: 0, changed: false });

  useEffect(() => {
    if (previousDisplayRef.current === displayValue) return;
    previousDisplayRef.current = displayValue;
    if (loading) {
      setAnimationState((state) => ({ ...state, changed: false }));
      return;
    }
    setAnimationState((state) => ({ key: state.key + 1, changed: true }));
  }, [displayValue, loading]);

  return (
    <Component
      className={cn("forwardx-stat-value", className)}
      title={title}
      data-loading={loading ? "true" : "false"}
      data-empty={isLoadingPlaceholder ? "true" : "false"}
      data-changing={animationState.changed ? "true" : "false"}
    >
      <span
        key={animationState.key}
        className="forwardx-stat-value-inner"
        onAnimationEnd={() => setAnimationState((state) => (
          state.changed ? { ...state, changed: false } : state
        ))}
      >
        {isLoadingPlaceholder ? fallback : displayValue}
      </span>
    </Component>
  );
}
