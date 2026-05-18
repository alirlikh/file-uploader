/**
 * POST /api/payments/verify-otp
 * Body: { paymentId, otp }
 * Verifies the payment confirmation OTP. Once verified the UI shows the
 * crypto address and the payment proceeds normally.
 */
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getSession } from "@/lib/auth";
import {
  getPaymentById,
  getPaymentOtp,
  incrementPaymentOtpAttempts,
  deletePaymentOtp,
} from "@/lib/db";

const OTP_MAX_ATTEMPTS = 5;

export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session)
    return NextResponse.json({ error: "Login required." }, { status: 401 });

  const { paymentId, otp } = await req.json().catch(() => ({}));
  if (!paymentId || !otp)
    return NextResponse.json(
      { error: "paymentId and otp are required." },
      { status: 400 },
    );

  const payment = await getPaymentById(String(paymentId));
  if (!payment || payment.user_id !== session.sub)
    return NextResponse.json({ error: "Payment not found." }, { status: 404 });

  const otpRecord = await getPaymentOtp(String(paymentId));
  if (!otpRecord)
    return NextResponse.json(
      { error: "OTP not found. Request a new payment." },
      { status: 404 },
    );

  if (new Date(otpRecord.expires_at) < new Date())
    return NextResponse.json(
      { error: "OTP has expired. Request a new payment." },
      { status: 400 },
    );

  if (otpRecord.attempts >= OTP_MAX_ATTEMPTS)
    return NextResponse.json(
      { error: "Too many incorrect attempts." },
      { status: 429 },
    );

  const valid = await bcrypt.compare(String(otp).trim(), otpRecord.otp_hash);
  if (!valid) {
    const attempts = await incrementPaymentOtpAttempts(otpRecord.id);
    const remaining = OTP_MAX_ATTEMPTS - attempts;
    return NextResponse.json(
      {
        error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`,
        remaining,
      },
      { status: 400 },
    );
  }

  await deletePaymentOtp(String(paymentId));
  return NextResponse.json({ verified: true });
}
