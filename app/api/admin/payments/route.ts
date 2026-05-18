import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAllPayments } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session?.isAdmin)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const limit = parseInt(
    new URL(req.url).searchParams.get("limit") ?? "200",
    10,
  );

  const payments = await getAllPayments(limit);
  return NextResponse.json({
    payments: payments.map((p) => ({
      id: p.id,
      userId: p.user_id,
      userEmail: p.user_email,
      userName: p.user_name,
      plan: p.plan,
      status: p.status,
      priceUsd: p.price_usd,
      discountCode: p.discount_code,
      discountPct: p.discount_pct,
      finalUsd: Number(p.price_usd) * (1 - (p.discount_pct ?? 0) / 100),
      payCurrency: p.pay_currency?.toUpperCase() ?? null,
      payAmount: p.pay_amount,
      createdAt: p.created_at,
      confirmedAt: p.confirmed_at,
      cancelledAt: p.cancelled_at,
    })),
  });
}
