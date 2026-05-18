/**
 * POST /api/auth/resend-otp
 * Body: { verificationId }
 * Response: { verificationId, expiresAt, emailHint }
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import {
  getPendingSignupById,
  upsertPendingSignup,
  pruneExpiredPending,
} from "@/lib/db";
import { sendOtpEmail } from "@/lib/email";

const OTP_EXPIRY_MIN = 10;

function generateOtp(): string {
  const buf = Buffer.allocUnsafe(4);
  crypto.getRandomValues(buf);
  return (buf.readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
}
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  const [d, ...tld] = (domain ?? "").split(".");
  const m = (s: string) =>
    (s[0] ?? "") + "*".repeat(Math.max(1, (s.length ?? 1) - 1));
  return `${m(local)}@${m(d)}.${tld.join(".")}`;
}

export async function POST(req: NextRequest) {
  try {
    const { verificationId } = await req.json().catch(() => ({}));
    if (!verificationId)
      return NextResponse.json(
        { error: "verificationId is required." },
        { status: 400 },
      );

    const pending = await getPendingSignupById(String(verificationId));
    if (!pending)
      return NextResponse.json(
        { error: "Verification session not found. Please sign up again." },
        { status: 404 },
      );

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);
    const newId = randomUUID();
    const otpHash = await bcrypt.hash(otp, 10);

    await pruneExpiredPending();
    await upsertPendingSignup({
      id: newId,
      email: pending.email,
      name: pending.name,
      passwordHash: pending.password_hash,
      otpHash,
      expiresAt,
    });

    await sendOtpEmail({
      to: pending.email,
      otp,
      name: pending.name,
      expiresMinutes: OTP_EXPIRY_MIN,
    });

    return NextResponse.json({
      verificationId: newId,
      expiresAt: expiresAt.toISOString(),
      emailHint: maskEmail(pending.email),
    });
  } catch (err) {
    console.error("[resend-otp]", err);
    return NextResponse.json(
      { error: "Failed to resend code." },
      { status: 500 },
    );
  }
}
