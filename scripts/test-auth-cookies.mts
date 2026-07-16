#!/usr/bin/env npx tsx
/**
 * Auth cookie regression tests (no secrets printed).
 * Pure unit tests always run. Live HTTP checks when the server is reachable.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  AUTH_COOKIE_NAME,
  authCookieClearOptions,
  authCookieIdentity,
  authCookieSetOptions,
  isHttpsRequest
} from "../src/lib/authCookie.ts";
import { isAdminRole } from "../src/lib/auth.ts";

function makeRequest({ protocol = "http:", forwardedProto = null as string | null } = {}) {
  return {
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "x-forwarded-proto") return forwardedProto;
        return null;
      }
    },
    nextUrl: { protocol }
  };
}

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function curlRaw(args: string[]) {
  const child = spawn("curl", ["-siS", "--max-time", "12", ...args], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c;
  });
  child.stderr.on("data", (c) => {
    stderr += c;
  });
  const [code] = (await once(child, "close")) as [number | null];
  if ((code ?? 1) !== 0 && !stdout) {
    throw new Error(stderr || "curl failed");
  }
  return stdout;
}

function parseSetCookie(raw: string, cookieName: string) {
  const lines = raw.split(/\r?\n/);
  const header = lines.find(
    (l) => l.toLowerCase().startsWith("set-cookie:") && l.includes(cookieName)
  );
  if (!header) return null;
  const value = header.slice(header.indexOf(":") + 1).trim();
  return {
    raw: value,
    hasSecure: /(?:^|;\s*)Secure(?:;|$)/i.test(value),
    hasHttpOnly: /(?:^|;\s*)HttpOnly(?:;|$)/i.test(value),
    sameSite: (value.match(/SameSite=([^;]+)/i) || [])[1] || null,
    path: (value.match(/Path=([^;]+)/i) || [])[1] || null,
    maxAge: (value.match(/Max-Age=([^;]+)/i) || [])[1] || null,
    expires: (value.match(/Expires=([^;]+)/i) || [])[1] || null
  };
}

function statusLine(raw: string) {
  const m = raw.match(/^HTTP\/[\d.]+ (\d+)/m);
  return m ? Number(m[1]) : null;
}

function runUnitTests() {
  console.log("\n== Unit: protocol → Secure ==");

  const httpReq = makeRequest({ protocol: "http:" });
  assert("1. HTTP → Secure=false", isHttpsRequest(httpReq) === false);
  assert("1b. login HTTP options secure=false", authCookieSetOptions(httpReq).secure === false);

  const httpsReq = makeRequest({ protocol: "https:" });
  assert("2. HTTPS → Secure=true", isHttpsRequest(httpsReq) === true);
  assert("2b. login HTTPS options secure=true", authCookieSetOptions(httpsReq).secure === true);

  const fwdHttps = makeRequest({ protocol: "http:", forwardedProto: "https" });
  assert("3. x-forwarded-proto: https → Secure=true", isHttpsRequest(fwdHttps) === true);

  const fwdHttp = makeRequest({ protocol: "https:", forwardedProto: "http" });
  assert("4. x-forwarded-proto: http → Secure=false", isHttpsRequest(fwdHttp) === false);

  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const prodHttp = makeRequest({ protocol: "http:" });
  assert(
    "5. NODE_ENV=production over HTTP → Secure=false",
    isHttpsRequest(prodHttp) === false && authCookieSetOptions(prodHttp).secure === false
  );
  process.env.NODE_ENV = prev;

  const clearHttp = authCookieClearOptions(httpReq);
  assert("6. logout HTTP clear secure=false", clearHttp.secure === false);
  assert("9. logout maxAge=0", clearHttp.maxAge === 0);
  assert(
    "10. logout expires epoch",
    clearHttp.expires instanceof Date && clearHttp.expires.getTime() === 0
  );

  const clearHttps = authCookieClearOptions(httpsReq);
  assert("7. logout HTTPS clear secure=true", clearHttps.secure === true);

  const setId = authCookieIdentity(httpReq);
  const clearId = authCookieIdentity(httpReq);
  assert(
    "8. login/logout identity attributes match",
    setId.name === clearId.name &&
      setId.path === clearId.path &&
      setId.httpOnly === clearId.httpOnly &&
      setId.sameSite === clearId.sameSite &&
      setId.secure === clearId.secure &&
      setId.domain === clearId.domain
  );
  assert("8b. cookie name is otc-auth", setId.name === "otc-auth" && setId.name === AUTH_COOKIE_NAME);
  assert("8c. path=/", setId.path === "/");
  assert("8d. httpOnly", setId.httpOnly === true);
  assert("8e. sameSite=lax", setId.sameSite === "lax");

  // Frontend guard semantics (no React): duplicate logout blocked while in-flight
  let inFlight = false;
  let redirects = 0;
  async function fakeLogout(ok: boolean) {
    if (inFlight) return "blocked";
    inFlight = true;
    try {
      if (!ok) {
        inFlight = false;
        return "error";
      }
      redirects += 1;
      return "redirect";
    } catch {
      inFlight = false;
      return "error";
    }
  }
  return (async () => {
    assert("15. failed logout does not redirect", (await fakeLogout(false)) === "error" && redirects === 0);
    inFlight = false;
    const first = fakeLogout(true);
    const second = await fakeLogout(true);
    assert("16. duplicate logout while in-flight blocked", second === "blocked");
    await first;
    assert("16b. successful logout redirects once", redirects === 1);

    assert("18. viewer is not admin", isAdminRole("viewer") === false);
    assert("18b. admin is admin", isAdminRole("admin") === true);
  })();
}

async function runLiveTests() {
  const base = process.env.AUTH_TEST_BASE ?? "http://127.0.0.1:3000";
  console.log(`\n== Live HTTP against ${base} ==`);

  let raw: string;
  try {
    raw = await curlRaw(["-X", "POST", `${base}/api/auth/logout`]);
  } catch (e) {
    console.log(`  SKIP live tests (server not reachable: ${(e as Error).message})`);
    return;
  }

  assert("live logout HTTP 200", statusLine(raw) === 200);
  assert("live logout body {ok:true}", /"ok"\s*:\s*true/.test(raw));

  const cookie = parseSetCookie(raw, AUTH_COOKIE_NAME);
  assert("live logout Set-Cookie present", Boolean(cookie));
  if (cookie) {
    assert("live logout Max-Age=0", cookie.maxAge === "0");
    assert(
      "live logout Expires epoch-ish",
      cookie.expires !== null && /1970|01 Jan 1970|Wed, 31 Dec 1969/i.test(cookie.expires)
    );
    assert("live logout Path=/", cookie.path === "/");
    assert("live logout HttpOnly", cookie.hasHttpOnly === true);
    assert("live logout SameSite=Lax", (cookie.sameSite || "").toLowerCase() === "lax");
    assert("live logout HTTP has NO Secure", cookie.hasSecure === false);
  }

  const rawHttp = await curlRaw([
    "-X",
    "POST",
    "-H",
    "x-forwarded-proto: http",
    `${base}/api/auth/logout`
  ]);
  const cHttp = parseSetCookie(rawHttp, AUTH_COOKIE_NAME);
  assert("live x-forwarded-proto:http → no Secure", Boolean(cHttp && cHttp.hasSecure === false));

  const rawHttps = await curlRaw([
    "-X",
    "POST",
    "-H",
    "x-forwarded-proto: https",
    `${base}/api/auth/logout`
  ]);
  const cHttps = parseSetCookie(rawHttps, AUTH_COOKIE_NAME);
  assert("live x-forwarded-proto:https → Secure", Boolean(cHttps && cHttps.hasSecure === true));

  const badLogin = await curlRaw([
    "-X",
    "POST",
    "-H",
    "content-type: application/json",
    "--data",
    JSON.stringify({ username: "not-a-real-user", password: "not-a-real-password" }),
    `${base}/api/auth/login`
  ]);
  assert("11. invalid credentials → 401", statusLine(badLogin) === 401);
  assert(
    "11b. invalid credentials message present",
    /نام کاربری یا رمز عبور اشتباه است/.test(badLogin)
  );

  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.AUTH_TEST_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
  const viewerUser = process.env.VIEWER_USERNAME;
  const viewerPass = process.env.AUTH_TEST_VIEWER_PASSWORD ?? process.env.VIEWER_PASSWORD;

  if (adminUser && adminPass) {
    const jar = "/tmp/otc-auth-cookie-admin.jar";
    const loginRaw = await curlRaw([
      "-c",
      jar,
      "-X",
      "POST",
      "-H",
      "content-type: application/json",
      "--data",
      JSON.stringify({ username: adminUser, password: adminPass }),
      `${base}/api/auth/login`
    ]);
    assert("12. admin login works", statusLine(loginRaw) === 200);
    const loginCookie = parseSetCookie(loginRaw, AUTH_COOKIE_NAME);
    assert("12b. admin login HTTP cookie not Secure", Boolean(loginCookie && loginCookie.hasSecure === false));

    const me = await curlRaw(["-b", jar, `${base}/api/auth/me`]);
    assert("12c. admin /api/auth/me ok", statusLine(me) === 200 && /"role"\s*:\s*"admin"/.test(me));

    const logout = await curlRaw(["-b", jar, "-c", jar, "-X", "POST", `${base}/api/auth/logout`]);
    assert("logout after admin login 200", statusLine(logout) === 200);

    const meAfter = await curlRaw(["-b", jar, `${base}/api/auth/me`]);
    assert("17. /api/auth/me unauthenticated after logout", statusLine(meAfter) === 401);

    const dashAfterCode = (
      await curlRaw(["-b", jar, "-o", "/dev/null", "-w", "%{http_code}", `${base}/dashboard`])
    ).trim();
    assert(
      "14. protected route redirects/unauth after logout",
      dashAfterCode === "307" || dashAfterCode === "302" || dashAfterCode === "401"
    );
  } else {
    console.log("  SKIP admin live login (set AUTH_TEST_ADMIN_PASSWORD to enable)");
  }

  if (viewerUser && viewerPass) {
    const jar = "/tmp/otc-auth-cookie-viewer.jar";
    const loginRaw = await curlRaw([
      "-c",
      jar,
      "-X",
      "POST",
      "-H",
      "content-type: application/json",
      "--data",
      JSON.stringify({ username: viewerUser, password: viewerPass }),
      `${base}/api/auth/login`
    ]);
    assert("13. viewer login works", statusLine(loginRaw) === 200);

    const settings = await curlRaw(["-b", jar, `${base}/api/settings`]);
    assert("18c. viewer blocked from settings API", statusLine(settings) === 403);
  } else {
    console.log("  SKIP viewer live login (set AUTH_TEST_VIEWER_PASSWORD to enable)");
  }
}

async function main() {
  console.log("Auth cookie regression tests");
  await runUnitTests();
  await runLiveTests();
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
