import { NextRequest, NextResponse } from "next/server";
import { getSession, clearSessionCookie } from "@/lib/auth";
import {
  getUserById,
  getDailyUsed,
  getDailyLimitForUser,
  PLANS,
} from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ user: null });

  const user = await getUserById(session.sub);
  if (!user || user.is_blocked) return NextResponse.json({ user: null });

  const [dailyUsed, dailyLimit] = await Promise.all([
    getDailyUsed(user.id),
    getDailyLimitForUser(user.id),
  ]);
  const dailyRemaining = Math.max(0, dailyLimit - dailyUsed);

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.is_admin,
      plan: user.plan,
      planLabel: PLANS[user.plan]?.label ?? user.plan,
      planColor: PLANS[user.plan]?.color ?? "#5a6a7a",
      customLimitBytes: user.custom_limit_bytes,
      dailyUsed,
      dailyLimit,
      dailyRemaining,
    },
  });
}

export async function POST() {
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
