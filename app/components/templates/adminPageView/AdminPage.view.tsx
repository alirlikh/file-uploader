"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import styles from "./AdminPage.view.module.css";

type Plan = "free" | "pro" | "business" | "custom";
type AdminTab = "users" | "payments" | "prices" | "discounts";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  isBlocked: boolean;
  isVerified: boolean;
  plan: Plan;
  planLabel: string;
  planColor: string;
  customLimitBytes: number | null;
  fileCount: number;
  totalBytesStored: number;
  bytesUsedToday: number;
  createdAt: string;
}
interface Stats {
  users: number;
  files: number;
  totalBytes: number;
  blocked: number;
  todayUploads: number;
  totalPayments: number;
  pendingPayments: number;
  totalRevenue: number;
}
interface Payment {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  plan: string;
  status: string;
  priceUsd: number;
  discountCode: string | null;
  discountPct: number;
  finalUsd: number;
  payCurrency: string | null;
  payAmount: number | null;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
}
interface DiscountCode {
  id: string;
  code: string;
  description: string | null;
  discount_pct: number;
  max_uses: number | null;
  uses_count: number;
  valid_from: string;
  valid_until: string | null;
  applies_to: string[] | null;
  is_active: boolean;
  created_at: string;
}

const PLAN_COLORS: Record<string, string> = {
  free: "#5a6a7a",
  pro: "#47ffd4",
  business: "#e8ff47",
  custom: "#ff8c47",
};
const STATUS_COLOR: Record<string, string> = {
  finished: "var(--success)",
  confirmed: "var(--success)",
  waiting: "var(--text-dim)",
  confirming: "var(--accent2)",
  partially_paid: "var(--warning)",
  failed: "var(--error)",
  expired: "var(--error)",
  cancelled: "var(--error)",
};

function fmt(b: number): string {
  if (b >= 1e12) return `${(b / 1e12).toFixed(1)}TB`;
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)}GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)}MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)}KB`;
  return `${b}B`;
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Plan Edit Modal ──────────────────────────────────────────────────────────
function PlanModal({
  user,
  onClose,
  onSave,
}: {
  user: AdminUser;
  onClose: () => void;
  onSave: (plan: Plan, customBytes?: number) => void;
}) {
  const [plan, setPlan] = useState<Plan>(user.plan);
  const [customGB, setCustomGB] = useState(
    user.customLimitBytes
      ? String(Math.round(user.customLimitBytes / 1024 / 1024 / 1024))
      : "",
  );
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    await onSave(
      plan,
      plan === "custom"
        ? parseFloat(customGB) * 1024 * 1024 * 1024 || undefined
        : undefined,
    );
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
            {(["free", "pro", "business", "custom"] as Plan[]).map((p) => (
              <button
                key={p}
                className={`${styles.planOption} ${plan === p ? styles.planOptionActive : ""}`}
                style={{ "--pc": PLAN_COLORS[p] } as React.CSSProperties}
                onClick={() => setPlan(p)}
              >
                <div className={styles.planOptionHeader}>
                  <span
                    className={styles.planOptionName}
                    style={{ color: PLAN_COLORS[p] }}
                  >
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </span>
                  <span className={styles.planOptionQuota}>
                    {p === "free"
                      ? "1 GB"
                      : p === "pro"
                        ? "10 GB"
                        : p === "business"
                          ? "50 GB"
                          : "Custom"}
                    /day
                  </span>
                </div>
                {plan === p && (
                  <span className={styles.planOptionCheck}>✓</span>
                )}
              </button>
            ))}
          </div>
          {plan === "custom" && (
            <div className={styles.customField}>
              <label className={styles.customLabel}>DAILY LIMIT (GB)</label>
              <div className={styles.customInputRow}>
                <input
                  className={styles.customInput}
                  type="number"
                  min="1"
                  value={customGB}
                  onChange={(e) => setCustomGB(e.target.value)}
                  placeholder="100"
                />
                <span className={styles.customUnit}>GB/day</span>
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

// ── Discount Modal ──────────────────────────────────────────────────────────
function DiscountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [code, setCode] = useState("");
  const [desc, setDesc] = useState("");
  const [pct, setPct] = useState("20");
  const [maxUses, setMax] = useState("");
  const [validUntil, setVU] = useState("");
  const [appliesTo, setAT] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const togglePlan = (p: string) =>
    setAT((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );

  const create = async () => {
    if (!code.trim() || !pct) {
      setErr("Code and discount % are required.");
      return;
    }
    setSaving(true);
    setErr("");
    const res = await fetch("/api/admin/discounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code.trim().toUpperCase(),
        description: desc || null,
        discountPct: Number(pct),
        maxUses: maxUses ? Number(maxUses) : null,
        validUntil: validUntil || null,
        appliesTo: appliesTo.length ? appliesTo : null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json();
      setErr(d.error ?? "Failed.");
      return;
    }
    onCreated();
    onClose();
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>Create Discount Code</span>
          <button className={styles.modalClose} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className={styles.modalBody}>
          <div className={styles.formGrid}>
            <div className={styles.formField}>
              <label className={styles.formLabel}>CODE *</label>
              <input
                className={styles.formInput}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="SAVE20"
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.formLabel}>DISCOUNT % *</label>
              <input
                className={styles.formInput}
                type="number"
                min="1"
                max="100"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                placeholder="20"
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.formLabel}>MAX USES</label>
              <input
                className={styles.formInput}
                type="number"
                min="1"
                value={maxUses}
                onChange={(e) => setMax(e.target.value)}
                placeholder="unlimited"
              />
            </div>
            <div className={styles.formField}>
              <label className={styles.formLabel}>VALID UNTIL</label>
              <input
                className={styles.formInput}
                type="datetime-local"
                value={validUntil}
                onChange={(e) => setVU(e.target.value)}
              />
            </div>
            <div className={`${styles.formField} ${styles.formFieldFull}`}>
              <label className={styles.formLabel}>DESCRIPTION</label>
              <input
                className={styles.formInput}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="Optional description"
              />
            </div>
            <div className={`${styles.formField} ${styles.formFieldFull}`}>
              <label className={styles.formLabel}>
                APPLIES TO (leave empty for all)
              </label>
              <div className={styles.planToggleRow}>
                {["pro", "business"].map((p) => (
                  <button
                    key={p}
                    className={`${styles.planToggleBtn} ${appliesTo.includes(p) ? styles.planToggleBtnActive : ""}`}
                    onClick={() => togglePlan(p)}
                    style={{
                      borderColor: appliesTo.includes(p)
                        ? PLAN_COLORS[p]
                        : undefined,
                      color: appliesTo.includes(p) ? PLAN_COLORS[p] : undefined,
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {err && (
            <div className={styles.formErr}>
              <span>✕</span>
              {err}
            </div>
          )}
        </div>
        <div className={styles.modalFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button className={styles.saveBtn} onClick={create} disabled={saving}>
            {saving ? "Creating…" : "Create Code"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Admin Page ──────────────────────────────────────────────────────────
export default function AdminPageView() {
  const router = useRouter();
  const [tab, setTab] = useState<AdminTab>("users");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [discounts, setDiscounts] = useState<DiscountCode[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [editPrices, setEditPrices] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selfId, setSelfId] = useState<string | null>(null);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [showDiscountModal, setShowDiscountModal] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [savingPrices, setSavingPrices] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, meRes, paymentsRes, pricesRes, discountsRes] =
        await Promise.all([
          fetch("/api/admin/users"),
          fetch("/api/auth/me"),
          fetch("/api/admin/payments"),
          fetch("/api/admin/prices"),
          fetch("/api/admin/discounts"),
        ]);
      if (usersRes.status === 403) {
        router.push("/");
        return;
      }
      const [ud, md, pd, prd, dd] = await Promise.all([
        usersRes.json(),
        meRes.json(),
        paymentsRes.json(),
        pricesRes.json(),
        discountsRes.json(),
      ]);
      setUsers(ud.users ?? []);
      setStats(ud.stats ?? null);
      setSelfId(md.user?.id ?? null);
      setPayments(pd.payments ?? []);
      setPrices(prd.prices ?? {});
      setEditPrices(
        Object.fromEntries(
          Object.entries(prd.prices ?? {}).map(([k, v]) => [k, String(v)]),
        ),
      );
      setDiscounts(dd.discounts ?? []);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (id: string, body: object) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (res.ok)
        setUsers((prev) =>
          prev.map((u) =>
            u.id === id
              ? {
                  ...u,
                  ...d.user,
                  planLabel: u.planLabel,
                  planColor: PLAN_COLORS[d.user.plan] ?? "#5a6a7a",
                }
              : u,
          ),
        );
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const savePrices = async () => {
    setSavingPrices(true);
    const prices: Record<string, number> = {};
    for (const [k, v] of Object.entries(editPrices)) {
      const n = parseFloat(v);
      if (n > 0) prices[k] = n;
    }
    const res = await fetch("/api/admin/prices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prices }),
    });
    if (res.ok) {
      const d = await res.json();
      setPrices(d.prices);
    }
    setSavingPrices(false);
  };

  const toggleDiscount = async (id: string, isActive: boolean) => {
    await fetch(`/api/admin/discounts?id=${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    });
    setDiscounts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, is_active: isActive } : d)),
    );
  };
  const deleteDiscount = async (id: string) => {
    if (!confirm("Delete this discount code?")) return;
    await fetch(`/api/admin/discounts?id=${id}`, { method: "DELETE" });
    setDiscounts((prev) => prev.filter((d) => d.id !== id));
  };

  const filteredUsers = users.filter((u) => {
    const q = search.toLowerCase();
    return (
      !q ||
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q)
    );
  });

  if (loading)
    return (
      <main className={styles.main}>
        <div className={styles.grid} aria-hidden />
        <div className={styles.centerMsg}>
          <span className={styles.spinDot} />
          <span>Loading admin panel…</span>
        </div>
      </main>
    );

  return (
    <main className={styles.main}>
      <div className={styles.grid} aria-hidden />
      <div className={styles.container}>
        {/* Header */}
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <a href="/" className={styles.backLink}>
              ← App
            </a>
            <div className={styles.logo}>
              <span className={styles.logoIcon}>⬡</span>
              <span className={styles.logoText}>VAULTCHUNK</span>
            </div>
            <span className={styles.adminBadge}>ADMIN</span>
          </div>
          <button className={styles.refreshBtn} onClick={load}>
            ↻ Refresh
          </button>
        </header>

        {/* Stats */}
        {stats && (
          <div className={styles.statsRow}>
            {[
              ["Users", stats.users],
              ["Files", stats.files],
              ["Storage", fmt(stats.totalBytes)],
              ["Today", stats.todayUploads],
              ["Payments", stats.totalPayments],
              ["Pending", stats.pendingPayments],
              ["Revenue", `$${stats.totalRevenue.toFixed(2)}`],
            ].map(([l, v]) => (
              <div key={String(l)} className={styles.statCard}>
                <span className={styles.statVal}>{String(v)}</span>
                <span className={styles.statLabel}>{String(l)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className={styles.adminTabs}>
          {(["users", "payments", "prices", "discounts"] as AdminTab[]).map(
            (t) => (
              <button
                key={t}
                className={`${styles.adminTab} ${tab === t ? styles.adminTabActive : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "users" && "👤 Users"}
                {t === "payments" && "◎ Payments"}
                {t === "prices" && "$ Prices"}
                {t === "discounts" && "% Discounts"}
              </button>
            ),
          )}
        </div>

        {/* ── USERS TAB ── */}
        {tab === "users" && (
          <>
            <div className={styles.filters}>
              <input
                className={styles.searchInput}
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className={styles.resultCount}>
                {filteredUsers.length}/{users.length} users
              </span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Plan</th>
                    <th>Today&apos;s Usage</th>
                    <th>Storage</th>
                    <th>Verified</th>
                    <th>Joined</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length === 0 && (
                    <tr>
                      <td colSpan={7} className={styles.emptyRow}>
                        No users found.
                      </td>
                    </tr>
                  )}
                  {filteredUsers.map((u) => {
                    const isSelf = u.id === selfId;
                    const isLoading = busy[u.id];
                    const limit =
                      u.plan === "custom" && u.customLimitBytes
                        ? u.customLimitBytes
                        : ({ free: 1, pro: 10, business: 50, custom: 0 }[
                            u.plan
                          ] ?? 1) *
                          1024 *
                          1024 *
                          1024;
                    const pct = Math.min(
                      100,
                      Math.round((u.bytesUsedToday / limit) * 100),
                    );
                    return (
                      <tr
                        key={u.id}
                        className={`${styles.row} ${u.isBlocked ? styles.rowBlocked : ""} ${isSelf ? styles.rowSelf : ""}`}
                      >
                        <td className={styles.cellUser}>
                          <div
                            className={styles.userAvatar}
                            style={{
                              background: u.isAdmin
                                ? "rgba(232,255,71,.15)"
                                : "rgba(71,255,212,.08)",
                            }}
                          >
                            {u.name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className={styles.userName}>
                              {u.name}
                              {u.isAdmin && (
                                <span className={styles.adminTag}>ADMIN</span>
                              )}
                              {isSelf && (
                                <span className={styles.selfTag}>YOU</span>
                              )}
                            </div>
                            <div className={styles.userEmail}>{u.email}</div>
                          </div>
                        </td>
                        <td>
                          <span
                            className={styles.planBadge}
                            style={{
                              borderColor: u.planColor,
                              color: u.planColor,
                            }}
                          >
                            {u.planLabel}
                          </span>
                        </td>
                        <td className={styles.cellUsage}>
                          <div className={styles.usageRow}>
                            <span className={styles.usageText}>
                              {fmt(u.bytesUsedToday)}
                            </span>
                            <span className={styles.usageOf}>
                              /{fmt(limit)}
                            </span>
                          </div>
                          <div className={styles.usageBar}>
                            <div
                              className={styles.usageFill}
                              style={{
                                width: `${pct}%`,
                                background:
                                  pct >= 90
                                    ? "var(--error)"
                                    : pct >= 70
                                      ? "var(--warning)"
                                      : "var(--accent2)",
                              }}
                            />
                          </div>
                        </td>
                        <td className={styles.cellMono}>
                          {fmt(u.totalBytesStored)}
                        </td>
                        <td>
                          <span
                            style={{
                              color: u.isVerified
                                ? "var(--success)"
                                : "var(--error)",
                              fontSize: 12,
                            }}
                          >
                            {u.isVerified ? "✓ Yes" : "✕ No"}
                          </span>
                        </td>
                        <td className={styles.cellDim}>
                          {fmtDate(u.createdAt)}
                        </td>
                        <td className={styles.cellActions}>
                          <button
                            className={`${styles.actionBtn} ${u.isBlocked ? styles.actionBtnGreen : styles.actionBtnRed}`}
                            onClick={() =>
                              patch(u.id, {
                                action: u.isBlocked ? "unblock" : "block",
                              })
                            }
                            disabled={isLoading || isSelf}
                          >
                            {isLoading
                              ? "…"
                              : u.isBlocked
                                ? "Unblock"
                                : "Block"}
                          </button>
                          <button
                            className={`${styles.actionBtn} ${styles.actionBtnAccent}`}
                            onClick={() => setEditUser(u)}
                            disabled={isLoading}
                          >
                            Plan
                          </button>
                          <button
                            className={`${styles.actionBtn} ${u.isAdmin ? styles.actionBtnWarn : styles.actionBtnGhost}`}
                            onClick={() =>
                              patch(u.id, {
                                action: "setAdmin",
                                isAdmin: !u.isAdmin,
                              })
                            }
                            disabled={isLoading || isSelf}
                          >
                            {u.isAdmin ? "−Admin" : "+Admin"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── PAYMENTS TAB ── */}
        {tab === "payments" && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Plan</th>
                  <th>Amount</th>
                  <th>Discount</th>
                  <th>Crypto</th>
                  <th>Status</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {payments.length === 0 && (
                  <tr>
                    <td colSpan={7} className={styles.emptyRow}>
                      No payments yet.
                    </td>
                  </tr>
                )}
                {payments.map((p) => (
                  <tr key={p.id} className={styles.row}>
                    <td
                      className={styles.cellUser}
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <div>
                        <div className={styles.userName}>{p.userName}</div>
                        <div className={styles.userEmail}>{p.userEmail}</div>
                      </div>
                    </td>
                    <td>
                      <span
                        className={styles.planBadge}
                        style={{
                          borderColor: PLAN_COLORS[p.plan],
                          color: PLAN_COLORS[p.plan],
                        }}
                      >
                        {p.plan}
                      </span>
                    </td>
                    <td className={styles.cellMono}>
                      <div>${p.finalUsd.toFixed(2)}</div>
                      {p.discountPct > 0 && (
                        <div style={{ fontSize: 10, color: "var(--success)" }}>
                          was ${p.priceUsd}
                        </div>
                      )}
                    </td>
                    <td className={styles.cellDim}>
                      {p.discountCode ? (
                        <span style={{ color: "var(--success)" }}>
                          {p.discountCode} ({p.discountPct}%)
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={styles.cellMono}>
                      {p.payAmount && p.payCurrency
                        ? `${p.payAmount} ${p.payCurrency}`
                        : "—"}
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: 11,
                          color: STATUS_COLOR[p.status] ?? "var(--text-dim)",
                          border: `1px solid ${STATUS_COLOR[p.status] ?? "var(--border)"}`,
                          padding: "2px 8px",
                          borderRadius: 2,
                        }}
                      >
                        {p.status}
                      </span>
                    </td>
                    <td className={styles.cellDim}>{fmtDate(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── PRICES TAB ── */}
        {tab === "prices" && (
          <div className={styles.pricesSection}>
            <p className={styles.pricesSub}>
              Set the monthly USD price for each paid plan. Changes take effect
              immediately for new payments.
            </p>
            <div className={styles.pricesGrid}>
              {["pro", "business"].map((plan) => (
                <div key={plan} className={styles.priceCard}>
                  <div className={styles.priceCardHeader}>
                    <span
                      className={styles.priceCardLabel}
                      style={{ color: PLAN_COLORS[plan] }}
                    >
                      {plan.charAt(0).toUpperCase() + plan.slice(1)}
                    </span>
                    <span className={styles.priceCardCurrent}>
                      Current: ${prices[plan] ?? "-"}/mo
                    </span>
                  </div>
                  <div className={styles.priceInputRow}>
                    <span className={styles.priceDollar}>$</span>
                    <input
                      className={styles.priceInput}
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={editPrices[plan] ?? ""}
                      onChange={(e) =>
                        setEditPrices((p) => ({ ...p, [plan]: e.target.value }))
                      }
                      placeholder="9.00"
                    />
                    <span className={styles.priceUnit}>/mo</span>
                  </div>
                </div>
              ))}
            </div>
            <button
              className={styles.savePricesBtn}
              onClick={savePrices}
              disabled={savingPrices}
            >
              {savingPrices ? "Saving…" : "Save Prices"}
            </button>
          </div>
        )}

        {/* ── DISCOUNTS TAB ── */}
        {tab === "discounts" && (
          <>
            <div className={styles.discountHeader}>
              <p className={styles.pricesSub}>
                Create time-limited discount codes for plan upgrades.
              </p>
              <button
                className={styles.createDiscountBtn}
                onClick={() => setShowDiscountModal(true)}
              >
                + Create Code
              </button>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Discount</th>
                    <th>Uses</th>
                    <th>Valid Until</th>
                    <th>Plans</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {discounts.length === 0 && (
                    <tr>
                      <td colSpan={7} className={styles.emptyRow}>
                        No discount codes yet.
                      </td>
                    </tr>
                  )}
                  {discounts.map((d) => (
                    <tr
                      key={d.id}
                      className={`${styles.row} ${!d.is_active ? styles.rowBlocked : ""}`}
                    >
                      <td>
                        <code
                          style={{
                            fontSize: 13,
                            color: "var(--accent)",
                            letterSpacing: ".1em",
                          }}
                        >
                          {d.code}
                        </code>
                        {d.description && (
                          <div
                            style={{
                              fontSize: 10,
                              color: "var(--text-dim)",
                              marginTop: 2,
                            }}
                          >
                            {d.description}
                          </div>
                        )}
                      </td>
                      <td
                        className={styles.cellMono}
                        style={{ color: "var(--success)" }}
                      >
                        {d.discount_pct}%
                      </td>
                      <td className={styles.cellMono}>
                        {d.uses_count}
                        {d.max_uses ? `/${d.max_uses}` : ""}
                      </td>
                      <td className={styles.cellDim}>
                        {d.valid_until ? fmtDate(d.valid_until) : "Never"}
                      </td>
                      <td className={styles.cellDim}>
                        {d.applies_to?.join(", ") || "All"}
                      </td>
                      <td>
                        <span
                          style={{
                            fontSize: 11,
                            color: d.is_active
                              ? "var(--success)"
                              : "var(--error)",
                            border: `1px solid ${d.is_active ? "var(--success)" : "var(--error)"}`,
                            padding: "2px 8px",
                            borderRadius: 2,
                          }}
                        >
                          {d.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className={styles.cellActions}>
                        <button
                          className={`${styles.actionBtn} ${d.is_active ? styles.actionBtnWarn : styles.actionBtnGreen}`}
                          onClick={() => toggleDiscount(d.id, !d.is_active)}
                        >
                          {d.is_active ? "Disable" : "Enable"}
                        </button>
                        <button
                          className={`${styles.actionBtn} ${styles.actionBtnRed}`}
                          onClick={() => deleteDiscount(d.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {editUser && (
        <PlanModal
          user={editUser}
          onClose={() => setEditUser(null)}
          onSave={(plan, customBytes) =>
            patch(editUser.id, {
              action: "setPlan",
              plan,
              customLimitBytes: customBytes ?? null,
            })
          }
        />
      )}
      {showDiscountModal && (
        <DiscountModal
          onClose={() => setShowDiscountModal(false)}
          onCreated={load}
        />
      )}
    </main>
  );
}
