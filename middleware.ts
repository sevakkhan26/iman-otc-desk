import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, isAuthenticated } from "@/lib/auth";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const loggedIn = isAuthenticated(request.cookies.get(AUTH_COOKIE)?.value);

  // auth endpoints stay reachable for login/logout
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

  if (loggedIn) {
    return NextResponse.next();
  }

  // protected data APIs: return 401 JSON instead of a redirect
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized", message: "ابتدا وارد شوید" }, { status: 401 });
  }

  // protected pages → login
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  // everything except Next static/image assets and public files (fonts, icons)
  matcher: ["/((?!_next/static|_next/image|fonts/|icon\\.svg|favicon\\.ico|robots\\.txt).*)"]
};
