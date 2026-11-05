"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Sign in failed.");
      router.replace("/dashboard");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign in failed. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <form className="login-form" onSubmit={submit}>
      <label className="field-label" htmlFor="email">Work email</label>
      <input
        autoComplete="username"
        id="email"
        name="email"
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@company.com"
        maxLength={320}
        required
      />
      <label className="field-label" htmlFor="password">Password</label>
      <input
        autoComplete="current-password"
        id="password"
        name="password"
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        maxLength={72}
        required
      />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="button button-primary login-submit" disabled={submitting}>
        {submitting ? "Verifying access…" : "Sign in securely"}
        <span aria-hidden="true">↗</span>
      </button>
      <p className="login-security"><span aria-hidden="true">●</span> Protected with encrypted sessions</p>
    </form>
  );
}
