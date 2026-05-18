/**
 * POST /api/auth/signup/request
 * Body: { email, name, password }
 * Response: { verificationId, expiresAt, emailHint }
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import {
  getUserByEmail,
  upsertPendingSignup,
  pruneExpiredPending,
} from "@/lib/db";
import { sendOtpEmail } from "@/lib/email";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_EXPIRY_MIN = 10;
const OTP_COST = 10;

function generateOtp(): string {
  // Cryptographically secure 6-digit code
  const buf = Buffer.allocUnsafe(4);
  crypto.getRandomValues(buf);
  return (buf.readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  const [domainName, ...tld] = (domain ?? "").split(".");
  const mask = (s: string) =>
    (s[0] ?? "") + "*".repeat(Math.max(1, (s.length ?? 1) - 1));
  return `${mask(local)}@${mask(domainName)}.${tld.join(".")}`;
}

export async function POST(req: NextRequest) {
  try {
    const { email, name, password } = await req.json().catch(() => ({}));

    if (!email || !name || !password)
      return NextResponse.json(
        { error: "Email, name and password are required." },
        { status: 400 },
      );
    if (!EMAIL_RE.test(String(email)))
      return NextResponse.json(
        { error: "Invalid email address." },
        { status: 400 },
      );
    if (String(name).trim().length < 2)
      return NextResponse.json(
        { error: "Name must be at least 2 characters." },
        { status: 400 },
      );
    if (String(password).length < 8)
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 },
      );

    const normalEmail = String(email).toLowerCase().trim();
    const trimmedName = String(name).trim();

    // Block already-verified accounts
    const existing = await getUserByEmail(normalEmail);
    if (existing?.is_verified)
      return NextResponse.json(
        { error: "An account with this email already exists. Please sign in." },
        { status: 409 },
      );

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);
    const id = randomUUID();

    const [passwordHash, otpHash] = await Promise.all([
      bcrypt.hash(String(password), 12),
      bcrypt.hash(otp, OTP_COST),
    ]);

    await pruneExpiredPending();
    await upsertPendingSignup({
      id,
      email: normalEmail,
      name: trimmedName,
      passwordHash,
      otpHash,
      expiresAt,
    });

    try {
      await sendOtpEmail({
        to: normalEmail,
        otp,
        name: trimmedName,
        expiresMinutes: OTP_EXPIRY_MIN,
      });
    } catch (err) {
      console.error("[signup/request] Email failed:", err);
      return NextResponse.json(
        {
          error:
            "Failed to send verification email. Check your address and try again.",
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      verificationId: id,
      expiresAt: expiresAt.toISOString(),
      emailHint: maskEmail(normalEmail),
    });
  } catch (err) {
    console.error("[signup/request]", err);
    return NextResponse.json({ error: "Signup failed." }, { status: 500 });
  }
}
