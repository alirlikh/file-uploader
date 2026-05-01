import { fmt, fmtDate } from "@/app/utils/helpers";
import { PaymentRecord, SessionUser } from "@/app/utils/types";
import { useEffect, useState } from "react";

import styles from "../../../templates/mainPageView/MainPage.view.module.css";
import { STATUS_COLOR } from "@/app/data/static/billing";

export default function BillingTab({ user }: { user: SessionUser }) {
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/payments/history")
      .then((r) => r.json())
      .then((d) => setPayments(d.payments ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className={styles.billingPlan}>
        <div className={styles.billingPlanLeft}>
          <span
            className={styles.billingPlanLabel}
            style={{ color: user.planColor }}
          >
            {user.planLabel} Plan
          </span>
          <span className={styles.billingPlanQuota}>
            {fmt(user.dailyLimit)} / day upload limit
          </span>
        </div>
        <a href="/pricing" className={styles.upgradeLink}>
          Upgrade plan →
        </a>
      </div>
      <p className={styles.sectionLabel} style={{ marginBottom: 12 }}>
        PAYMENT HISTORY
      </p>
      {loading && (
        <div className={styles.centerMsg}>
          <span className={styles.spinDot} />
          <span>Loading…</span>
        </div>
      )}
      {!loading && payments.length === 0 && (
        <div className={styles.centerMsg}>
          <span style={{ fontSize: 28, opacity: 0.3 }}>◎</span>
          <p>
            No payments yet.{" "}
            <a href="/pricing" style={{ color: "var(--accent2)" }}>
              View plans →
            </a>
          </p>
        </div>
      )}
      {!loading && payments.length > 0 && (
        <div className={styles.fileList}>
          {payments.map((p) => (
            <div key={p.id} className={styles.fileCard}>
              <div className={styles.fileCardRow} style={{ cursor: "default" }}>
                <span
                  style={{
                    fontSize: 18,
                    color: STATUS_COLOR[p.status] ?? "var(--text-dim)",
                  }}
                >
                  ◎
                </span>
                <div className={styles.fileCardBody}>
                  <p className={styles.fileCardName}>{p.planLabel} Plan</p>
                  <p className={styles.fileCardMeta}>
                    ${p.priceUsd}/mo
                    {p.payCurrency && p.payAmount
                      ? ` · ${p.payAmount} ${p.payCurrency}`
                      : ""}
                    {" · "}
                    {fmtDate(p.createdAt)}
                    {p.confirmedAt
                      ? ` · confirmed ${fmtDate(p.confirmedAt)}`
                      : ""}
                  </p>
                </div>
                <span
                  className={styles.payStatusBadge}
                  style={{
                    color: STATUS_COLOR[p.status] ?? "var(--text-dim)",
                    borderColor: STATUS_COLOR[p.status] ?? "var(--border)",
                  }}
                >
                  {p.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
