import { Plan } from "@/app/utils/types";
import styles from "../../../templates/adminPageView/AdminPage.view.module.css";
import { PLANS } from "@/app/data/static/plan";

export default function PlanBadge({ plan }: { plan: Plan }) {
  const p = PLANS[plan];
  return (
    <span
      className={styles.planBadge}
      style={{ borderColor: p.color, color: p.color }}
    >
      {p.label}
    </span>
  );
}
