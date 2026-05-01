import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";

// Paths that don't require authentication
const PUBLIC_PATHS = [
  "/auth",
  "/pricing", // public pricing page
  "/api/auth/login",
  "/api/auth/signup",
  "/api/payments/webhook", // NOWPayments IPN — no cookie auth
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Let Next.js internals and static files through
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon"))
    return NextResponse.next();

  const token = req.cookies.get("vaultchunk_session")?.value ?? null;
  const session = token ? await verifySession(token) : null;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Unauthenticated → redirect to /auth (except public paths and API routes)
  if (!session && !isPublic && !pathname.startsWith("/api/")) {
    return NextResponse.redirect(new URL("/auth", req.url));
  }

  // Already logged in → redirect away from /auth
  if (session && pathname === "/auth") {
    return NextResponse.redirect(new URL("/", req.url));
  }

  // Admin-only area
  if (pathname.startsWith("/admin") && !pathname.startsWith("/api/admin")) {
    if (!session?.isAdmin) return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
