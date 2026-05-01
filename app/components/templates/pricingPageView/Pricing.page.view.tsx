"use client";

import { useState, useEffect } from "react";
import styles from "./Pricing.page.view.module.css";
import Link from "next/link";
import { PaidPlan, PlanInfo, PaymentResponse } from "@/app/utils/types";
import { CURRENCIES } from "@/app/data/static/plan";
import PaymentModal from "../../meterials/Modal/PaymentModal/Payment.modal";

const PLANS: PlanInfo[] = [
  {
    id: "free",
    label: "Free",
    price: "$0/mo",
    priceUsd: 0,
    color: "#5a6a7a",
    quota: "1 GB / day",
    features: [
      "1 GB daily quota",
      "10 MB chunk size",
      "24 h link expiry",
      "Chunk combiner",
      "Retry on failure",
    ],
  },
  {
    id: "pro",
    label: "Pro",
    price: "$9/mo",
    priceUsd: 9,
    color: "#47ffd4",
    quota: "10 GB / day",
    popular: true,
    features: [
      "10 GB daily quota",
      "10 MB chunk size",
      "48 h link expiry",
      "Everything in Free",
      "Priority support",
    ],
  },
  {
    id: "business",
    label: "Business",
    price: "$29/mo",
    priceUsd: 29,
    color: "#e8ff47",
    quota: "50 GB / day",
    features: [
      "50 GB daily quota",
      "10 MB chunk size",
      "7-day link expiry",
      "Everything in Pro",
      "Dedicated support",
    ],
  },
];

export default function PricingPageView() {
  const [userPlan, setUserPlan] = useState<string>("free");
  const [loadingUser, setLoadingU] = useState(true);
  const [selectedPlan, setSelPlan] = useState<PaidPlan | null>(null);
  const [currency, setCurrency] = useState<string>("USDT");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [payment, setPayment] = useState<PaymentResponse | null>(null);

  // Load current user plan
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user) setUserPlan(d.user.plan);
      })
      .finally(() => setLoadingU(false));
  }, []);

  const handleUpgrade = async (plan: PaidPlan) => {
    setSelPlan(plan);
    setCreateErr("");
  };

  const startPayment = async () => {
    if (!selectedPlan) return;
    setCreating(true);
    setCreateErr("");
    try {
      const res = await fetch("/api/payments/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: selectedPlan,
          currency: currency.toLowerCase(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateErr(data.error ?? "Failed to create payment.");
        return;
      }
      setPayment(data as PaymentResponse);
      setSelPlan(null);
    } catch {
      setCreateErr("Network error. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  const onPaymentSuccess = (updatedUser: object) => {
    const u = updatedUser as { plan: string };
    setUserPlan(u.plan ?? userPlan);
  };

  const planRank: Record<string, number> = {
    free: 0,
    pro: 1,
    business: 2,
    custom: 3,
  };
  const currentRank = planRank[userPlan] ?? 0;

  return (
    <main className={styles.main}>
      <div className={styles.grid} aria-hidden />
      <div className={styles.container}>
        {/* Nav */}
        <nav className={styles.nav}>
          <Link href="/" className={styles.navBack}>
            ← Back to app
          </Link>
          <div className={styles.navLogo}>
            <span className={styles.navLogoIcon}>⬡</span>
            <span className={styles.navLogoText}>VAULTCHUNK</span>
          </div>
        </nav>

        {/* Hero */}
        <div className={styles.hero}>
          <h1 className={styles.heroTitle}>Simple, transparent pricing</h1>
          <p className={styles.heroSub}>
            Pay with any major cryptocurrency — Bitcoin, Ethereum, USDT and
            more. Upgrades activate instantly after blockchain confirmation.
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
                    <span className={styles.planPrice}>{plan.price}</span>
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
                      onClick={() => handleUpgrade(plan.id as PaidPlan)}
                    >
                      Upgrade with Crypto
                    </button>
                  ) : (
                    <button
                      className={styles.upgradeBtn}
                      style={{ background: plan.color }}
                      disabled
                    >
                      {loadingUser ? "Loading…" : "Downgrade not available"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Currency + confirm selector */}
        {selectedPlan && (
          <div className={styles.checkoutBox}>
            <div className={styles.checkoutHeader}>
              <span className={styles.checkoutTitle}>
                Pay for {PLANS.find((p) => p.id === selectedPlan)?.label} — $
                {PLANS.find((p) => p.id === selectedPlan)?.priceUsd}/mo
              </span>
              <button
                className={styles.checkoutClose}
                onClick={() => setSelPlan(null)}
              >
                ✕
              </button>
            </div>

            <p className={styles.checkoutSub}>
              Choose your preferred cryptocurrency:
            </p>

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

            {createErr && (
              <div className={styles.createErr}>
                <span>✕</span>
                <span>{createErr}</span>
              </div>
            )}

            <button
              className={styles.payNowBtn}
              onClick={startPayment}
              disabled={creating}
            >
              {creating ? (
                <>
                  <span className={styles.paySpinner} />
                  Generating address…
                </>
              ) : (
                <>Pay with {currency} →</>
              )}
            </button>

            <p className={styles.checkoutNote}>
              You will receive a unique crypto address. Send exactly the
              displayed amount to activate your plan. Rates are locked for 20
              minutes.
            </p>
          </div>
        )}

        {/* FAQ */}
        <div className={styles.faq}>
          <h2 className={styles.faqTitle}>How does crypto payment work?</h2>
          <div className={styles.faqGrid}>
            {[
              [
                "Choose your plan & coin",
                "Select the plan you want and your preferred cryptocurrency from the dropdown.",
              ],
              [
                "Send the exact amount",
                "We generate a unique wallet address just for your payment. Send the exact amount shown within 20 minutes.",
              ],
              [
                "Automatic confirmation",
                "Our system detects your payment on-chain and activates your plan automatically — usually within 1–3 confirmations.",
              ],
              [
                "Secure & non-custodial",
                "Payments are processed by NOWPayments. We never hold your crypto — funds are forwarded immediately.",
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

      {payment && (
        <PaymentModal
          payment={payment}
          onClose={() => setPayment(null)}
          onSuccess={onPaymentSuccess}
        />
      )}
    </main>
  );
}
