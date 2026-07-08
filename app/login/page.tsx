"use client";

import { useState } from "react";
import { LogIn } from "lucide-react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(false);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">ورود به داشبورد</h1>
        <div className="login-subtitle muted">OTC Dealing Desk</div>
        <div className="field">
          <label htmlFor="login-username">نام کاربری</label>
          <input
            id="login-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">رمز عبور</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error ? <div className="login-error">نام کاربری یا رمز عبور اشتباه است</div> : null}
        <button className="primary-button login-button" type="submit" disabled={submitting}>
          <LogIn aria-hidden="true" />
          {submitting ? "در حال ورود..." : "ورود"}
        </button>
      </form>
    </main>
  );
}
