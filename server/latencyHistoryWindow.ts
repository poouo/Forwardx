import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { LATENCY_HISTORY_HOURS, latencyHistoryCacheOptions } from "../shared/latencyHistory";

export const latencyHistoryWindowInput = {
  hours: z.number().min(0.5).max(LATENCY_HISTORY_HOURS).default(24),
  startAt: z.date().optional(),
  endAt: z.date().optional(),
  dayBoundaries: z.array(z.date()).length(31).optional(),
  includeTrend: z.boolean().optional(),
};

export function resolveLatencyHistoryWindow(input: { hours?: number; startAt?: Date; endAt?: Date; dayBoundaries?: Date[]; includeTrend?: boolean }, now = Date.now()) {
  const hours = input.hours || 24;
  if (!!input.startAt !== !!input.endAt || (input.startAt && input.endAt && (
    input.startAt >= input.endAt || input.endAt.getTime() - input.startAt.getTime() > (LATENCY_HISTORY_HOURS + 2) * 3600_000
  ))) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid latency history time range" });
  if (input.dayBoundaries && (
    input.dayBoundaries.length !== 31 || input.dayBoundaries[0].getTime() !== input.startAt?.getTime()
    || input.dayBoundaries[30].getTime() !== input.endAt?.getTime()
    || input.dayBoundaries.some((day, index, days) => index > 0 && (
      day.getTime() - days[index - 1].getTime() < 20 * 3600_000
      || day.getTime() - days[index - 1].getTime() > 26 * 3600_000
    ))
  )) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid latency history dates" });
  const since = new Date(Math.max(
    input.startAt?.getTime() ?? now - hours * 3600_000,
    now - LATENCY_HISTORY_HOURS * 3600_000,
  ));
  const until = input.endAt || new Date(now + 1000);
  const historical = until.getTime() <= now;
  return {
    since, until,
    hours: input.startAt ? Math.max(0.5, (until.getTime() - since.getTime()) / 3600_000) : hours,
    cacheKey: `${hours}:${input.startAt?.getTime() || "rolling"}:${input.endAt?.getTime() || "now"}:${input.dayBoundaries?.map((day) => day.getTime()).join(",") || "chart"}:${input.includeTrend ? "trend" : "summary"}`,
    cacheOptions: latencyHistoryCacheOptions(historical || input.dayBoundaries ? 48 : hours),
    longHistory: historical || hours > 24 || !!input.dayBoundaries,
    dayBoundaries: input.dayBoundaries,
    includeTrend: !!input.includeTrend && !!input.dayBoundaries,
  };
}
