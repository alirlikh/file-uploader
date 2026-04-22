/**
 * POST /api/auth/logout — clears session cookie
 * GET  /api/auth/me    — returns current user from session
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession, clearSessionCookie } from "@/lib/auth";
import { getUserById, getDailyUsed, getDailyLimit } from "@/lib/db";

// POST /api/auth/logout
export async function POST(_req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}

// GET /api/auth/me
export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ user: null });

  const user = getUserById(session.sub);
  if (!user) return NextResponse.json({ user: null });

  const dailyUsed = getDailyUsed(user.id);
  const dailyLimit = getDailyLimit();

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      dailyUsed,
      dailyLimit,
      dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
    },
  });
}
