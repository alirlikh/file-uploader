/**
 * POST /api/auth/signup
 * Body: { email, name, password }
 * Returns: { user: { id, email, name } } + sets session cookie
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { createUser, getUserByEmail } from "@/lib/db";
import { signSession, setSessionCookie } from "@/lib/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, name, password } = body ?? {};

    // ── Validation ────────────────────────────────────────────────────────────
    if (!email || !name || !password) {
      return NextResponse.json(
        { error: "email, name and password are required." },
        { status: 400 },
      );
    }
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json(
        { error: "Invalid email address." },
        { status: 400 },
      );
    }
    if (typeof name !== "string" || name.trim().length < 2) {
      return NextResponse.json(
        { error: "Name must be at least 2 characters." },
        { status: 400 },
      );
    }
    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 },
      );
    }

    // ── Uniqueness ────────────────────────────────────────────────────────────
    if (getUserByEmail(email.toLowerCase())) {
      return NextResponse.json(
        { error: "An account with this email already exists." },
        { status: 409 },
      );
    }

    // ── Create user ────────────────────────────────────────────────────────────
    const passwordHash = await bcrypt.hash(password, 12);
    const user = createUser(
      randomUUID(),
      email.toLowerCase().trim(),
      name.trim(),
      passwordHash,
    );

    // ── Issue session ─────────────────────────────────────────────────────────
    const token = await signSession({
      sub: user.id,
      email: user.email,
      name: user.name,
    });
    const res = NextResponse.json(
      { user: { id: user.id, email: user.email, name: user.name } },
      { status: 201 },
    );
    setSessionCookie(res, token);
    return res;
  } catch (err) {
    console.error("[signup]", err);
    return NextResponse.json({ error: "Signup failed." }, { status: 500 });
  }
}
