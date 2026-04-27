/**
 * lib/auth.ts — Stateless JWT sessions in an HttpOnly cookie.
 * Payload: { sub: userId, email, name, isAdmin, plan }
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const COOKIE = "vaultchunk_session";
const TTL = "7d";
const secret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "CHANGE_THIS_IN_PRODUCTION_MINIMUM_32_CHARS_LONG",
);

export interface SessionPayload extends JWTPayload {
  sub: string;
  email: string;
  name: string;
  isAdmin: boolean;
  plan: string;
}

export async function signSession(p: {
  sub: string;
  email: string;
  name: string;
  isAdmin: boolean;
  plan: string;
}) {
  return new SignJWT({ ...p })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(secret);
}

export async function verifySession(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(COOKIE, "", { maxAge: 0, path: "/" });
}

export async function getSession(
  req: NextRequest,
): Promise<SessionPayload | null> {
  const token = req.cookies.get(COOKIE)?.value;
  return token ? verifySession(token) : null;
}

export async function getServerSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  return token ? verifySession(token) : null;
}
