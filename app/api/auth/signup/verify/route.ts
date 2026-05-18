/**
 * POST /api/auth/signup/verify
 * Body: { verificationId, otp }
 * Response: { user } + sets session cookie
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import {
  getPendingSignupById,
  incrementPendingAttempts,
  deletePendingSignup,
  createUser,
  PLAN_DEFAULTS,
} from "@/lib/db";
import { signSession, setSessionCookie } from "@/lib/auth";

const OTP_MAX_ATTEMPTS = 5;

export async function POST(req: NextRequest) {
  try {
    const { verificationId, otp } = await req.json().catch(() => ({}));

    if (!verificationId || !otp)
      return NextResponse.json(
        { error: "verificationId and otp are required." },
        { status: 400 },
      );

    const pending = await getPendingSignupById(String(verificationId));

    // Generic "invalid" response — don't reveal whether ID or OTP is wrong
    if (!pending)
      return NextResponse.json(
        {
          error: "Invalid or expired verification code. Please sign up again.",
        },
        { status: 400 },
      );

    // Expiry check
    if (new Date(pending.expires_at) < new Date()) {
      await deletePendingSignup(pending.id);
      return NextResponse.json(
        { error: "Verification code has expired. Please sign up again." },
        { status: 400 },
      );
    }

    // Attempt limit
    if (pending.attempts >= OTP_MAX_ATTEMPTS)
      return NextResponse.json(
        { error: "Too many incorrect attempts. Please sign up again." },
        { status: 429 },
      );

    // Verify OTP
    const valid = await bcrypt.compare(String(otp).trim(), pending.otp_hash);
    if (!valid) {
      const attempts = await incrementPendingAttempts(pending.id);
      const remaining = OTP_MAX_ATTEMPTS - attempts;
      return NextResponse.json(
        {
          error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`,
          remaining,
        },
        { status: 400 },
      );
    }

    // ── OTP correct — create the real user account ───────────────────────────
    const userId = randomUUID();
    const user = await createUser(
      userId,
      pending.email,
      pending.name,
      pending.password_hash,
    );

    // Mark verified (createUser sets is_verified=TRUE for first user/admin)
    // For regular users, is_verified starts FALSE in createUser, so we update it here
    await deletePendingSignup(pending.id);
    // Note: createUser sets is_verified=is_admin (TRUE for first user).
    // For normal users we need to explicitly verify:
    if (!user.is_verified) {
      const { query } = await import("@/lib/db");
      await query("UPDATE users SET is_verified=TRUE WHERE id=$1", [user.id]);
    }

    const token = await signSession({
      sub: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.is_admin,
      plan: user.plan,
    });

    const res = NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          isAdmin: user.is_admin,
          plan: user.plan,
          planLabel: PLAN_DEFAULTS[user.plan]?.label ?? user.plan,
        },
      },
      { status: 201 },
    );

    setSessionCookie(res, token);
    return res;
  } catch (err) {
    console.error("[signup/verify]", err);
    return NextResponse.json(
      { error: "Verification failed. Please try again." },
      { status: 500 },
    );
  }
}
