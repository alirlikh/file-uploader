import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAllUsersForAdmin, getGlobalStats, PLAN_DEFAULTS } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session?.isAdmin)
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  const [users, stats] = await Promise.all([
    getAllUsersForAdmin(),
    getGlobalStats(),
  ]);
  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      isAdmin: u.is_admin,
      isBlocked: u.is_blocked,
      isVerified: u.is_verified,
      plan: u.plan,
      planLabel: PLAN_DEFAULTS[u.plan]?.label ?? u.plan,
      planColor: PLAN_DEFAULTS[u.plan]?.color ?? "#5a6a7a",
      customLimitBytes: u.custom_limit_bytes,
      fileCount: Number(u.file_count),
      totalBytesStored: Number(u.total_bytes_stored),
      bytesUsedToday: Number(u.bytes_used_today),
      createdAt: u.created_at,
    })),
    stats,
  });
}
