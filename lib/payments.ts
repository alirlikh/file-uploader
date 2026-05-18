import crypto from "crypto";

const API_BASE = "https://api.nowpayments.io/v1";
const API_KEY = process.env.NOWPAYMENTS_API_KEY ?? "";

export type PaidPlan = "pro" | "business";

export const ACCEPTED_CURRENCIES = [
  { symbol: "BTC", label: "Bitcoin", icon: "₿" },
  { symbol: "ETH", label: "Ethereum", icon: "Ξ" },
  { symbol: "USDT", label: "Tether (ERC-20)", icon: "₮" },
  { symbol: "USDC", label: "USD Coin", icon: "◎" },
  { symbol: "SOL", label: "Solana", icon: "◎" },
  { symbol: "LTC", label: "Litecoin", icon: "Ł" },
  { symbol: "BNB", label: "BNB", icon: "◆" },
  { symbol: "MATIC", label: "Polygon", icon: "◆" },
  { symbol: "TRX", label: "TRON (TRC-20)", icon: "◆" },
  { symbol: "DOGE", label: "Dogecoin", icon: "Ð" },
  { symbol: "TON", label: "Toncoin", icon: "◆" },
];

export interface NowPayment {
  payment_id: string;
  payment_status: NowPaymentStatus;
  pay_address: string;
  pay_amount: number;
  pay_currency: string;
  price_amount: number;
  price_currency: string;
  order_id: string;
  order_description: string;
  created_at: string;
  updated_at: string;
  expiration_estimate_date?: string;
}

export type NowPaymentStatus =
  | "waiting"
  | "confirming"
  | "confirmed"
  | "sending"
  | "partially_paid"
  | "finished"
  | "failed"
  | "refunded"
  | "expired";

export const SUCCESS_STATUSES = new Set<NowPaymentStatus>([
  "confirmed",
  "finished",
]);
export const TERMINAL_STATUSES = new Set<NowPaymentStatus>([
  "finished",
  "failed",
  "refunded",
  "expired",
]);

async function nowRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: object,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok)
    throw new Error(
      `NOWPayments ${method} ${path} → ${res.status}: ${await res.text().catch(() => "")}`,
    );
  return res.json() as Promise<T>;
}

export async function createPayment(opts: {
  plan: PaidPlan;
  currency: string;
  userId: string;
  paymentId: string;
  priceUsd: number;
  description: string;
}): Promise<NowPayment> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "";
  return nowRequest<NowPayment>("POST", "/payment", {
    price_amount: opts.priceUsd,
    price_currency: "usd",
    pay_currency: opts.currency.toLowerCase(),
    order_id: opts.paymentId,
    order_description: opts.description,
    ipn_callback_url: `${base}/api/payments/webhook`,
    success_url: `${process.env.NOWPAYMENTS_SUCCESS_URL ?? base}/pricing?payment_id=${opts.paymentId}`,
    cancel_url: process.env.NOWPAYMENTS_CANCEL_URL ?? `${base}/pricing`,
    is_fixed_rate: false,
    is_fee_paid_by_user: false,
  });
}

export async function getPaymentStatus(
  nowPaymentId: string,
): Promise<NowPayment> {
  return nowRequest<NowPayment>("GET", `/payment/${nowPaymentId}`);
}

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj && typeof obj === "object") {
    return Object.keys(obj as object)
      .sort()
      .reduce(
        (acc, key) => {
          (acc as Record<string, unknown>)[key] = sortKeysDeep(
            (obj as Record<string, unknown>)[key],
          );
          return acc;
        },
        {} as Record<string, unknown>,
      );
  }
  return obj;
}

export function verifyWebhookSignature(rawBody: string, sig: string): boolean {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) {
    console.error("[payments] NOWPAYMENTS_IPN_SECRET not set");
    return false;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const sorted = JSON.stringify(sortKeysDeep(parsed));
  const expected = crypto
    .createHmac("sha512", secret)
    .update(sorted)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(sig, "hex"),
    );
  } catch {
    return false;
  }
}
