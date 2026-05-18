import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getUserById,
  getDailyUsed,
  getDailyLimitForUser,
  PLAN_DEFAULTS,
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
  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: user.is_admin,
      plan: user.plan,
      planLabel: PLAN_DEFAULTS[user.plan]?.label ?? user.plan,
      planColor: PLAN_DEFAULTS[user.plan]?.color ?? "#5a6a7a",
      customLimitBytes: user.custom_limit_bytes,
      dailyUsed,
      dailyLimit,
      dailyRemaining: Math.max(0, dailyLimit - dailyUsed),
    },
  });
}
