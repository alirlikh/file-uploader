/**
 * POST /api/payments/cancel
 * Body: { paymentId }
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { cancelPayment } from "@/lib/db";

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });
  const { paymentId } = await req.json().catch(() => ({}));
  if (!paymentId)
    return NextResponse.json({ error: "paymentId required." }, { status: 400 });
  const payment = await cancelPayment(String(paymentId), session.sub);
  if (!payment)
    return NextResponse.json(
      { error: "Payment not found or cannot be cancelled." },
      { status: 404 },
    );
  return NextResponse.json({ ok: true });
}
