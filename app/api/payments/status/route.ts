import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getPaymentById,
  updatePaymentStatus,
  setUserPlan,
  getUserById,
  getDailyUsed,
  getDailyLimitForUser,
  PLAN_DEFAULTS,
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

  const terminal = new Set([
    "finished",
    "failed",
    "refunded",
    "expired",
    "cancelled",
  ]);
  if (payment.now_payment_id && !terminal.has(payment.status)) {
    try {
      const live = await getPaymentStatus(payment.now_payment_id);
      if (live.payment_status !== payment.status) {
        await updatePaymentStatus(
          payment.now_payment_id,
          live.payment_status,
          live as unknown as object,
        );
        payment.status = live.payment_status;
        if (SUCCESS_STATUSES.has(live.payment_status))
          await setUserPlan(
            payment.user_id,
            payment.plan as "pro" | "business",
          );
      }
    } catch (err) {
      console.error("[payments/status] sync failed:", err);
    }
  }

  const user = await getUserById(session.sub);
  const [dailyUsed, dailyLimit] = user
    ? await Promise.all([getDailyUsed(user.id), getDailyLimitForUser(user.id)])
    : [0, PLAN_DEFAULTS.free.limitBytes];

  return NextResponse.json({
    payment: {
      id: payment.id,
      plan: payment.plan,
      status: payment.status,
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      payCurrency: payment.pay_currency?.toUpperCase(),
      priceUsd: payment.price_usd,
      discountPct: payment.discount_pct,
      discountCode: payment.discount_code,
      expiresAt: payment.expires_at,
      createdAt: payment.created_at,
      confirmedAt: payment.confirmed_at,
      cancelledAt: payment.cancelled_at,
    },
    user: user
      ? {
          plan: user.plan,
          planLabel: PLAN_DEFAULTS[user.plan]?.label ?? user.plan,
          planColor: PLAN_DEFAULTS[user.plan]?.color ?? "#5a6a7a",
          dailyUsed,
          dailyLimit,
          dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
        }
      : null,
  });
}
