import { clearSessionCookie } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

// POST /api/auth/logout
export async function POST(_req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
