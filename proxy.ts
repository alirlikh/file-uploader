import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";

const PUBLIC = ["/auth", "/api/auth/login", "/api/auth/signup"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon"))
    return NextResponse.next();

  const token = req.cookies.get("vaultchunk_session")?.value ?? null;
  const session = token ? await verifySession(token) : null;
  const isPublic = PUBLIC.some((p) => pathname.startsWith(p));

  if (!session && !isPublic && !pathname.startsWith("/api/"))
    return NextResponse.redirect(new URL("/auth", req.url));

  if (session && pathname === "/auth")
    return NextResponse.redirect(new URL("/", req.url));

  // Admin-only area
  if (pathname.startsWith("/admin") && !pathname.startsWith("/api/admin")) {
    if (!session?.isAdmin) return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
