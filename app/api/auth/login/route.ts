/**
 * POST /api/auth/login
 * Body: { email, password }
 * Returns: { user: { id, email, name } } + sets session cookie
 */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getUserByEmail } from "@/lib/db";
import { signSession, setSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body ?? {};

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 },
      );
    }

    const user = getUserByEmail(String(email).toLowerCase());

    // Use constant-time compare even when user not found (timing-safe)
    const dummyHash =
      "$2a$12$invalidhashfortimingnopurpose000000000000000000000000";
    const hash = user?.password_hash ?? dummyHash;
    const match = await bcrypt.compare(String(password), hash);

    if (!user || !match) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 },
      );
    }

    const token = await signSession({
      sub: user.id,
      email: user.email,
      name: user.name,
    });
    const res = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name },
    });
    setSessionCookie(res, token);
    return res;
  } catch (err) {
    console.error("[login]", err);
    return NextResponse.json({ error: "Login failed." }, { status: 500 });
  }
}
