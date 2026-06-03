import { useEffect, useMemo, useRef, useState, type ElementType } from "react";
import { cn } from "@/lib/utils";

const CACHE_PREFIX = "forwardx.stat.";

type AnimatedStatValueProps = {
  value: string | number | null | undefined;
  loading?: boolean;
  cacheKey?: string;
  fallbackCacheKeys?: string[];
  mirrorCacheKeys?: string[];
  ignoredCachedValues?: string[];
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
  fallback: string,
  fallbackCacheKeys: string[] = [],
  ignoredCachedValues: string[] = [],
) {
  if (typeof window === "undefined") return fallback;
  try {
    const ignoredValues = new Set(ignoredCachedValues);
    const keys = [cacheKey, ...fallbackCacheKeys].filter((key): key is string => !!key);
    for (const key of keys) {
      const cached = window.localStorage.getItem(`${CACHE_PREFIX}${key}`);
      if (cached !== null && cached !== "" && !ignoredValues.has(cached)) return cached;
    }
    return fallback;
  } catch {
    return fallback;
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

function isIgnoredValue(value: string, ignoredCachedValues: string[]) {
  return ignoredCachedValues.includes(value);
}

export default function AnimatedStatValue({
  value,
  loading = false,
  cacheKey,
  fallbackCacheKeys = [],
  mirrorCacheKeys = [],
  ignoredCachedValues = [],
  fallbackValue,
  as: Component = "span",
  className,
  title,
}: AnimatedStatValueProps) {
  const nextValue = textValue(value);
  const fallback = useMemo(() => textValue(fallbackValue ?? value), [fallbackValue, value]);
  const fallbackCacheKeySignature = fallbackCacheKeys.join("\u0000");
  const mirrorCacheKeySignature = mirrorCacheKeys.join("\u0000");
  const ignoredCachedValueSignature = ignoredCachedValues.join("\u0000");
  const [cachedState, setCachedState] = useState(() => ({
    key: cacheKey || "",
    value: readCachedValue(cacheKey, fallback, fallbackCacheKeys, ignoredCachedValues),
  }));

  useEffect(() => {
    setCachedState({ key: cacheKey || "", value: readCachedValue(cacheKey, fallback, fallbackCacheKeys, ignoredCachedValues) });
  }, [cacheKey, fallback, fallbackCacheKeySignature, ignoredCachedValueSignature]);

  useEffect(() => {
    if (loading) return;
    setCachedState({ key: cacheKey || "", value: nextValue });
    if (isIgnoredValue(nextValue, ignoredCachedValues)) return;
    writeCachedValue(cacheKey, nextValue, mirrorCacheKeys);
  }, [cacheKey, ignoredCachedValueSignature, loading, mirrorCacheKeySignature, nextValue]);

  const cachedValue = cachedState.key === (cacheKey || "")
    ? cachedState.value
    : readCachedValue(cacheKey, fallback, fallbackCacheKeys, ignoredCachedValues);
  const displayValue = loading ? cachedValue : nextValue;
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
      data-changing={animationState.changed ? "true" : "false"}
    >
      <span
        key={animationState.key}
        className="forwardx-stat-value-inner"
        onAnimationEnd={() => setAnimationState((state) => (
          state.changed ? { ...state, changed: false } : state
        ))}
      >
        {displayValue}
      </span>
    </Component>
  );
}
