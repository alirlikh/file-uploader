"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import styles from "./Pricing.page.view.module.css";

type PaidPlan = "pro" | "business";

type PayStep =
  | "idle"
  | "creating"
  | "otp"
  | "paying"
  | "success"
  | "failed"
  | "cancelled";

type PayStatus =
  | "waiting"
  | "confirming"
  | "confirmed"
  | "finished"
  | "partially_paid"
  | "failed"
  | "expired"
  | "refunded"
  | "cancelled";

interface PlanInfo {
  id: PaidPlan | "free";
  label: string;
  price?: number;
  color: string;
  quota: string;
  features: string[];
  popular?: boolean;
}
interface Currency {
  symbol: string;
  label: string;
  icon: string;
}
interface PaymentData {
  paymentId: string;
  payAddress: string;
  payAmount: number;
  payCurrency: string;
  priceUsd: number;
  originalPrice: number;
  discountPct: number;
  discountCode: string | null;
  plan: string;
  planLabel: string;
  expiresAt: string | null;
  status: string;
  otpExpiresAt: string;
}

const CURRENCIES: Currency[] = [
  { symbol: "BTC", label: "Bitcoin", icon: "₿" },
  { symbol: "ETH", label: "Ethereum", icon: "Ξ" },
  { symbol: "USDT", label: "Tether (ERC-20)", icon: "₮" },
  { symbol: "USDC", label: "USD Coin", icon: "◎" },
  { symbol: "SOL", label: "Solana", icon: "◎" },
  { symbol: "LTC", label: "Litecoin", icon: "Ł" },
  { symbol: "BNB", label: "BNB", icon: "◆" },
  { symbol: "MATIC", label: "Polygon", icon: "◆" },
  { symbol: "TRX", label: "TRON (TRC-20)", icon: "◆" },
  { symbol: "DOGE", label: "Dogecoin", icon: "Ð" },
  { symbol: "TON", label: "Toncoin", icon: "◆" },
];

const STATUS_LABEL: Record<string, string> = {
  waiting: "Waiting for payment…",
  confirming: "Detected — confirming on-chain…",
  confirmed: "Confirmed! Activating plan…",
  finished: "Payment complete ✓",
  partially_paid: "Partial payment received — please send the remainder",
  failed: "Payment failed",
  expired: "Rate expired",
  refunded: "Refunded",
  cancelled: "Cancelled",
};
const SUCCESS = new Set(["confirmed", "finished"]);
const TERMINAL = new Set([
  "finished",
  "failed",
  "refunded",
  "expired",
  "cancelled",
]);

function fmt(b: number, d = 8) {
  return b.toLocaleString("en-US", { maximumFractionDigits: d });
}
function qrUrl(data: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data)}`;
}
function maskEmail(e: string) {
  const [l, d] = e.split("@");
  const [dn, ...t] = (d ?? "").split(".");
  const m = (s: string) =>
    (s[0] ?? "") + "*".repeat(Math.max(1, (s.length ?? 1) - 1));
  return `${m(l)}@${m(dn)}.${t.join(".")}`;
}

function copy(text: string, setCopied: (v: boolean) => void) {
  navigator.clipboard.writeText(text).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  });
}

export default function PricingPageView() {
  const router = useRouter();
  const [userPlan, setUserPlan] = useState("free");
  const [userEmail, setUserEmail] = useState("");
  const [livePrices, setLivePrices] = useState<Record<string, number>>({
    pro: 9,
    business: 29,
  });
  const [loadingUser, setLoadingUser] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<PaidPlan | null>(null);
  const [currency, setCurrency] = useState("USDT");
  const [discountCode, setDiscountCode] = useState("");
  const [discountResult, setDiscountResult] = useState<{
    pct: number;
    error?: string;
  } | null>(null);
  const [checkingDiscount, setCheckingDiscount] = useState(false);
  const [payment, setPayment] = useState<PaymentData | null>(null);
  const [step, setStep] = useState<PayStep>("idle");
  const [payStatus, setPayStatus] = useState<PayStatus>("waiting");
  const [error, setError] = useState("");
  // OTP
  const [otpDigits, setOtpDigits] = useState(["", "", "", "", "", ""]);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState("");
  const [otpRemaining, setOtpRemaining] = useState<number | null>(null);
  const [otpCountdown, setOtpCountdown] = useState("");
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  // Copy
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [copiedAmt, setCopiedAmt] = useState(false);
  // Rate countdown
  const [rateExpiry, setRateExpiry] = useState<Date | null>(null);
  const [rateCountdown, setRateCountdown] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load user + prices
  useEffect(() => {
    Promise.all([
      fetch("/api/auth/me").then((r) => r.json()),
      fetch("/api/admin/prices")
        .catch(() => ({ json: () => ({}) }))
        .then((r) => (r as Response).json?.() ?? {}),
    ])
      .then(([ud, pd]) => {
        if (ud.user) {
          setUserPlan(ud.user.plan);
          setUserEmail(ud.user.email);
        }
        if (pd.prices) {
          setLivePrices((p) => ({ ...p, ...pd.prices }));
        }
      })
      .finally(() => setLoadingUser(false));
  }, []);

  // Rate countdown
  useEffect(() => {
    if (!rateExpiry) return;
    const id = setInterval(() => {
      const diff = rateExpiry.getTime() - Date.now();
      if (diff <= 0) {
        setRateCountdown("Expired");
        clearInterval(id);
        return;
      }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setRateCountdown(`${m}:${s.toString().padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(id);
  }, [rateExpiry]);

  // OTP countdown
  useEffect(() => {
    if (!payment?.otpExpiresAt || step !== "otp") return;
    const exp = new Date(payment.otpExpiresAt);
    const id = setInterval(() => {
      const diff = exp.getTime() - Date.now();
      if (diff <= 0) {
        setOtpCountdown("Expired");
        clearInterval(id);
        return;
      }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setOtpCountdown(`${m}:${s.toString().padStart(2, "0")}`);
    }, 1000);
    return () => clearInterval(id);
  }, [payment, step]);

  // Poll payment status
  const poll = useCallback(async () => {
    if (!payment) return;
    try {
      const res = await fetch(`/api/payments/status?id=${payment.paymentId}`);
      const d = await res.json();
      const s = d.payment?.status as PayStatus;
      if (s) {
        setPayStatus(s);
        if (SUCCESS.has(s)) {
          setStep("success");
          if (d.user) setUserPlan(d.user.plan);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }
    } catch {}
  }, [payment]);

  useEffect(() => {
    if (step !== "paying") return;
    pollRef.current = setInterval(poll, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [step, poll]);

  // Check discount
  const checkDiscount = async () => {
    if (!discountCode.trim() || !selectedPlan) return;
    setCheckingDiscount(true);
    setDiscountResult(null);
    const res = await fetch("/api/admin/discounts"); // public validate via create will validate
    // Validate by attempting create preview — we just validate client side and let server reject
    setDiscountResult({ pct: 0 }); // server validates on create; show optimistic
    setCheckingDiscount(false);
  };

  // Start payment
  const startPayment = async () => {
    if (!selectedPlan) {
      return;
    }
    setStep("creating");
    setError("");
    try {
      const res = await fetch("/api/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: selectedPlan,
          currency: currency.toLowerCase(),
          discountCode: discountCode.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? "Failed to create payment.");
        setStep("idle");
        return;
      }
      if (d.error && d.error.includes("discount")) {
        setError(d.error);
        setStep("idle");
        return;
      }
      setPayment(d);
      setPayStatus("waiting");
      if (d.expiresAt) setRateExpiry(new Date(d.expiresAt));
      setStep("otp"); // first verify via OTP
      setOtpDigits(["", "", "", "", "", ""]);
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } catch {
      setError("Network error.");
      setStep("idle");
    }
  };

  // Verify OTP
  const submitOtp = async (code: string) => {
    if (!payment) return;
    setOtpLoading(true);
    setOtpError("");
    try {
      const res = await fetch("/api/payments/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId: payment.paymentId, otp: code }),
      });
      const d = await res.json();
      if (!res.ok) {
        setOtpError(d.error ?? "Incorrect code.");
        if (d.remaining !== undefined) setOtpRemaining(d.remaining);
        setOtpDigits(["", "", "", "", "", ""]);
        inputRefs.current[0]?.focus();
        return;
      }
      setStep("paying");
    } finally {
      setOtpLoading(false);
    }
  };

  const handleOtpDigit = (i: number, val: string) => {
    const v = val.replace(/\D/g, "").slice(-1);
    const nd = [...otpDigits];
    nd[i] = v;
    setOtpDigits(nd);
    if (v && i < 5) inputRefs.current[i + 1]?.focus();
    if (nd.every((d) => d)) submitOtp(nd.join(""));
  };
  const handleOtpKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otpDigits[i] && i > 0) {
      inputRefs.current[i - 1]?.focus();
      const nd = [...otpDigits];
      nd[i - 1] = "";
      setOtpDigits(nd);
    }
  };
  const handleOtpPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const p = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (p.length === 6) {
      setOtpDigits(p.split(""));
      submitOtp(p);
    }
  };

  // Cancel payment
  const cancelPayment = async () => {
    if (!payment) return;
    await fetch("/api/payments/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentId: payment.paymentId }),
    });
    setStep("cancelled");
    setPayment(null);
    setSelectedPlan(null);
    if (pollRef.current) clearInterval(pollRef.current);
  };

  const reset = () => {
    setStep("idle");
    setPayment(null);
    setSelectedPlan(null);
    setError("");
    setDiscountCode("");
    setDiscountResult(null);
    setOtpDigits(["", "", "", "", "", ""]);
    setOtpError("");
  };

  const planRank: Record<string, number> = {
    free: 0,
    pro: 1,
    business: 2,
    custom: 3,
  };
  const currentRank = planRank[userPlan] ?? 0;

  const PLANS: PlanInfo[] = [
    {
      id: "free",
      label: "Free",
      color: "#5a6a7a",
      quota: "1 GB/day",
      features: [
        "1 GB daily quota",
        "10 MB chunks",
        "24 h link expiry",
        "Chunk combiner",
      ],
    },
    {
      id: "pro",
      label: "Pro",
      price: livePrices.pro ?? 9,
      color: "#47ffd4",
      quota: "10 GB/day",
      popular: true,
      features: [
        "10 GB daily quota",
        "Priority support",
        "48 h link expiry",
        "Everything in Free",
      ],
    },
    {
      id: "business",
      label: "Business",
      price: livePrices.business ?? 29,
      color: "#e8ff47",
      quota: "50 GB/day",
      features: [
        "50 GB daily quota",
        "Dedicated support",
        "7-day link expiry",
        "Everything in Pro",
      ],
    },
  ];

  const effectivePrice = () => {
    if (!selectedPlan) return 0;
    const base = livePrices[selectedPlan] ?? (selectedPlan === "pro" ? 9 : 29);
    if (discountResult?.pct)
      return +(base * (1 - discountResult.pct / 100)).toFixed(2);
    return base;
  };

  return (
    <main className={styles.main}>
      <div className={styles.grid} aria-hidden />
      <div className={styles.container}>
        <nav className={styles.nav}>
          <a href="/" className={styles.navBack}>
            ← Back to app
          </a>
          <div className={styles.navLogo}>
            <span className={styles.navLogoIcon}>⬡</span>
            <span className={styles.navLogoText}>VAULTCHUNK</span>
          </div>
        </nav>

        <div className={styles.hero}>
          <h1 className={styles.heroTitle}>Simple, transparent pricing</h1>
          <p className={styles.heroSub}>
            Pay with any major cryptocurrency. Upgrades activate instantly after
            on-chain confirmation.
          </p>
        </div>

        {/* Plan cards */}
        <div className={styles.planGrid}>
          {PLANS.map((plan) => {
            const rank = planRank[plan.id] ?? 0;
            const isCurrent = plan.id === userPlan;
            const canBuy =
              !loadingUser && rank > currentRank && plan.id !== "free";
            return (
              <div
                key={plan.id}
                className={`${styles.planCard} ${plan.popular ? styles.planCardPopular : ""} ${isCurrent ? styles.planCardCurrent : ""}`}
                style={{ "--plan-color": plan.color } as React.CSSProperties}
              >
                {plan.popular && (
                  <span className={styles.popularBadge}>MOST POPULAR</span>
                )}
                {isCurrent && (
                  <span className={styles.currentBadge}>CURRENT PLAN</span>
                )}
                <div className={styles.planTop}>
                  <span
                    className={styles.planName}
                    style={{ color: plan.color }}
                  >
                    {plan.label}
                  </span>
                  <div className={styles.planPriceRow}>
                    <span className={styles.planPrice}>
                      {plan.price != null ? `$${plan.price}` : "Free"}
                    </span>
                    {plan.price != null && (
                      <span className={styles.planPricePer}>/mo</span>
                    )}
                  </div>
                  <span className={styles.planQuota}>
                    {plan.quota} upload limit
                  </span>
                </div>
                <ul className={styles.featureList}>
                  {plan.features.map((f) => (
                    <li key={f} className={styles.featureItem}>
                      <span
                        className={styles.featureCheck}
                        style={{ color: plan.color }}
                      >
                        ✓
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>
                <div className={styles.planAction}>
                  {plan.id === "free" ? (
                    <button className={styles.freePlanBtn} disabled>
                      Free forever
                    </button>
                  ) : isCurrent ? (
                    <button className={styles.currentPlanBtn} disabled>
                      Active
                    </button>
                  ) : canBuy ? (
                    <button
                      className={styles.upgradeBtn}
                      style={{ background: plan.color }}
                      onClick={() => {
                        setSelectedPlan(plan.id as PaidPlan);
                        setError("");
                        setDiscountCode("");
                        setDiscountResult(null);
                      }}
                    >
                      Upgrade with Crypto
                    </button>
                  ) : (
                    <button
                      className={styles.upgradeBtn}
                      style={{ background: plan.color }}
                      disabled
                    >
                      {loadingUser ? "Loading…" : "Not available"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Checkout box */}
        {selectedPlan && step === "idle" && (
          <div className={styles.checkoutBox}>
            <div className={styles.checkoutHeader}>
              <span className={styles.checkoutTitle}>
                {PLANS.find((p) => p.id === selectedPlan)?.label} Plan — $
                {effectivePrice()}/mo
              </span>
              <button className={styles.checkoutClose} onClick={reset}>
                ✕
              </button>
            </div>

            {/* Discount code */}
            <div className={styles.discountRow}>
              <div className={styles.discountInputWrap}>
                <input
                  className={styles.discountInput}
                  value={discountCode}
                  onChange={(e) =>
                    setDiscountCode(e.target.value.toUpperCase())
                  }
                  placeholder="DISCOUNT CODE (optional)"
                  spellCheck={false}
                />
              </div>
              {discountResult?.pct != null && discountResult.pct > 0 && (
                <span className={styles.discountBadge}>
                  −{discountResult.pct}% applied
                </span>
              )}
            </div>

            <p className={styles.checkoutSub}>Choose your cryptocurrency:</p>
            <div className={styles.currencyGrid}>
              {CURRENCIES.map((c) => (
                <button
                  key={c.symbol}
                  className={`${styles.currencyBtn} ${currency === c.symbol ? styles.currencyBtnActive : ""}`}
                  onClick={() => setCurrency(c.symbol)}
                >
                  <span className={styles.currencyIcon}>{c.icon}</span>
                  <span className={styles.currencySymbol}>{c.symbol}</span>
                  <span className={styles.currencyLabel}>{c.label}</span>
                </button>
              ))}
            </div>

            {error && (
              <div className={styles.createErr}>
                <span>✕</span>
                <span>{error}</span>
              </div>
            )}

            <button
              className={styles.payNowBtn}
              onClick={startPayment}
              disabled={step === "creating"}
            >
              {step === "creating" ? (
                <>
                  <span className={styles.paySpinner} />
                  Generating address…
                </>
              ) : (
                <>
                  Pay ${effectivePrice()} with {currency} →
                </>
              )}
            </button>

            <p className={styles.checkoutNote}>
              A unique crypto address is generated for your payment. Rates are
              locked for ~20 minutes. A 6-digit confirmation code will be sent
              to your email.
            </p>
          </div>
        )}

        {/* OTP verification step */}
        {step === "otp" && payment && (
          <div className={styles.otpBox}>
            <div className={styles.otpBoxHeader}>
              <span className={styles.otpBoxTitle}>Confirm your payment</span>
              <span className={styles.otpBoxSub}>
                We sent a 6-digit code to{" "}
                <strong>{maskEmail(userEmail)}</strong>. Enter it to proceed.
              </span>
            </div>
            <div className={styles.otpDigits} onPaste={handleOtpPaste}>
              {otpDigits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    inputRefs.current[i] = el;
                  }}
                  className={`${styles.otpDigit} ${d ? styles.otpFilled : ""}`}
                  type="number"
                  inputMode="numeric"
                  maxLength={1}
                  value={d}
                  disabled={otpLoading}
                  onChange={(e) => handleOtpDigit(i, e.target.value)}
                  onKeyDown={(e) => handleOtpKey(i, e)}
                  autoFocus={i === 0}
                />
              ))}
            </div>
            {otpError && (
              <div className={styles.otpErr}>
                <span>✕</span>
                <span>{otpError}</span>
              </div>
            )}
            {otpRemaining !== null && otpRemaining <= 2 && (
              <p className={styles.otpAttemptsWarn}>
                ⚠ {otpRemaining} attempt{otpRemaining !== 1 ? "s" : ""}{" "}
                remaining
              </p>
            )}
            <div className={styles.otpTimerRow}>
              <span className={styles.otpTimerLabel}>
                Code expires in <strong>{otpCountdown}</strong>
              </span>
              <button className={styles.cancelPayBtn} onClick={cancelPayment}>
                Cancel payment
              </button>
            </div>
          </div>
        )}

        {/* Payment modal */}
        {step === "paying" && payment && (
          <div className={styles.payingBox}>
            {/* Status banner */}
            <div
              className={`${styles.statusBanner} ${SUCCESS.has(payStatus) ? styles.statusSuccess : payStatus === "failed" || payStatus === "expired" ? styles.statusFailed : payStatus === "partially_paid" ? styles.statusPartial : styles.statusWaiting}`}
            >
              {!SUCCESS.has(payStatus) &&
                !["failed", "expired"].includes(payStatus) && (
                  <span className={styles.statusDot} />
                )}
              {SUCCESS.has(payStatus) && <span>✓</span>}
              <span>{STATUS_LABEL[payStatus] ?? payStatus}</span>
              {rateCountdown && !TERMINAL.has(payStatus) && (
                <span className={styles.rateCountdown}>
                  Rate expires in {rateCountdown}
                </span>
              )}
            </div>

            {payment.discountPct > 0 && (
              <div className={styles.discountApplied}>
                🎉 Discount applied: <strong>{payment.discountCode}</strong> (−
                {payment.discountPct}%) — you pay{" "}
                <strong>${payment.priceUsd}</strong> instead of $
                {payment.originalPrice}
              </div>
            )}

            {!SUCCESS.has(payStatus) &&
              !["failed", "expired", "cancelled"].includes(payStatus) && (
                <div className={styles.paymentBody}>
                  {/* QR */}
                  <div className={styles.qrWrap}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qrUrl(
                        `${payment.payCurrency.toLowerCase()}:${payment.payAddress}?amount=${payment.payAmount}`,
                      )}
                      alt="Payment QR"
                      className={styles.qrImage}
                      width={180}
                      height={180}
                    />
                    <p className={styles.qrHint}>Scan with your wallet app</p>
                  </div>
                  {/* Amount */}
                  <div className={styles.payRow}>
                    <span className={styles.payFieldLabel}>AMOUNT</span>
                    <div className={styles.payFieldValue}>
                      <code className={styles.payCode}>
                        {fmt(payment.payAmount)} {payment.payCurrency}
                      </code>
                      <button
                        className={styles.copyBtn}
                        onClick={() =>
                          copy(String(payment.payAmount), setCopiedAmt)
                        }
                      >
                        {copiedAmt ? "✓ Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                  {/* Address */}
                  <div className={styles.payRow}>
                    <span className={styles.payFieldLabel}>ADDRESS</span>
                    <div className={styles.payFieldValue}>
                      <code
                        className={styles.payCode}
                        style={{ wordBreak: "break-all" }}
                      >
                        {payment.payAddress}
                      </code>
                      <button
                        className={styles.copyBtn}
                        onClick={() => copy(payment.payAddress, setCopiedAddr)}
                      >
                        {copiedAddr ? "✓ Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                  <div className={styles.networkWarn}>
                    ⚠ Send only <strong>{payment.payCurrency}</strong> to this
                    address. Wrong assets are lost permanently.
                  </div>
                  {payStatus === "partially_paid" && (
                    <div className={styles.partialWarn}>
                      Partial payment received. Send the remaining amount to the
                      same address.
                    </div>
                  )}
                  <button
                    className={styles.cancelPayBtn}
                    style={{ marginTop: 8 }}
                    onClick={cancelPayment}
                  >
                    Cancel payment
                  </button>
                </div>
              )}
          </div>
        )}

        {/* Success */}
        {step === "success" && (
          <div className={styles.successBox}>
            <div className={styles.successIcon}>✓</div>
            <p className={styles.successTitle}>Payment confirmed!</p>
            <p className={styles.successSub}>
              Your account has been upgraded. Enjoy your new plan!
            </p>
            <button className={styles.doneBtn} onClick={() => router.push("/")}>
              Go to app →
            </button>
          </div>
        )}

        {/* Cancelled */}
        {step === "cancelled" && (
          <div className={styles.cancelledBox}>
            <p className={styles.cancelledTitle}>Payment cancelled</p>
            <p className={styles.cancelledSub}>
              No charge was made. Choose a plan above to try again.
            </p>
          </div>
        )}

        {/* FAQ */}
        <div className={styles.faq}>
          <h2 className={styles.faqTitle}>How does crypto payment work?</h2>
          <div className={styles.faqGrid}>
            {[
              [
                "Choose plan & coin",
                "Pick the plan you want and your preferred cryptocurrency.",
              ],
              [
                "Confirm with email OTP",
                "We send a 6-digit code to verify it's really you before showing the payment address.",
              ],
              [
                "Send the exact amount",
                "A unique address is generated. Send the exact amount shown within 20 minutes.",
              ],
              [
                "Instant activation",
                "Your plan upgrades automatically after blockchain confirmation — usually 1–3 blocks.",
              ],
            ].map(([q, a]) => (
              <div key={q} className={styles.faqItem}>
                <p className={styles.faqQ}>{q}</p>
                <p className={styles.faqA}>{a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
