/**
 * POST /api/payments/create
 * Body: { plan, currency, discountCode? }
 * Flow: validate → reserve → call NOWPayments → send payment OTP → return
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { getSession } from "@/lib/auth";
import {
  getUserById,
  createPaymentRecord,
  updatePaymentFromGateway,
  validateDiscountCode,
  redeemDiscountCode,
  upsertPaymentOtp,
  getPlanPrices,
  PLAN_DEFAULTS,
} from "@/lib/db";
import {
  createPayment,
  ACCEPTED_CURRENCIES,
  type PaidPlan,
} from "@/lib/payments";
import { sendOtpEmail } from "@/lib/email";

const OTP_EXPIRY_MIN = 10;

function generateOtp(): string {
  const buf = Buffer.allocUnsafe(4);
  crypto.getRandomValues(buf);
  return (buf.readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
}

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  const user = await getUserById(session.sub);
  if (!user)
    return NextResponse.json({ error: "User not found." }, { status: 401 });
  if (user.is_blocked)
    return NextResponse.json({ error: "Account suspended." }, { status: 403 });

  const b = await req.json().catch(() => ({}));
  const { plan, currency, discountCode } = b;

  if (!["pro", "business"].includes(plan))
    return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
  if (
    !ACCEPTED_CURRENCIES.find(
      (c) => c.symbol.toLowerCase() === currency?.toLowerCase(),
    )
  )
    return NextResponse.json(
      { error: "Unsupported currency." },
      { status: 400 },
    );

  // Don't allow downgrade
  const rank: Record<string, number> = {
    free: 0,
    pro: 1,
    business: 2,
    custom: 3,
  };
  if ((rank[user.plan] ?? 0) >= (rank[plan] ?? 0))
    return NextResponse.json(
      { error: `You are already on the ${user.plan} plan or higher.` },
      { status: 409 },
    );

  // Load live prices
  const prices = await getPlanPrices();
  let priceUsd = prices[plan] ?? (plan === "pro" ? 9 : 29);
  let discountPct = 0;
  let discountId = "";

  // Validate discount code
  if (discountCode) {
    const result = await validateDiscountCode(String(discountCode), plan);
    if (!result.valid)
      return NextResponse.json({ error: result.error }, { status: 400 });
    discountPct = result.row.discount_pct;
    discountId = result.row.id;
    priceUsd = +(priceUsd * (1 - discountPct / 100)).toFixed(2);
    if (priceUsd < 0.01) priceUsd = 0.01;
    await redeemDiscountCode(discountId);
  }

  const paymentId = randomUUID();
  const planLabel = PLAN_DEFAULTS[plan as PaidPlan]?.label ?? plan;

  // Create DB record
  await createPaymentRecord({
    id: paymentId,
    userId: session.sub,
    plan: plan as PaidPlan,
    priceUsd,
    discountCode: discountCode || null,
    discountPct,
  });

  // Call NOWPayments
  let nowPayment;
  try {
    nowPayment = await createPayment({
      plan: plan as PaidPlan,
      currency: currency.toLowerCase(),
      userId: session.sub,
      paymentId,
      priceUsd,
      description: `${planLabel} Plan — VaultChunk`,
    });
  } catch (err) {
    console.error("[payments/create] NOWPayments error:", err);
    return NextResponse.json(
      { error: "Payment gateway error. Please try again." },
      { status: 502 },
    );
  }

  await updatePaymentFromGateway({
    id: paymentId,
    nowPaymentId: nowPayment.payment_id,
    payAddress: nowPayment.pay_address,
    payAmount: nowPayment.pay_amount,
    payCurrency: nowPayment.pay_currency,
    expiresAt: nowPayment.expiration_estimate_date,
  });

  // Generate and send payment OTP (extra confirmation step)
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);
  const otpId = randomUUID();
  const otpHash = await bcrypt.hash(otp, 10);

  await upsertPaymentOtp({ id: otpId, paymentId, otpHash, expiresAt });

  try {
    await sendOtpEmail({
      to: user.email,
      otp,
      name: user.name,
      expiresMinutes: OTP_EXPIRY_MIN,
      subject: `${otp} — Confirm your VaultChunk payment`,
      headline: "Confirm your payment",
    });
  } catch (err) {
    console.error("[payments/create] OTP email failed:", err);
    // Don't block — user can request resend
  }

  return NextResponse.json({
    paymentId,
    nowPaymentId: nowPayment.payment_id,
    payAddress: nowPayment.pay_address,
    payAmount: nowPayment.pay_amount,
    payCurrency: nowPayment.pay_currency.toUpperCase(),
    priceUsd,
    originalPrice: prices[plan] ?? (plan === "pro" ? 9 : 29),
    discountPct,
    discountCode: discountCode || null,
    plan,
    planLabel,
    expiresAt: nowPayment.expiration_estimate_date ?? null,
    status: "waiting",
    otpRequired: true,
    otpExpiresAt: expiresAt.toISOString(),
  });
}
