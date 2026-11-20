import { z } from "zod";

export const HOST_RENEWAL_CURRENCIES = ["CNY", "USD", "HKD", "EUR", "GBP", "JPY", "SGD", "TWD", "KRW", "AUD", "CAD", "CHF"] as const;
export const DEFAULT_HOST_RENEWAL_CURRENCY = HOST_RENEWAL_CURRENCIES[0];

export const hostRenewalCostSchema = z.object({
  amountCents: z.number().int().min(0).max(100_000_000),
  currency: z.enum(HOST_RENEWAL_CURRENCIES),
}).strict();

export type HostRenewalCost = z.infer<typeof hostRenewalCostSchema>;
