import { Plan } from "@/app/utils/types";

export const PLANS: Record<
  Plan,
  { label: string; color: string; quota: string }
> = {
  free: { label: "Free", color: "#5a6a7a", quota: "1 GB/day" },
  pro: { label: "Pro", color: "#47ffd4", quota: "10 GB/day" },
  business: { label: "Business", color: "#e8ff47", quota: "50 GB/day" },
  custom: { label: "Custom", color: "#ff8c47", quota: "Custom" },
};
