"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import styles from "./AdminPage.view.module.css";

// ── TYPES ─────────────────────────────────────────────────────────────────────
type Plan = "free" | "pro" | "business" | "custom";
interface AdminUser {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  isBlocked: boolean;
  plan: Plan;
  planLabel: string;
  planColor: string;
  customLimitBytes: number | null;
  fileCount: number;
  totalBytesStored: number;
  bytesUsedToday: number;
  createdAt: string;
}
interface GlobalStats {
  users: number;
  files: number;
  totalBytes: number;
  blocked: number;
  todayUploads: number;
}

const PLANS: Record<Plan, { label: string; color: string; quota: string }> = {
  free: { label: "Free", color: "#5a6a7a", quota: "1 GB/day" },
  pro: { label: "Pro", color: "#47ffd4", quota: "10 GB/day" },
  business: { label: "Business", color: "#e8ff47", quota: "50 GB/day" },
  custom: { label: "Custom", color: "#ff8c47", quota: "Custom" },
};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function fmt(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── STAT CARD ─────────────────────────────────────────────────────────────────
function StatCard({
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

// ── PLAN BADGE ────────────────────────────────────────────────────────────────
function PlanBadge({ plan }: { plan: Plan }) {
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

// ── EDIT PLAN MODAL ───────────────────────────────────────────────────────────
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

// ── MAIN ADMIN PAGE ───────────────────────────────────────────────────────────
export default function AdminPageView() {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterPlan, setFilterPlan] = useState<Plan | "all">("all");
  const [filterStatus, setFilterStatus] = useState<
    "all" | "active" | "blocked"
  >("all");
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [selfId, setSelfId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, meRes] = await Promise.all([
        fetch("/api/admin/users"),
        fetch("/api/auth/me"),
      ]);
      if (usersRes.status === 403) {
        router.push("/");
        return;
      }
      const { users: u, stats: s } = await usersRes.json();
      const { user: me } = await meRes.json();
      setUsers(u ?? []);
      setStats(s ?? null);
      setSelfId(me?.id ?? null);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Filtered list ──────────────────────────────────────────────────────────
  const visible = users.filter((u) => {
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q);
    const matchPlan = filterPlan === "all" || u.plan === filterPlan;
    const matchStatus =
      filterStatus === "all" ||
      (filterStatus === "blocked" ? u.isBlocked : !u.isBlocked);
    return matchSearch && matchPlan && matchStatus;
  });

  // ── Actions ────────────────────────────────────────────────────────────────
  const patch = async (id: string, body: object) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok)
        setUsers((prev) =>
          prev.map((u) =>
            u.id === id
              ? {
                  ...u,
                  ...data.user,
                  planLabel:
                    PLANS[data.user.plan as Plan]?.label ?? data.user.plan,
                  planColor: PLANS[data.user.plan as Plan]?.color ?? "#5a6a7a",
                }
              : u,
          ),
        );
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const toggleBlock = (u: AdminUser) =>
    patch(u.id, { action: u.isBlocked ? "unblock" : "block" });
  const toggleAdmin = (u: AdminUser) =>
    patch(u.id, { action: "setAdmin", isAdmin: !u.isAdmin });
  const savePlan = (u: AdminUser, plan: Plan, customBytes?: number) =>
    patch(u.id, {
      action: "setPlan",
      plan,
      customLimitBytes: customBytes ?? null,
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

      {/* HEADER */}
      <div className={styles.container}>
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

        {/* STATS ROW */}
        {stats && (
          <div className={styles.statsRow}>
            <StatCard label="Total Users" value={stats.users} />
            <StatCard label="Total Files" value={stats.files} />
            <StatCard label="Storage Used" value={fmt(stats.totalBytes)} />
            <StatCard
              label="Today's Uploads"
              value={stats.todayUploads}
              accent
            />
            <StatCard label="Blocked Users" value={stats.blocked} />
          </div>
        )}

        {/* PLAN DISTRIBUTION */}
        {stats && (
          <div className={styles.planDist}>
            {(Object.entries(PLANS) as [Plan, (typeof PLANS)[Plan]][]).map(
              ([key, p]) => {
                const count = users.filter((u) => u.plan === key).length;
                const pct =
                  users.length > 0
                    ? Math.round((count / users.length) * 100)
                    : 0;
                return (
                  <div key={key} className={styles.planDistItem}>
                    <div className={styles.planDistHeader}>
                      <span
                        style={{
                          color: p.color,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {p.label}
                      </span>
                      <span className={styles.planDistCount}>
                        {count} users
                      </span>
                    </div>
                    <div className={styles.planDistBar}>
                      <div
                        className={styles.planDistFill}
                        style={{ width: `${pct}%`, background: p.color }}
                      />
                    </div>
                    <span className={styles.planDistPct}>{pct}%</span>
                  </div>
                );
              },
            )}
          </div>
        )}

        {/* FILTERS */}
        <div className={styles.filters}>
          <input
            className={styles.searchInput}
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>PLAN</span>
            {(
              ["all", "free", "pro", "business", "custom"] as (Plan | "all")[]
            ).map((p) => (
              <button
                key={p}
                className={`${styles.filterBtn} ${filterPlan === p ? styles.filterBtnActive : ""}`}
                onClick={() => setFilterPlan(p)}
              >
                {p === "all" ? "All" : PLANS[p as Plan]?.label}
              </button>
            ))}
          </div>
          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>STATUS</span>
            {(["all", "active", "blocked"] as const).map((s) => (
              <button
                key={s}
                className={`${styles.filterBtn} ${filterStatus === s ? styles.filterBtnActive : ""}`}
                onClick={() => setFilterStatus(s)}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <span className={styles.resultCount}>
            {visible.length} / {users.length} users
          </span>
        </div>

        {/* USER TABLE */}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>User</th>
                <th>Plan</th>
                <th>Today's Usage</th>
                <th>Storage</th>
                <th>Files</th>
                <th>Joined</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className={styles.emptyRow}>
                    No users match the filter.
                  </td>
                </tr>
              )}
              {visible.map((u) => {
                const isSelf = u.id === selfId;
                const loading = busy[u.id];
                const dailyLimit =
                  u.plan === "custom" && u.customLimitBytes
                    ? u.customLimitBytes
                    : ({ free: 1, pro: 10, business: 50 }[u.plan] ?? 1) *
                      1024 *
                      1024 *
                      1024;
                const pct = Math.min(
                  100,
                  Math.round((u.bytesUsedToday / dailyLimit) * 100),
                );

                return (
                  <tr
                    key={u.id}
                    className={`${styles.row} ${u.isBlocked ? styles.rowBlocked : ""} ${isSelf ? styles.rowSelf : ""}`}
                  >
                    {/* User */}
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

                    {/* Plan */}
                    <td>
                      <PlanBadge plan={u.plan} />
                      {u.plan === "custom" && u.customLimitBytes && (
                        <div className={styles.customQuota}>
                          {fmt(u.customLimitBytes)}/day
                        </div>
                      )}
                    </td>

                    {/* Today usage */}
                    <td className={styles.cellUsage}>
                      <div className={styles.usageRow}>
                        <span className={styles.usageText}>
                          {fmt(u.bytesUsedToday)}
                        </span>
                        <span className={styles.usageOf}>
                          / {fmt(dailyLimit)}
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
                      <span className={styles.usagePct}>{pct}%</span>
                    </td>

                    {/* Storage */}
                    <td className={styles.cellMono}>
                      {fmt(u.totalBytesStored)}
                    </td>

                    {/* Files */}
                    <td className={styles.cellMono}>{u.fileCount}</td>

                    {/* Joined */}
                    <td className={styles.cellDim}>{fmtDate(u.createdAt)}</td>

                    {/* Actions */}
                    <td className={styles.cellActions}>
                      {/* Block / Unblock */}
                      <button
                        className={`${styles.actionBtn} ${u.isBlocked ? styles.actionBtnGreen : styles.actionBtnRed}`}
                        onClick={() => toggleBlock(u)}
                        disabled={loading || isSelf}
                        title={u.isBlocked ? "Unblock user" : "Block user"}
                      >
                        {loading ? "…" : u.isBlocked ? "Unblock" : "Block"}
                      </button>

                      {/* Edit plan */}
                      <button
                        className={`${styles.actionBtn} ${styles.actionBtnAccent}`}
                        onClick={() => setEditUser(u)}
                        disabled={loading}
                        title="Change plan"
                      >
                        Plan
                      </button>

                      {/* Toggle admin */}
                      <button
                        className={`${styles.actionBtn} ${u.isAdmin ? styles.actionBtnWarn : styles.actionBtnGhost}`}
                        onClick={() => toggleAdmin(u)}
                        disabled={loading || isSelf}
                        title={u.isAdmin ? "Remove admin" : "Make admin"}
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
      </div>

      {/* PLAN EDIT MODAL */}
      {editUser && (
        <PlanModal
          user={editUser}
          onClose={() => setEditUser(null)}
          onSave={(plan, customBytes) => savePlan(editUser, plan, customBytes)}
        />
      )}
    </main>
  );
}
