/**
 * lib/payments.ts — NOWPayments crypto payment gateway client.
 *
 * NOWPayments supports 300+ cryptocurrencies (BTC, ETH, USDT, SOL, LTC …).
 * No wallet management needed — they handle custody.
 *
 * Docs: https://documenter.getpostman.com/view/7907941/2s93JusNJt
 *
 * Environment variables required:
 *   NOWPAYMENTS_API_KEY     — from your NOWPayments dashboard
 *   NOWPAYMENTS_IPN_SECRET  — from Settings > IPN Secret in dashboard
 *   NOWPAYMENTS_SUCCESS_URL — where to redirect after payment confirmation
 *   NOWPAYMENTS_CANCEL_URL  — where to redirect if user cancels
 */

import crypto from "crypto";

const API_BASE = "https://api.nowpayments.io/v1";
const API_KEY = process.env.NOWPAYMENTS_API_KEY ?? "";

// ── Plan pricing (USD) ────────────────────────────────────────────────────────
// Prices are in USD; NOWPayments converts to the chosen cryptocurrency live.

export type PaidPlan = "pro" | "business";

export const PLAN_PRICES: Record<
  PaidPlan,
  {
    usd: number; // monthly price in USD
    label: string;
    description: string;
  }
> = {
  pro: {
    usd: 9,
    label: "Pro",
    description: "10 GB daily quota — VaultChunk Pro Plan",
  },
  business: {
    usd: 29,
    label: "Business",
    description: "50 GB daily quota — VaultChunk Business Plan",
  },
};

// Accepted currencies shown to the user (NOWPayments supports many more —
// add any symbol from https://api.nowpayments.io/v1/currencies)
export const ACCEPTED_CURRENCIES = [
  { symbol: "BTC", label: "Bitcoin", icon: "₿" },
  { symbol: "ETH", label: "Ethereum", icon: "Ξ" },
  { symbol: "USDT", label: "Tether (ERC-20)", icon: "₮" },
  { symbol: "USDC", label: "USD Coin", icon: "◎" },
  { symbol: "SOL", label: "Solana", icon: "◎" },
  { symbol: "LTC", label: "Litecoin", icon: "Ł" },
  { symbol: "BNB", label: "BNB", icon: "◆" },
  { symbol: "MATIC", label: "Polygon", icon: "◆" },
  { symbol: "TRX", label: "Tron (TRC-20)", icon: "◆" },
  { symbol: "DOGE", label: "Dogecoin", icon: "Ð" },
];

// ── NOWPayments response types ────────────────────────────────────────────────

export interface NowPayment {
  payment_id: string;
  payment_status: NowPaymentStatus;
  pay_address: string;
  pay_amount: number; // amount in selected crypto
  pay_currency: string; // e.g. "btc"
  price_amount: number; // USD amount
  price_currency: string; // "usd"
  order_id: string; // our internal paymentId
  order_description: string;
  created_at: string;
  updated_at: string;
  expiration_estimate_date?: string; // when the rate expires
  purchase_id?: string;
  network?: string;
}

export type NowPaymentStatus =
  | "waiting" // awaiting payment
  | "confirming" // payment detected, waiting for confirmations
  | "confirmed" // confirmed — plan should be activated
  | "sending" // funds being forwarded (not relevant for us)
  | "partially_paid" // user sent less than required
  | "finished" // completed
  | "failed" // payment failed
  | "refunded" // refunded
  | "expired"; // payment window expired

// Terminal states — no further updates expected
export const TERMINAL_STATUSES = new Set<NowPaymentStatus>([
  "finished",
  "failed",
  "refunded",
  "expired",
]);

// States that mean the plan should be active
export const SUCCESS_STATUSES = new Set<NowPaymentStatus>([
  "confirmed",
  "finished",
]);

// ── API helpers ───────────────────────────────────────────────────────────────

async function nowRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: object,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NOWPayments ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Create a new payment for the given plan.
 * Returns the payment object with pay_address and pay_amount.
 */
export async function createPayment(opts: {
  plan: PaidPlan;
  currency: string; // e.g. "btc"
  userId: string;
  paymentId: string; // our DB row id — used as order_id for idempotency
}): Promise<NowPayment> {
  const price = PLAN_PRICES[opts.plan];
  return nowRequest<NowPayment>("POST", "/payment", {
    price_amount: price.usd,
    price_currency: "usd",
    pay_currency: opts.currency.toLowerCase(),
    order_id: opts.paymentId, // echoed back in webhooks
    order_description: price.description,
    ipn_callback_url: `${process.env.NOWPAYMENTS_SUCCESS_URL?.replace(/\/[^/]*$/, "")}/api/payments/webhook`,
    success_url: `${process.env.NOWPAYMENTS_SUCCESS_URL}?payment_id=${opts.paymentId}`,
    cancel_url:
      process.env.NOWPAYMENTS_CANCEL_URL ??
      process.env.NEXT_PUBLIC_BASE_URL ??
      "",
    // Metadata we can read back in webhooks
    is_fixed_rate: false,
    is_fee_paid_by_user: false,
  });
}

/**
 * Fetch the current status of a payment from NOWPayments.
 */
export async function getPaymentStatus(
  nowPaymentId: string,
): Promise<NowPayment> {
  return nowRequest<NowPayment>("GET", `/payment/${nowPaymentId}`);
}

/**
 * Verify the HMAC-SHA-512 signature on incoming IPN (webhook) requests.
 * NOWPayments signs the body with your IPN_SECRET.
 *
 * Always call this before processing any webhook to prevent spoofing.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
): boolean {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) {
    console.error(
      "[payments] NOWPAYMENTS_IPN_SECRET is not set — rejecting webhook",
    );
    return false;
  }
  // NOWPayments sorts keys alphabetically before signing
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

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signatureHeader, "hex"),
  );
}

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === "object") {
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
