"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./AuthPage.view.module.css";
import { Mode } from "@/app/utils/types";

const PLAN_PREVIEW = [
  { name: "Free", price: "$0/mo", quota: "1 GB/day", color: "#5a6a7a" },
  { name: "Pro", price: "$9/mo", quota: "10 GB/day", color: "#47ffd4" },
  { name: "Business", price: "$29/mo", quota: "50 GB/day", color: "#e8ff47" },
];

export default function AuthPageView() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPass] = useState("");
  const [loading, setLoad] = useState(false);
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
    setLoad(true);
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
      setError("Network error.");
    } finally {
      setLoad(false);
    }
  };

  return (
    <main className={styles.main}>
      <div className={styles.grid} aria-hidden />
      <div className={styles.wrap}>
        {/* Left: form */}
        <div className={styles.card}>
          <div className={styles.logo}>
            <span className={styles.logoIcon}>⬡</span>
            <span className={styles.logoText}>VAULTCHUNK</span>
          </div>
          <div className={styles.modeTabs}>
            {(["login", "signup"] as Mode[]).map((m) => (
              <button
                key={m}
                className={`${styles.modeTab} ${mode === m ? styles.modeTabActive : ""}`}
                onClick={() => {
                  setMode(m);
                  setError("");
                }}
              >
                {m === "login" ? "Sign In" : "Create Account"}
              </button>
            ))}
          </div>
          <div className={styles.fields}>
            {mode === "signup" && (
              <div className={styles.field}>
                <label className={styles.label}>NAME</label>
                <input
                  className={styles.input}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
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
                onKeyDown={(e) => e.key === "Enter" && submit()}
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
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder={
                  mode === "signup" ? "Min. 8 characters" : "Your password"
                }
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
              />
            </div>
          </div>
          {error && (
            <div className={styles.errorBox}>
              <span>✕</span>
              <span>{error}</span>
            </div>
          )}
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
            {!loading ? <span>→</span> : <span className={styles.spinner} />}
          </button>
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
                Have an account?{" "}
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

        {/* Right: plan preview */}
        <div className={styles.plans}>
          <p className={styles.plansTitle}>CHOOSE YOUR PLAN</p>
          {PLAN_PREVIEW.map((p) => (
            <div
              key={p.name}
              className={styles.planCard}
              style={{ "--plan-color": p.color } as React.CSSProperties}
            >
              <div className={styles.planHeader}>
                <span className={styles.planName} style={{ color: p.color }}>
                  {p.name}
                </span>
                <span className={styles.planPrice}>{p.price}</span>
              </div>
              <span className={styles.planQuota}>{p.quota} upload limit</span>
            </div>
          ))}
          <p className={styles.plansNote}>
            Start free. Upgrade anytime from your account.
          </p>
        </div>
      </div>
    </main>
  );
}
