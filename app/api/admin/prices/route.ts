/**
 * GET  /api/admin/prices        — current plan prices
 * PATCH /api/admin/prices       — update one or more prices
 * Body: { prices: { pro?: number, business?: number } }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getPlanPrices, updatePlanPrice } from "@/lib/db";

export async function GET() {
  const prices = await getPlanPrices();
  return NextResponse.json({ prices });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession(req);
  if (!session?.isAdmin)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });

  const { prices } = await req.json().catch(() => ({ prices: {} }));
  if (!prices || typeof prices !== "object")
    return NextResponse.json(
      { error: "prices object required." },
      { status: 400 },
    );

  const allowed = ["pro", "business"];
  for (const [plan, price] of Object.entries(prices)) {
    if (!allowed.includes(plan)) continue;
    const usd = Number(price);
    if (!isFinite(usd) || usd <= 0)
      return NextResponse.json(
        { error: `Invalid price for ${plan}.` },
        { status: 400 },
      );
    await updatePlanPrice(plan, usd, session.sub);
  }

  const updated = await getPlanPrices();
  return NextResponse.json({ prices: updated });
}
