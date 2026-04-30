import { AdminUser, Plan } from "@/app/utils/types";
import { useState } from "react";
import styles from "../../../templates/adminPageView/AdminPage.view.module.css";
import { PLANS } from "@/app/data/static/plan";

export default function PlanModal({
  user,
  onClose,
  onSave,
}: {
  user: AdminUser;
  onClose: () => void;
  onSave: (plan: Plan, customBytes?: number) => void;
}) {
  const [plan, setPlan] = useState<Plan>(user.plan);
  const [customGB, setCustomGB] = useState<string>(
    user.customLimitBytes
      ? String(Math.round(user.customLimitBytes / 1024 / 1024 / 1024))
      : "",
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const customBytes =
      plan === "custom"
        ? parseFloat(customGB) * 1024 * 1024 * 1024 || undefined
        : undefined;
    await onSave(plan, customBytes);
    setSaving(false);
    onClose();
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>Edit Plan — {user.name}</span>
          <button className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>

        <div className={styles.modalBody}>
          <p className={styles.modalSub}>{user.email}</p>

          <div className={styles.planOptions}>
            {(Object.entries(PLANS) as [Plan, (typeof PLANS)[Plan]][]).map(
              ([key, p]) => (
                <button
                  key={key}
                  className={`${styles.planOption} ${plan === key ? styles.planOptionActive : ""}`}
                  style={{ "--pc": p.color } as React.CSSProperties}
                  onClick={() => setPlan(key)}
                >
                  <div className={styles.planOptionHeader}>
                    <span
                      className={styles.planOptionName}
                      style={{ color: p.color }}
                    >
                      {p.label}
                    </span>
                    <span className={styles.planOptionQuota}>{p.quota}</span>
                  </div>
                  {plan === key && (
                    <span className={styles.planOptionCheck}>✓</span>
                  )}
                </button>
              ),
            )}
          </div>

          {plan === "custom" && (
            <div className={styles.customField}>
              <label className={styles.customLabel}>
                CUSTOM DAILY LIMIT (GB)
              </label>
              <div className={styles.customInputRow}>
                <input
                  className={styles.customInput}
                  type="number"
                  min="1"
                  step="1"
                  value={customGB}
                  onChange={(e) => setCustomGB(e.target.value)}
                  placeholder="e.g. 100"
                />
                <span className={styles.customUnit}>GB / day</span>
              </div>
            </div>
          )}
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.saveBtn} onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save Plan"}
          </button>
        </div>
      </div>
    </div>
  );
}
