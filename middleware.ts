import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, getRoleFromCookie } from "@/lib/auth";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const role = getRoleFromCookie(request.cookies.get(AUTH_COOKIE)?.value);
  const loggedIn = role !== null;
  const method = request.method.toUpperCase();

  // auth endpoints stay reachable for login/logout/session
  if (pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  // already logged in → keep /login out of the way
  if (pathname === "/login") {
    if (loggedIn) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    return NextResponse.next();
  }

  if (!loggedIn) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized", message: "ابتدا وارد شوید" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (role === "viewer") {
    if (pathname === "/settings" || pathname.startsWith("/settings/")) {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }

    if (pathname === "/api/settings" || pathname.startsWith("/api/settings/")) {
      return NextResponse.json({ error: "forbidden", message: "دسترسی مجاز نیست" }, { status: 403 });
    }

    if (pathname.startsWith("/api/") && !READ_METHODS.has(method)) {
      return NextResponse.json({ error: "forbidden", message: "دسترسی فقط خواندنی" }, { status: 403 });
    }
  }

  return NextResponse.next();
}

export const config = {
  // everything except Next static/image assets and public files (fonts, icons)
  matcher: ["/((?!_next/static|_next/image|fonts/|icon\\.svg|favicon\\.ico|robots\\.txt).*)"]
};