import {
  STATUS_LABELS,
  SUCCESS_STATUSES,
  TERMINAL_STATUSES,
} from "@/app/data/static/plan";
import { PaymentResponse, PayStatus, PlanInfo } from "@/app/utils/types";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./../../../templates/pricingPageView/Pricing.page.view.module.css";
import { copyToClipboard, qrUrl } from "@/app/utils/helpers";

//todo
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

export default function PaymentModal({
  payment,
  onClose,
  onSuccess,
}: {
  payment: PaymentResponse;
  onClose: () => void;
  onSuccess: (updatedUser: object) => void;
}) {
  const [status, setStatus] = useState<PayStatus>(payment.status as PayStatus);
  const [copiedAddr, setCAddr] = useState(false);
  const [copiedAmt, setCamt] = useState(false);
  const [expiresIn, setExpires] = useState<string>("");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function fmt(n: number, decimals = 8) {
    return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
  }

  // ── Countdown timer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!payment.expiresAt) return;
    const tick = () => {
      const diff = new Date(payment.expiresAt!).getTime() - Date.now();
      if (diff <= 0) {
        setExpires("Expired");
        return;
      }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setExpires(`${m}m ${s.toString().padStart(2, "0")}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [payment.expiresAt]);

  // ── Poll status ────────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/payments/status?id=${payment.paymentId}`);
      const data = await res.json();
      const s = data.payment?.status as PayStatus;
      if (s) setStatus(s);
      if (SUCCESS_STATUSES.has(s) && data.user) {
        onSuccess(data.user);
        if (intervalRef.current) clearInterval(intervalRef.current);
      }
    } catch {
      /* ignore */
    }
  }, [payment.paymentId, onSuccess]);

  useEffect(() => {
    if (TERMINAL_STATUSES.has(status)) return;
    intervalRef.current = setInterval(poll, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll, status]);

  const isSuccess = SUCCESS_STATUSES.has(status);
  const isFailed = status === "failed" || status === "expired";
  const isPartial = status === "partially_paid";

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <div className={styles.modalTitle}>
            <span
              className={styles.modalPlanLabel}
              style={{ color: PLANS.find((p) => p.id === payment.plan)?.color }}
            >
              {payment.planLabel} Plan
            </span>
            <span className={styles.modalPrice}>${payment.priceUsd}/mo</span>
          </div>
          <button className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Status banner */}
        <div
          className={`${styles.statusBanner} ${
            isSuccess
              ? styles.statusSuccess
              : isFailed
                ? styles.statusFailed
                : isPartial
                  ? styles.statusPartial
                  : styles.statusWaiting
          }`}
        >
          {!isSuccess && !isFailed && <span className={styles.statusDot} />}
          {isSuccess && <span>✓</span>}
          {isFailed && <span>✕</span>}
          <span>{STATUS_LABELS[status] ?? status}</span>
          {expiresIn && !isSuccess && !isFailed && (
            <span className={styles.countdown}>
              Rate expires in {expiresIn}
            </span>
          )}
        </div>

        {!isSuccess && !isFailed && (
          <div className={styles.paymentBody}>
            {/* QR Code */}
            <div className={styles.qrWrap}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qrUrl(
                  `${payment.payCurrency.toLowerCase()}:${payment.payAddress}?amount=${payment.payAmount}`,
                )}
                alt="Payment QR code"
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
                    copyToClipboard(String(payment.payAmount), setCamt)
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
                  onClick={() => copyToClipboard(payment.payAddress, setCAddr)}
                >
                  {copiedAddr ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>

            {/* Network warning */}
            <div className={styles.networkWarn}>
              ⚠ Send only <strong>{payment.payCurrency}</strong> to this
              address. Sending the wrong asset will result in permanent loss.
            </div>

            {/* Partial payment note */}
            {isPartial && (
              <div className={styles.partialWarn}>
                Partial payment received. Please send the remaining amount to
                the same address.
              </div>
            )}
          </div>
        )}

        {isSuccess && (
          <div className={styles.successBody}>
            <div className={styles.successIcon}>✓</div>
            <p className={styles.successTitle}>Payment confirmed!</p>
            <p className={styles.successSub}>
              Your account has been upgraded to{" "}
              <strong>{payment.planLabel}</strong>. Close this window to
              continue.
            </p>
            <button className={styles.doneBtn} onClick={onClose}>
              Continue →
            </button>
          </div>
        )}

        {isFailed && (
          <div className={styles.failedBody}>
            <p className={styles.failedTitle}>
              {status === "expired" ? "Rate expired" : "Payment failed"}
            </p>
            <p className={styles.failedSub}>
              Please start a new payment to try again.
            </p>
            <button className={styles.doneBtn} onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
