import { CurrencyOption, Plan } from "@/app/utils/types";

//todo
export const PLANS: Record<
  Plan,
  { label: string; color: string; quota: string }
> = {
  free: { label: "Free", color: "#5a6a7a", quota: "1 GB/day" },
  pro: { label: "Pro", color: "#47ffd4", quota: "10 GB/day" },
  business: { label: "Business", color: "#e8ff47", quota: "50 GB/day" },
  custom: { label: "Custom", color: "#ff8c47", quota: "Custom" },
};

export const CURRENCIES: CurrencyOption[] = [
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
];

export const STATUS_LABELS: Record<string, string> = {
  waiting: "Waiting for payment…",
  confirming: "Payment detected — confirming…",
  confirmed: "Confirmed! Activating plan…",
  finished: "Payment complete ✓",
  partially_paid: "Partial payment received — send the remainder",
  failed: "Payment failed",
  expired: "Payment window expired",
  refunded: "Refunded",
};

export const SUCCESS_STATUSES = new Set(["confirmed", "finished"]);

export const TERMINAL_STATUSES = new Set([
  "finished",
  "failed",
  "refunded",
  "expired",
]);
