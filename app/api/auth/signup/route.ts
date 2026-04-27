import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { createUser, getUserByEmail } from "@/lib/db";
import { signSession, setSessionCookie } from "@/lib/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  try {
    const { email, name, password } = (await req.json()) ?? {};
    if (!email || !name || !password)
      return NextResponse.json(
        { error: "email, name and password are required." },
        { status: 400 },
      );
    if (!EMAIL_RE.test(email))
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
    if (getUserByEmail(String(email).toLowerCase()))
      return NextResponse.json(
        { error: "An account with this email already exists." },
        { status: 409 },
      );

    const hash = await bcrypt.hash(String(password), 12);
    const user = createUser(
      randomUUID(),
      String(email).toLowerCase().trim(),
      String(name).trim(),
      hash,
    );
    const token = await signSession({
      sub: user.id,
      email: user.email,
      name: user.name,
      isAdmin: !!user.is_admin,
      plan: user.plan,
    });
    const res = NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          isAdmin: !!user.is_admin,
        },
      },
      { status: 201 },
    );
    setSessionCookie(res, token);
    return res;
  } catch (err) {
    console.error("[signup]", err);
    return NextResponse.json({ error: "Signup failed." }, { status: 500 });
  }
}
