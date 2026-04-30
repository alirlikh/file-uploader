import styles from "../../../templates/adminPageView/AdminPage.view.module.css";

export default function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div
      className={`${styles.statCard} ${accent ? styles.statCardAccent : ""}`}
    >
      <span className={styles.statVal}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  );
}
