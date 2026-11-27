export const PAYMENT_TYPES = ["alipay", "wxpay", "stripe", "paypal", "usdt"] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const PAYPAL_CURRENCIES = [
  "USD", "CNY", "HKD", "EUR", "GBP", "SGD", "AUD", "CAD", "CHF", "BRL",
  "CZK", "DKK", "ILS", "MYR", "MXN", "NZD", "NOK", "PHP", "PLN", "SEK", "THB",
] as const;
export type PayPalCurrency = (typeof PAYPAL_CURRENCIES)[number];

export function paymentMethodSupportsCurrency(method: { value: PaymentType; currency?: string }, currency = "CNY") {
  return method.value !== "paypal" || currency.toUpperCase() === "CNY" || method.currency === currency.toUpperCase();
}
