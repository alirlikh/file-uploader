/**
 * GET /api/payments/status?id=<paymentId>
 *
 * Polls our DB for the current payment status.
 * Also fetches live status from NOWPayments and syncs if different.
 * Used by the payment waiting UI to show real-time confirmation.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getPaymentById,
  updatePaymentStatus,
  setUserPlan,
  getUserById,
  getDailyUsed,
  getDailyLimitForUser,
  PLANS,
} from "@/lib/db";
import { getPaymentStatus, SUCCESS_STATUSES } from "@/lib/payments";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const payment = await getPaymentById(id);
  if (!payment || payment.user_id !== session.sub)
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });

  // Sync with NOWPayments if we have a gateway ID and it's not terminal
  const terminalStatuses = new Set([
    "finished",
    "failed",
    "refunded",
    "expired",
  ]);
  if (payment.now_payment_id && !terminalStatuses.has(payment.status)) {
    try {
      const live = await getPaymentStatus(payment.now_payment_id);
      if (live.payment_status !== payment.status) {
        await updatePaymentStatus(
          payment.now_payment_id,
          live.payment_status,
          live as unknown as object,
        );
        payment.status = live.payment_status;

        if (SUCCESS_STATUSES.has(live.payment_status)) {
          await setUserPlan(
            payment.user_id,
            payment.plan as "pro" | "business",
          );
        }
      }
    } catch (err) {
      console.error("[payments/status] Live sync failed:", err);
      // Return cached status from DB — don't fail the request
    }
  }

  // Refresh user data so the client gets updated plan/quota
  const user = await getUserById(session.sub);
  const [dailyUsed, dailyLimit] = user
    ? await Promise.all([getDailyUsed(user.id), getDailyLimitForUser(user.id)])
    : [0, PLANS.free.limitBytes];

  return NextResponse.json({
    payment: {
      id: payment.id,
      plan: payment.plan,
      status: payment.status,
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      payCurrency: payment.pay_currency?.toUpperCase(),
      priceUsd: payment.price_usd,
      expiresAt: payment.expires_at,
      createdAt: payment.created_at,
      confirmedAt: payment.confirmed_at,
    },
    // Updated user plan — client can refresh its state
    user: user
      ? {
          plan: user.plan,
          planLabel: PLANS[user.plan]?.label ?? user.plan,
          planColor: PLANS[user.plan]?.color ?? "#5a6a7a",
          dailyUsed,
          dailyLimit,
          dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
        }
      : null,
  });
}
