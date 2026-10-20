"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";

export function LoginForm() {
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
        }),
      });
      if (!response.ok) {
        setError("Username or password is incorrect.");
        setBusy(false);
        return;
      }
      const next = searchParams.get("next") || "/";
      window.location.assign(next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch {
      setError("Sign-in failed. Try again.");
      setBusy(false);
    }
  }

  return (
    <form className="login-card" onSubmit={onSubmit}>
      <h1>Sign in with your username</h1>
      {error ? (
        <p className="login-error" role="alert">
          {error}
        </p>
      ) : null}
      <label>
        <span className="sr-only">Username</span>
        <input name="username" autoComplete="username" placeholder="Username" required />
      </label>
      <label>
        <span className="sr-only">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          required
        />
      </label>
      <button className="login-submit" type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
