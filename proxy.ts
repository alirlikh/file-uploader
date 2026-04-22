/**
 * proxy.ts
 *
 * Runs on the Edge runtime before every request.
 * Redirects unauthenticated users to /auth.
 * Redirects already-authenticated users away from /auth back to /.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";

const PUBLIC_PATHS = ["/auth", "/api/auth/login", "/api/auth/signup"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Let Next.js internals, static files, and favicon through
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/robots")
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get("vaultchunk_session")?.value ?? null;
  const session = token ? await verifySession(token) : null;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Not logged in → redirect to /auth (except for public paths + API)
  if (!session && !isPublic && !pathname.startsWith("/api/")) {
    return NextResponse.redirect(new URL("/auth", req.url));
  }

  // Already logged in → redirect away from /auth
  if (session && pathname === "/auth") {
    return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
