/**
 * lib/auth.ts
 *
 * Stateless JWT sessions stored in an HttpOnly cookie.
 * Uses the `jose` library (Edge-runtime compatible, no Node crypto dependency).
 *
 * Cookie name : vaultchunk_session
 * Token TTL   : 7 days
 * Algorithm   : HS256
 *
 * JWT payload:
 *   { sub: userId, email, name, iat, exp }
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "vaultchunk_session";
const TOKEN_TTL = "7d";
const secret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "CHANGE_THIS_IN_PRODUCTION_MINIMUM_32_CHARS_LONG",
);

// ── TYPES ─────────────────────────────────────────────────────────────────────

export interface SessionPayload extends JWTPayload {
  sub: string; // userId
  email: string;
  name: string;
}

// ── SIGN ──────────────────────────────────────────────────────────────────────

export async function signSession(payload: {
  sub: string;
  email: string;
  name: string;
}) {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secret);
}

// ── VERIFY ────────────────────────────────────────────────────────────────────

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

// ── COOKIE HELPERS ────────────────────────────────────────────────────────────

/**
 * Set the session cookie on a NextResponse.
 * Call this after login or signup.
 */
export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days in seconds
    path: "/",
  });
}

/**
 * Clear the session cookie (logout).
 */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(COOKIE_NAME, "", { maxAge: 0, path: "/" });
}

/**
 * Read and verify the session from the incoming request cookie.
 * Returns null if missing or invalid.
 */
export async function getSession(
  req: NextRequest,
): Promise<SessionPayload | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySession(token);
}

/**
 * Server-component helper: read session from the Next.js cookie store.
 * Only usable in Server Components / Route Handlers that can call cookies().
 */
export async function getServerSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySession(token);
}
