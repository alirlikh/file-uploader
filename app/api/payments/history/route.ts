/**
 * GET /api/payments/history
 * Returns all payments for the authenticated user, newest first.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getPaymentsByUser } from "@/lib/db";
import { PLAN_PRICES } from "@/lib/payments";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  const payments = await getPaymentsByUser(session.sub);

  return NextResponse.json({
    payments: payments.map((p) => ({
      id: p.id,
      plan: p.plan,
      planLabel:
        PLAN_PRICES[p.plan as keyof typeof PLAN_PRICES]?.label ?? p.plan,
      status: p.status,
      payAddress: p.pay_address,
      payAmount: p.pay_amount,
      payCurrency: p.pay_currency?.toUpperCase() ?? null,
      priceUsd: p.price_usd,
      expiresAt: p.expires_at,
      createdAt: p.created_at,
      confirmedAt: p.confirmed_at,
    })),
  });
}
