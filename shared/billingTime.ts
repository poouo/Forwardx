export const BILLING_TIME_ZONE = "Asia/Shanghai";

export const BILLING_DATE_TIME_FORMAT_OPTIONS = {
  timeZone: BILLING_TIME_ZONE,
  hourCycle: "h23",
} satisfies Intl.DateTimeFormatOptions;

export type BillingCalendarParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const billingCalendarFormatter = new Intl.DateTimeFormat("en-US-u-nu-latn", {
  timeZone: BILLING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function validDate(value: Date | number | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid billing date");
  return date;
}

export function billingCalendarParts(value: Date | number | string): BillingCalendarParts {
  const parts = billingCalendarFormatter.formatToParts(validDate(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const numeric = Number(parts.find((part) => part.type === type)?.value);
    if (!Number.isFinite(numeric)) throw new RangeError(`Missing billing date part: ${type}`);
    return numeric;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

export function billingDaysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function billingDateTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
) {
  if (![year, month, day, hour, minute, second, millisecond].every(Number.isInteger)) {
    throw new RangeError("Invalid billing calendar date");
  }
  if (month < 1 || month > 12 || day < 1 || day > billingDaysInMonth(year, month)) {
    throw new RangeError("Billing calendar date is out of range");
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59 || millisecond < 0 || millisecond > 999) {
    throw new RangeError("Billing calendar time is out of range");
  }

  const targetWallClockMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let candidateMs = targetWallClockMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = billingCalendarParts(candidateMs);
    const renderedWallClockMs = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second,
      millisecond,
    );
    const adjustmentMs = targetWallClockMs - renderedWallClockMs;
    candidateMs += adjustmentMs;
    if (adjustmentMs === 0) break;
  }
  return new Date(candidateMs);
}

export function billingStartOfDay(year: number, month: number, day: number) {
  return billingDateTime(year, month, day);
}

export function billingStartOfCalendarDay(value: Date | number | string) {
  const { year, month, day } = billingCalendarParts(value);
  return billingStartOfDay(year, month, day);
}

export function billingAddMonthsClamped(value: Date | number | string, months: number) {
  const date = validDate(value);
  const current = billingCalendarParts(date);
  const monthIndex = current.year * 12 + current.month - 1 + Math.trunc(months);
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const day = Math.min(current.day, billingDaysInMonth(year, month));
  return billingDateTime(
    year,
    month,
    day,
    current.hour,
    current.minute,
    current.second,
    date.getMilliseconds(),
  );
}

export function billingMonthStart(reference: Date | number | string) {
  const { year, month } = billingCalendarParts(reference);
  return billingStartOfDay(year, month, 1);
}

export function billingMonthlyBoundary(
  reference: Date | number | string,
  resetDay: unknown,
  monthOffset = 0,
  maximumResetDay = 28,
) {
  const current = billingCalendarParts(reference);
  const monthIndex = current.year * 12 + current.month - 1 + Math.trunc(monthOffset);
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const maximum = Math.max(1, Math.floor(Number(maximumResetDay) || 1));
  const requested = Math.max(1, Math.floor(Number(resetDay) || 1));
  const day = Math.min(requested, maximum, billingDaysInMonth(year, month));
  return billingStartOfDay(year, month, day);
}
