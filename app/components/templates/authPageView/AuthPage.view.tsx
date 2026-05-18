"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import styles from "./AuthPage.view.module.css";

type Mode = "login" | "signup";
type Step = "form" | "otp" | "done";

const PLAN_PREVIEW = [
  { name: "Free", price: "$0/mo", quota: "1 GB/day", color: "#5a6a7a" },
  { name: "Pro", price: "$9/mo", quota: "10 GB/day", color: "#47ffd4" },
  { name: "Business", price: "$29/mo", quota: "50 GB/day", color: "#e8ff47" },
];

export default function AuthPageView() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [step, setStep] = useState<Step>("form");
  // Form fields
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPass] = useState("");
  // OTP state
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [verificationId, setVId] = useState("");
  const [emailHint, setHint] = useState("");
  const [otpExpiry, setExpiry] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  // Shared
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);
  // Login: unverified email handling
  const [unverifiedEmail, setUnverified] = useState("");

  // Countdown timer
  useEffect(() => {
    if (!otpExpiry) return;
    const id = setInterval(() => {
      const diff = otpExpiry.getTime() - Date.now();
      if (diff <= 0) {
        setCountdown("Expired");
        clearInterval(id);
        return;
      }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(`${m}:${s.toString().padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(id);
  }, [otpExpiry]);

  // Resend cooldown
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(
      () => setResendCooldown((c) => Math.max(0, c - 1)),
      1000,
    );
    return () => clearInterval(id);
  }, [resendCooldown]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setError("");
    setStep("form");
    setDigits(["", "", "", "", "", ""]);
    setUnverified("");
  };

  // ── Submit form ──────────────────────────────────────────────────────────────
  const submitForm = async () => {
    setError("");
    setLoading(true);
    try {
      if (mode === "login") {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.unverified) {
            setUnverified(data.email);
            setError(data.error);
          } else setError(data.error ?? "Login failed.");
          return;
        }
        router.push("/");
        router.refresh();
      } else {
        // Signup → request OTP
        const res = await fetch("/api/auth/signup/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, name, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Signup failed.");
          return;
        }
        setVId(data.verificationId);
        setHint(data.emailHint);
        setExpiry(new Date(data.expiresAt));
        setResendCooldown(60);
        setStep("otp");
      }
    } finally {
      setLoading(false);
    }
  };

  // ── OTP digit input ──────────────────────────────────────────────────────────
  const handleDigit = (i: number, val: string) => {
    const v = val.replace(/\D/g, "").slice(-1);
    const nd = [...digits];
    nd[i] = v;
    setDigits(nd);
    if (v && i < 5) inputRefs.current[i + 1]?.focus();
    if (nd.every((d) => d)) submitOtp(nd.join(""));
  };

  const handleDigitKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[i] && i > 0) {
      inputRefs.current[i - 1]?.focus();
      const nd = [...digits];
      nd[i - 1] = "";
      setDigits(nd);
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData
      .getData("text")
      .replace(/\D/g, "")
      .slice(0, 6);
    if (pasted.length === 6) {
      setDigits(pasted.split(""));
      submitOtp(pasted);
    }
  };

  const submitOtp = useCallback(
    async (code: string) => {
      setError("");
      setLoading(true);
      try {
        const res = await fetch("/api/auth/signup/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verificationId, otp: code }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Incorrect code.");
          if (data.remaining !== undefined) setRemaining(data.remaining);
          setDigits(["", "", "", "", "", ""]);
          inputRefs.current[0]?.focus();
          return;
        }
        setStep("done");
        setTimeout(() => {
          router.push("/");
          router.refresh();
        }, 1500);
      } finally {
        setLoading(false);
      }
    },
    [verificationId, router],
  );

  const resendOtp = async () => {
    if (resendCooldown > 0) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verificationId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to resend.");
        return;
      }
      setVId(data.verificationId);
      setExpiry(new Date(data.expiresAt));
      setResendCooldown(60);
      setDigits(["", "", "", "", "", ""]);
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <main className={styles.main}>
      <div className={styles.grid} aria-hidden />
      <div className={styles.wrap}>
        <div className={styles.card}>
          <div className={styles.logo}>
            <span className={styles.logoIcon}>⬡</span>
            <span className={styles.logoText}>VAULTCHUNK</span>
          </div>

          {/* ── OTP step ── */}
          {step === "otp" && (
            <div className={styles.otpWrap}>
              <div className={styles.otpHeader}>
                <p className={styles.otpTitle}>Check your inbox</p>
                <p className={styles.otpSub}>
                  We sent a 6-digit code to{" "}
                  <span className={styles.otpEmailHint}>{emailHint}</span>.
                  Enter it below to activate your account.
                </p>
              </div>

              <div className={styles.otpDigits} onPaste={handlePaste}>
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={(el) => {
                      inputRefs.current[i] = el;
                    }}
                    className={`${styles.otpDigit} ${d ? styles.filled : ""}`}
                    type="number"
                    inputMode="numeric"
                    maxLength={1}
                    value={d}
                    disabled={loading}
                    onChange={(e) => handleDigit(i, e.target.value)}
                    onKeyDown={(e) => handleDigitKey(i, e)}
                    autoFocus={i === 0}
                  />
                ))}
              </div>

              {remaining !== null && remaining <= 2 && (
                <p className={`${styles.otpAttempts} ${styles.otpAttemptsLow}`}>
                  ⚠ {remaining} attempt{remaining !== 1 ? "s" : ""} remaining
                </p>
              )}

              {error && (
                <div className={styles.errorBox}>
                  <span>✕</span>
                  <span>{error}</span>
                </div>
              )}

              <div className={styles.otpTimer}>
                <span>
                  Expires in{" "}
                  <span className={styles.otpTimerVal}>{countdown}</span>
                </span>
                <button
                  className={styles.otpResendBtn}
                  onClick={resendOtp}
                  disabled={resendCooldown > 0 || loading}
                >
                  {resendCooldown > 0
                    ? `Resend in ${resendCooldown}s`
                    : "Resend code"}
                </button>
              </div>

              <button
                className={styles.otpBack}
                onClick={() => {
                  setStep("form");
                  setError("");
                }}
              >
                ← Back
              </button>
            </div>
          )}

          {/* ── Success ── */}
          {step === "done" && (
            <div className={styles.otpSuccess}>
              <div className={styles.otpSuccessIcon}>✓</div>
              <p className={styles.otpSuccessTitle}>Account verified!</p>
              <p className={styles.otpSuccessSub}>
                Your account is ready. Signing you in…
              </p>
            </div>
          )}

          {/* ── Login / Signup form ── */}
          {step === "form" && (
            <>
              <div className={styles.modeTabs}>
                {(["login", "signup"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    className={`${styles.modeTab} ${mode === m ? styles.modeTabActive : ""}`}
                    onClick={() => switchMode(m)}
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
                      onKeyDown={(e) => e.key === "Enter" && submitForm()}
                      placeholder="Your name"
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
                    onKeyDown={(e) => e.key === "Enter" && submitForm()}
                    placeholder="you@example.com"
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
                    onKeyDown={(e) => e.key === "Enter" && submitForm()}
                    placeholder={
                      mode === "signup" ? "Min. 8 characters" : "Your password"
                    }
                  />
                </div>
              </div>

              {/* Unverified email warning */}
              {unverifiedEmail && (
                <div className={styles.warnBox}>
                  <span>{error}</span>
                  <button
                    className={styles.warnBoxResend}
                    onClick={async () => {
                      // Re-send via request endpoint using the stored email
                      setLoading(true);
                      setError("");
                      try {
                        const res = await fetch("/api/auth/signup/request", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            email: unverifiedEmail,
                            name: "User",
                            password: "placeholder_not_used",
                          }),
                        });
                        const d = await res.json();
                        if (d.verificationId) {
                          setVId(d.verificationId);
                          setHint(d.emailHint);
                          setExpiry(new Date(d.expiresAt));
                          setResendCooldown(60);
                          setStep("otp");
                          setUnverified("");
                        }
                      } finally {
                        setLoading(false);
                      }
                    }}
                  >
                    Resend verification email →
                  </button>
                </div>
              )}

              {error && !unverifiedEmail && (
                <div className={styles.errorBox}>
                  <span>✕</span>
                  <span>{error}</span>
                </div>
              )}

              <button
                className={styles.submitBtn}
                onClick={submitForm}
                disabled={loading}
              >
                <span>
                  {loading
                    ? "Please wait…"
                    : mode === "login"
                      ? "SIGN IN"
                      : "CONTINUE →"}
                </span>
                {!loading ? (
                  <span>{mode === "login" ? "→" : "✉"}</span>
                ) : (
                  <span className={styles.spinner} />
                )}
              </button>

              <p className={styles.note}>
                {mode === "login" ? (
                  <>
                    No account?{" "}
                    <button
                      className={styles.switchBtn}
                      onClick={() => switchMode("signup")}
                    >
                      Create one
                    </button>
                  </>
                ) : (
                  <>
                    Have an account?{" "}
                    <button
                      className={styles.switchBtn}
                      onClick={() => switchMode("login")}
                    >
                      Sign in
                    </button>
                  </>
                )}
              </p>
            </>
          )}
        </div>

        {/* Plans sidebar — only on form step */}
        {step === "form" && (
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
              Start free. Upgrade anytime with crypto.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
