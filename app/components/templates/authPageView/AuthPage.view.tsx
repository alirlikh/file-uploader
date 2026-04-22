"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./AuthPage.view.module.css";

type Mode = "login" | "signup";

export default function AuthPageView() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    if (!email || !password) {
      setError("Fill in all fields.");
      return;
    }
    if (mode === "signup" && name.trim().length < 2) {
      setError("Name too short.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be ≥ 8 characters.");
      return;
    }

    setLoading(true);
    try {
      const body: Record<string, string> = { email, password };
      if (mode === "signup") body.name = name.trim();

      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <main className={styles.main}>
      <div className={styles.grid} aria-hidden />

      <div className={styles.card}>
        {/* Logo */}
        <div className={styles.logo}>
          <span className={styles.logoIcon}>⬡</span>
          <span className={styles.logoText}>VAULTCHUNK</span>
        </div>

        {/* Mode tabs */}
        <div className={styles.modeTabs}>
          <button
            className={`${styles.modeTab} ${mode === "login" ? styles.modeTabActive : ""}`}
            onClick={() => {
              setMode("login");
              setError("");
            }}
          >
            Sign In
          </button>
          <button
            className={`${styles.modeTab} ${mode === "signup" ? styles.modeTabActive : ""}`}
            onClick={() => {
              setMode("signup");
              setError("");
            }}
          >
            Create Account
          </button>
        </div>

        {/* Fields */}
        <div className={styles.fields}>
          {mode === "signup" && (
            <div className={styles.field}>
              <label className={styles.label}>NAME</label>
              <input
                className={styles.input}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onKey}
                placeholder="Your name"
                autoComplete="name"
                autoFocus
              />
            </div>
          )}

          <div className={styles.field}>
            <label className={styles.label}>EMAIL</label>
            <input
              className={styles.input}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={onKey}
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus={mode === "login"}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>PASSWORD</label>
            <input
              className={styles.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onKey}
              placeholder={
                mode === "signup" ? "Min. 8 characters" : "Your password"
              }
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
            />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className={styles.errorBox}>
            <span>✕</span>
            <span>{error}</span>
          </div>
        )}

        {/* Submit */}
        <button
          className={styles.submitBtn}
          onClick={submit}
          disabled={loading}
        >
          <span>
            {loading
              ? "Please wait…"
              : mode === "login"
                ? "SIGN IN"
                : "CREATE ACCOUNT"}
          </span>
          {!loading && <span>→</span>}
          {loading && <span className={styles.spinner} />}
        </button>

        {/* Note */}
        <p className={styles.note}>
          {mode === "login" ? (
            <>
              No account?{" "}
              <button
                className={styles.switchBtn}
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
              >
                Create one
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                className={styles.switchBtn}
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </main>
  );
}
