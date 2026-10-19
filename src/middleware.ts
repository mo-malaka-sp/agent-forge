import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { readSession, SESSION_COOKIE } from "@/lib/auth/session";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/auth/login",
  "/api/health",
  "/api/saf-poc/agent-condition/tick",
  "/webhooks/saf",
  "/jwks",
]);

function isPublic(pathname: string): boolean {
  return (
    pathname.includes(".") ||
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/.well-known/") ||
    pathname.startsWith("/ssf/")
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const username = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (username) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  if (pathname !== "/") {
    login.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  }
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
