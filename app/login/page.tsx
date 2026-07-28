"use client";

import { useEffect, useState } from "react";
import { LogIn } from "lucide-react";
import { APP_VERSION } from "@/lib/version";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form-post error bounce: /login?error=1 (no useSearchParams — avoids Suspense requirement)
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("error") === "1") {
        setError(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(false);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ username, password })
      });
      if (response.ok) {
        // full navigation so the middleware picks up the fresh cookie
        window.location.replace("/dashboard");
        return;
      }
      setError(true);
    } catch {
      setError(true);
    }
    setSubmitting(false);
  }

  return (
    <main className="login-wrap">
      {/*
        Progressive enhancement: method/action + name= work without JS hydrate.
        React onSubmit still uses JSON fetch when the client bundle is alive.
      */}
      <form
        className="login-card"
        method="POST"
        action="/api/auth/login"
        onSubmit={submit}
      >
        <h1 className="login-title text-page-title">ورود به داشبورد</h1>
        <div className="login-subtitle text-caption">OTC Dealing Desk</div>
        <div className="field">
          <label htmlFor="login-username">نام کاربری</label>
          <input
            id="login-username"
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">رمز عبور</label>
          <input
            id="login-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error ? <div className="login-error">نام کاربری یا رمز عبور اشتباه است</div> : null}
        <button className="primary-button login-button" type="submit" disabled={submitting}>
          <LogIn aria-hidden="true" />
          {submitting ? "در حال ورود..." : "ورود"}
        </button>
      </form>
      <div className="app-version app-version--login">
        <span className="app-version-label">نسخه</span>
        <span className="app-version-value">{APP_VERSION}</span>
      </div>
    </main>
  );
}
