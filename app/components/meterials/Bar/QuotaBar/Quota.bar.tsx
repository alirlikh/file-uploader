import { SessionUser } from "@/app/utils/types";
import styles from "../../../templates/mainPageView/MainPage.view.module.css";
import { fmt } from "@/app/utils/helpers";

export default function QuotaBar({ user }: { user: SessionUser }) {
  const pct = Math.min(
    100,
    Math.round((user.dailyUsed / user.dailyLimit) * 100),
  );

  const hi = pct >= 80;

  return (
    <div className={styles.quotaWrap}>
      <div className={styles.quotaMeta}>
        <div className={styles.quotaLeft}>
          <span className={styles.quotaLabel}>Daily quota</span>
          <span
            className={styles.planBadge}
            style={{ borderColor: user.planColor, color: user.planColor }}
          >
            {user.planLabel}
          </span>
        </div>
        <span className={`${styles.quotaVal} ${hi ? styles.quotaHigh : ""}`}>
          {fmt(user.dailyUsed)} / {fmt(user.dailyLimit)}
        </span>
      </div>
      <div className={styles.quotaBar}>
        <div
          className={`${styles.quotaFill} ${hi ? styles.quotaFillHigh : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className={styles.quotaFooter}>
        <span className={styles.quotaRemaining}>
          {fmt(user.dailyRemaining)} remaining
        </span>
        {pct >= 100 && (
          <span className={styles.quotaExhausted}>Resets at midnight UTC</span>
        )}
      </div>
    </div>
  );
}
