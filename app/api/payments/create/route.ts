/**
 * POST /api/payments/create
 *
 * Creates a crypto payment for a plan upgrade.
 *
 * Body: { plan: "pro"|"business", currency: "btc"|"eth"|... }
 *
 * Flow:
 *  1. Validate user is authenticated and not already on this plan
 *  2. Insert a pending payment row in DB
 *  3. Call NOWPayments API to get the crypto address + amount
 *  4. Update DB row with NOWPayments response
 *  5. Return payment details to client (address, amount, currency, QR data)
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSession } from "@/lib/auth";
import {
  getUserById,
  createPaymentRecord,
  updatePaymentFromGateway,
} from "@/lib/db";
import {
  createPayment,
  PLAN_PRICES,
  ACCEPTED_CURRENCIES,
  type PaidPlan,
} from "@/lib/payments";

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  const user = await getUserById(session.sub);
  if (!user)
    return NextResponse.json({ error: "User not found." }, { status: 401 });
  if (user.is_blocked)
    return NextResponse.json({ error: "Account suspended." }, { status: 403 });

  let body: { plan: string; currency: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const { plan, currency } = body;

  // Validate plan
  if (!["pro", "business"].includes(plan))
    return NextResponse.json(
      { error: "Invalid plan. Choose pro or business." },
      { status: 400 },
    );

  // Validate currency
  const validCurrencies = ACCEPTED_CURRENCIES.map((c) =>
    c.symbol.toLowerCase(),
  );
  if (!validCurrencies.includes(currency?.toLowerCase()))
    return NextResponse.json(
      { error: "Unsupported currency." },
      { status: 400 },
    );

  // Don't allow paying for the same or lower plan
  const planRank: Record<string, number> = {
    free: 0,
    pro: 1,
    business: 2,
    custom: 3,
  };
  if ((planRank[user.plan] ?? 0) >= (planRank[plan] ?? 0)) {
    return NextResponse.json(
      { error: `You are already on the ${user.plan} plan or higher.` },
      { status: 409 },
    );
  }

  const paidPlan = plan as PaidPlan;
  const price = PLAN_PRICES[paidPlan];
  const paymentId = randomUUID();

  // Step 1: create DB record immediately (idempotency anchor)
  await createPaymentRecord({
    id: paymentId,
    userId: session.sub,
    plan: paidPlan,
    priceUsd: price.usd,
  });

  // Step 2: call NOWPayments
  let nowPayment;
  try {
    nowPayment = await createPayment({
      plan: paidPlan,
      currency: currency.toLowerCase(),
      userId: session.sub,
      paymentId,
    });
  } catch (err) {
    console.error("[payments/create] NOWPayments error:", err);
    return NextResponse.json(
      { error: "Payment gateway error. Please try again." },
      { status: 502 },
    );
  }

  // Step 3: store NOWPayments response in DB
  await updatePaymentFromGateway({
    id: paymentId,
    nowPaymentId: nowPayment.payment_id,
    payAddress: nowPayment.pay_address,
    payAmount: nowPayment.pay_amount,
    payCurrency: nowPayment.pay_currency,
    expiresAt: nowPayment.expiration_estimate_date,
  });

  return NextResponse.json({
    paymentId,
    nowPaymentId: nowPayment.payment_id,
    payAddress: nowPayment.pay_address,
    payAmount: nowPayment.pay_amount,
    payCurrency: nowPayment.pay_currency.toUpperCase(),
    priceUsd: price.usd,
    plan: paidPlan,
    planLabel: price.label,
    expiresAt: nowPayment.expiration_estimate_date ?? null,
    status: "waiting",
  });
}
