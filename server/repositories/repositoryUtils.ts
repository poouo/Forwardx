export { epochSeconds, sqlBool } from "../dbCompat";

export function clampPositiveInt(value: unknown, fallback: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function addMonthsClamped(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
}

export function nextMonthlyTrafficReset(start: Date, expiresAt: Date | null): Date | null {
  if (!expiresAt) return addMonthsClamped(start, 1);
  const next = addMonthsClamped(start, 1);
  return next.getTime() < expiresAt.getTime() ? next : null;
}
