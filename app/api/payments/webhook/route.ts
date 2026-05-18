import { NextRequest, NextResponse } from "next/server";
import {
  verifyWebhookSignature,
  SUCCESS_STATUSES,
  type NowPaymentStatus,
} from "@/lib/payments";
import { updatePaymentStatus, setUserPlan } from "@/lib/db";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-nowpayments-sig") ?? "";
  if (!verifyWebhookSignature(rawBody, sig)) {
    console.warn("[webhook] Invalid signature");
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
  if (!nowPaymentId || !status)
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });

  const payment = await updatePaymentStatus(nowPaymentId, status, payload);
  if (!payment) return NextResponse.json({ ok: true }); // unknown payment, ignore

  if (SUCCESS_STATUSES.has(status)) {
    try {
      await setUserPlan(payment.user_id, payment.plan as "pro" | "business");
    } catch (err) {
      console.error("[webhook] Plan upgrade failed:", err);
      return NextResponse.json(
        { error: "Plan upgrade failed." },
        { status: 500 },
      );
    }
  }
  return NextResponse.json({ ok: true });
}
