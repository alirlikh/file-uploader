/**
 * POST /api/payments/webhook
 *
 * NOWPayments IPN (Instant Payment Notification) handler.
 *
 * NOWPayments POSTs here every time a payment status changes.
 * We verify the HMAC-SHA-512 signature, update our DB, and
 * upgrade the user's plan when the payment is confirmed/finished.
 *
 * IMPORTANT: This endpoint MUST be publicly reachable (no auth cookie needed).
 * Add it to your middleware public paths list.
 *
 * NOWPayments IPN body shape (key fields):
 * {
 *   payment_id:     "5813095",
 *   payment_status: "confirmed",
 *   order_id:       "<our paymentId UUID>",
 *   pay_amount:     0.00021,
 *   pay_currency:   "btc",
 *   actually_paid:  0.00021,
 *   ...
 * }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  verifyWebhookSignature,
  SUCCESS_STATUSES,
  type NowPaymentStatus,
} from "@/lib/payments";
import { updatePaymentStatus, setUserPlan, getPaymentById } from "@/lib/db";

export async function POST(req: NextRequest) {
  // Read raw body for signature verification
  const rawBody = await req.text();
  const sig = req.headers.get("x-nowpayments-sig") ?? "";

  // ── Signature check ─────────────────────────────────────────────────────────
  if (!verifyWebhookSignature(rawBody, sig)) {
    console.warn("[webhook] Invalid signature — rejected");
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const nowPaymentId = String(payload.payment_id ?? "");
  const status = String(payload.payment_status ?? "") as NowPaymentStatus;
  const orderId = String(payload.order_id ?? ""); // our paymentId UUID

  if (!nowPaymentId || !status) {
    return NextResponse.json(
      { error: "Missing payment_id or status." },
      { status: 400 },
    );
  }

  console.log(
    `[webhook] payment ${nowPaymentId} order=${orderId} status=${status}`,
  );

  // ── Update DB ────────────────────────────────────────────────────────────────
  const payment = await updatePaymentStatus(nowPaymentId, status, payload);

  if (!payment) {
    // Could be a payment created outside this system — ignore gracefully
    console.warn(
      `[webhook] No payment record found for now_payment_id=${nowPaymentId}`,
    );
    return NextResponse.json({ ok: true });
  }

  // ── Upgrade plan on success ──────────────────────────────────────────────────
  if (SUCCESS_STATUSES.has(status)) {
    try {
      await setUserPlan(payment.user_id, payment.plan as "pro" | "business");
      console.log(
        `[webhook] Upgraded user ${payment.user_id} to ${payment.plan}`,
      );
    } catch (err) {
      console.error("[webhook] Failed to upgrade plan:", err);
      // Return 500 so NOWPayments retries the webhook
      return NextResponse.json(
        { error: "Plan upgrade failed." },
        { status: 500 },
      );
    }
  }

  // ── Handle partial payment ───────────────────────────────────────────────────
  if (status === "partially_paid") {
    console.warn(
      `[webhook] Partial payment for order ${orderId} — user must top up`,
    );
    // We don't upgrade the plan; the IPN will fire again if they complete payment
  }

  // NOWPayments expects a 200 to stop retrying
  return NextResponse.json({ ok: true });
}
