import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getUserByEmail } from "@/lib/db";
import { signSession, setSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json().catch(() => ({}));
    if (!email || !password)
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 },
      );

    const user = await getUserByEmail(String(email).toLowerCase());
    const dummy =
      "$2a$12$invalidhashfortimingprotection00000000000000000000000";
    const match = await bcrypt.compare(
      String(password),
      user?.password_hash ?? dummy,
    );

    if (!user || !match)
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 },
      );

    if (!user.is_verified)
      return NextResponse.json(
        {
          error: "Please verify your email before signing in.",
          unverified: true,
          email: user.email,
        },
        { status: 403 },
      );

    if (user.is_blocked)
      return NextResponse.json(
        { error: "Your account has been suspended. Contact support." },
        { status: 403 },
      );

    const token = await signSession({
      sub: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.is_admin,
      plan: user.plan,
    });
    const res = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin: user.is_admin,
      },
    });
    setSessionCookie(res, token);
    return res;
  } catch (err) {
    console.error("[login]", err);
    return NextResponse.json({ error: "Login failed." }, { status: 500 });
  }
}
