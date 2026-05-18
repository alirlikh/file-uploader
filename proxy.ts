import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";

const PUBLIC_PATHS = [
  "/auth",
  "/pricing",
  "/api/auth/login",
  "/api/auth/signup/request",
  "/api/auth/signup/verify",
  "/api/auth/resend-otp",
  "/api/payments/webhook",
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon"))
    return NextResponse.next();

  const token = req.cookies.get("vaultchunk_session")?.value ?? null;
  const session = token ? await verifySession(token) : null;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!session && !isPublic && !pathname.startsWith("/api/"))
    return NextResponse.redirect(new URL("/auth", req.url));

  if (session && pathname === "/auth")
    return NextResponse.redirect(new URL("/", req.url));

  if (pathname.startsWith("/admin") && !pathname.startsWith("/api/admin")) {
    if (!session?.isAdmin) return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
