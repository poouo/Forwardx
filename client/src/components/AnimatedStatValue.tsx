import { CountUp } from "countup.js";
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
  fallback: string,
  fallbackCacheKeys: string[] = [],
) {
  if (typeof window === "undefined") return fallback;
  try {
    const keys = [cacheKey, ...fallbackCacheKeys].filter((key): key is string => !!key);
    for (const key of keys) {
      const cached = window.localStorage.getItem(`${CACHE_PREFIX}${key}`);
      if (cached !== null && cached !== "") return cached;
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

type CountValue = {
  value: number;
  prefix: string;
  suffix: string;
  decimalPlaces: number;
};

function parseCountValue(value: string): CountValue | null {
  const matches = [...value.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const rawNumber = match[0];
  const numericValue = Number(rawNumber.replace(/,/g, ""));
  if (!Number.isFinite(numericValue)) return null;
  const decimalPart = rawNumber.split(".")[1] || "";
  return {
    value: numericValue,
    prefix: value.slice(0, match.index),
    suffix: value.slice((match.index || 0) + rawNumber.length),
    decimalPlaces: decimalPart.length,
  };
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
  const [cachedState, setCachedState] = useState(() => ({
    key: cacheKey || "",
    value: readCachedValue(cacheKey, fallback, fallbackCacheKeys),
  }));

  useEffect(() => {
    setCachedState({ key: cacheKey || "", value: readCachedValue(cacheKey, fallback, fallbackCacheKeys) });
  }, [cacheKey, fallback, fallbackCacheKeySignature]);

  useEffect(() => {
    if (loading) return;
    setCachedState({ key: cacheKey || "", value: nextValue });
    writeCachedValue(cacheKey, nextValue, mirrorCacheKeys);
  }, [cacheKey, loading, mirrorCacheKeySignature, nextValue]);

  const cachedValue = cachedState.key === (cacheKey || "")
    ? cachedState.value
    : readCachedValue(cacheKey, fallback, fallbackCacheKeys);
  const displayValue = loading ? cachedValue : nextValue;
  const countValue = useMemo(() => parseCountValue(displayValue), [displayValue]);
  const countTargetRef = useRef<HTMLSpanElement | null>(null);
  const previousCountRef = useRef<CountValue | null>(null);
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

  useEffect(() => {
    const target = countTargetRef.current;
    if (!target || !countValue) {
      previousCountRef.current = countValue;
      return;
    }

    const previous = previousCountRef.current;
    const canStartFromPrevious =
      !!previous &&
      previous.prefix === countValue.prefix &&
      previous.suffix === countValue.suffix &&
      previous.decimalPlaces === countValue.decimalPlaces;
    const startVal = canStartFromPrevious ? previous.value : loading ? countValue.value : 0;
    const duration = loading || startVal === countValue.value ? 0 : 0.8;
    const counter = new CountUp(target, countValue.value, {
      startVal,
      duration,
      decimalPlaces: countValue.decimalPlaces,
      separator: ",",
      decimal: ".",
      prefix: countValue.prefix,
      suffix: countValue.suffix,
      useGrouping: true,
    });

    if (counter.error) {
      target.textContent = displayValue;
    } else {
      counter.start();
    }
    previousCountRef.current = countValue;
  }, [countValue, displayValue, loading]);

  return (
    <Component
      className={cn("forwardx-stat-value", className)}
      title={title}
      data-loading={loading ? "true" : "false"}
      data-changing={animationState.changed ? "true" : "false"}
    >
      <span
        key={animationState.key}
        ref={countTargetRef}
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
