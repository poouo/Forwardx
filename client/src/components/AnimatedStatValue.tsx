import { useEffect, useMemo, useRef, useState, type ElementType } from "react";
import { cn } from "@/lib/utils";

const CACHE_PREFIX = "forwardx.stat.";

type AnimatedStatValueProps = {
  value: string | number | null | undefined;
  loading?: boolean;
  cacheKey?: string;
  fallbackValue?: string | number | null;
  as?: ElementType;
  className?: string;
  title?: string;
};

function textValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "0";
  return String(value);
}

function readCachedValue(cacheKey: string | undefined, fallback: string) {
  if (!cacheKey || typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(`${CACHE_PREFIX}${cacheKey}`) || fallback;
  } catch {
    return fallback;
  }
}

function writeCachedValue(cacheKey: string | undefined, value: string) {
  if (!cacheKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${CACHE_PREFIX}${cacheKey}`, value);
  } catch {
    // The value is purely presentational, so private-mode storage failures can be ignored.
  }
}

export default function AnimatedStatValue({
  value,
  loading = false,
  cacheKey,
  fallbackValue,
  as: Component = "span",
  className,
  title,
}: AnimatedStatValueProps) {
  const nextValue = textValue(value);
  const fallback = useMemo(() => textValue(fallbackValue ?? value), [fallbackValue, value]);
  const [cachedState, setCachedState] = useState(() => ({
    key: cacheKey || "",
    value: readCachedValue(cacheKey, fallback),
  }));

  useEffect(() => {
    setCachedState({ key: cacheKey || "", value: readCachedValue(cacheKey, fallback) });
  }, [cacheKey, fallback]);

  useEffect(() => {
    if (loading) return;
    setCachedState({ key: cacheKey || "", value: nextValue });
    writeCachedValue(cacheKey, nextValue);
  }, [cacheKey, loading, nextValue]);

  const cachedValue = cachedState.key === (cacheKey || "")
    ? cachedState.value
    : readCachedValue(cacheKey, fallback);
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
      className={cn("forwardx-stat-value", loading && "text-muted-foreground/80", className)}
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
