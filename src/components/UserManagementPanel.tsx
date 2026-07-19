"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Plus, Save, Trash2, UserPlus } from "lucide-react";
import type { UserAccountPublic } from "@/lib/types";
import { formatDate } from "@/components/format";

function Badge({
  tone,
  children
}: {
  tone: "good" | "warn" | "danger" | "neutral";
  children: React.ReactNode;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function roleLabel(role: UserAccountPublic["role"]): string {
  return role === "admin" ? "ادمین" : "بیننده";
}

function sourceLabel(source: UserAccountPublic["source"]): string {
  return source === "env" ? "سیستمی" : "ساخته‌شده در پنل";
}

export function UserManagementPanel() {
  const [users, setUsers] = useState<UserAccountPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [passwordMin, setPasswordMin] = useState(10);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [newRole, setNewRole] = useState<"viewer" | "admin">("viewer");
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const [resetForId, setResetForId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setListError(null);
    try {
      const response = await fetch("/api/users", {
        cache: "no-store",
        credentials: "same-origin"
      });
      const payload = (await response.json()) as {
        users?: UserAccountPublic[];
        limits?: { passwordMin?: number };
        message?: string;
      };
      if (!response.ok) {
        setListError(payload.message ?? "بارگذاری کاربران ناموفق بود");
        return;
      }
      setUsers(payload.users ?? []);
      if (payload.limits?.passwordMin) setPasswordMin(payload.limits.passwordMin);
    } catch {
      setListError("بارگذاری کاربران ناموفق بود");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function createUser() {
    setCreating(true);
    setCreateMessage(null);
    setCreateError(null);
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          confirmPassword: newPasswordConfirm,
          role: newRole
        })
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        users?: UserAccountPublic[];
      };
      if (!response.ok || !payload.ok) {
        setCreateError(payload.message ?? "ایجاد کاربر ناموفق بود");
        return;
      }
      setNewUsername("");
      setNewPassword("");
      setNewPasswordConfirm("");
      setNewRole("viewer");
      setCreateMessage(payload.message ?? "کاربر ایجاد شد");
      if (payload.users) setUsers(payload.users);
      else await loadUsers();
    } catch {
      setCreateError("ایجاد کاربر ناموفق بود");
    } finally {
      setCreating(false);
    }
  }

  async function submitResetPassword() {
    if (!resetForId) return;
    setResetting(true);
    setResetMessage(null);
    setResetError(null);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(resetForId)}/password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          newPassword: resetPassword,
          confirmPassword: resetPasswordConfirm
        })
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        users?: UserAccountPublic[];
      };
      if (!response.ok || !payload.ok) {
        setResetError(payload.message ?? "تغییر رمز ناموفق بود");
        return;
      }
      setResetPassword("");
      setResetPasswordConfirm("");
      setResetMessage(payload.message ?? "رمز ذخیره شد");
      if (payload.users) setUsers(payload.users);
      else await loadUsers();
    } catch {
      setResetError("تغییر رمز ناموفق بود");
    } finally {
      setResetting(false);
    }
  }

  async function deleteUser(user: UserAccountPublic) {
    if (!user.canDelete) return;
    const ok = window.confirm(`کاربر «${user.username}» حذف شود؟`);
    if (!ok) return;
    setBusyId(user.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: "DELETE",
        credentials: "same-origin"
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        users?: UserAccountPublic[];
      };
      if (!response.ok || !payload.ok) {
        setActionError(payload.message ?? "حذف کاربر ناموفق بود");
        return;
      }
      if (resetForId === user.id) {
        setResetForId(null);
        setResetPassword("");
        setResetPasswordConfirm("");
      }
      if (payload.users) setUsers(payload.users);
      else await loadUsers();
    } catch {
      setActionError("حذف کاربر ناموفق بود");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEnabled(user: UserAccountPublic) {
    if (user.source !== "managed") return;
    setBusyId(user.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ enabled: !user.enabled })
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        message?: string;
        users?: UserAccountPublic[];
      };
      if (!response.ok || !payload.ok) {
        setActionError(payload.message ?? "تغییر وضعیت ناموفق بود");
        return;
      }
      if (payload.users) setUsers(payload.users);
      else await loadUsers();
    } catch {
      setActionError("تغییر وضعیت ناموفق بود");
    } finally {
      setBusyId(null);
    }
  }

  const resetTarget = users.find((u) => u.id === resetForId) ?? null;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <p className="muted" style={{ marginTop: 0 }}>
        از اینجا می‌توانید کاربر جدید بسازید، برایشان رمز بگذارید، رمز را ریست کنید یا کاربر
        ساخته‌شده در پنل را حذف کنید. رمز admin سیستمی فقط از سرور عوض می‌شود. بعد از ریست
        رمز، نشست‌های قبلی همان کاربر باطل می‌شود.
      </p>

      {loading ? <p className="muted">در حال بارگذاری کاربران…</p> : null}
      {listError ? <Badge tone="danger">{listError}</Badge> : null}
      {actionError ? <Badge tone="danger">{actionError}</Badge> : null}

      {!loading && !listError ? (
        <div className="table-wrap" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 560 }}>
            <thead>
              <tr>
                <th>نام کاربری</th>
                <th>نقش</th>
                <th>منبع</th>
                <th>وضعیت</th>
                <th>آخرین تغییر</th>
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.username}</strong>
                    {!user.passwordConfigured ? (
                      <>
                        {" "}
                        <Badge tone="warn">بدون رمز</Badge>
                      </>
                    ) : null}
                  </td>
                  <td>{roleLabel(user.role)}</td>
                  <td className="muted">{sourceLabel(user.source)}</td>
                  <td>
                    {user.enabled ? (
                      <Badge tone="good">فعال</Badge>
                    ) : (
                      <Badge tone="danger">غیرفعال</Badge>
                    )}
                  </td>
                  <td className="muted">
                    {user.updatedAt
                      ? `${formatDate(user.updatedAt)}${user.updatedBy ? ` — ${user.updatedBy}` : ""}`
                      : "—"}
                  </td>
                  <td>
                    <div className="user-mgmt-actions">
                      {user.canResetPassword ? (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setResetForId(user.id);
                            setResetPassword("");
                            setResetPasswordConfirm("");
                            setResetMessage(null);
                            setResetError(null);
                          }}
                          disabled={busyId === user.id}
                        >
                          <KeyRound aria-hidden="true" size={14} />
                          ریست رمز
                        </button>
                      ) : (
                        <span className="muted">رمز فقط از سرور</span>
                      )}
                      {user.source === "managed" ? (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            void toggleEnabled(user);
                          }}
                          disabled={busyId === user.id}
                        >
                          {user.enabled ? "غیرفعال" : "فعال‌سازی"}
                        </button>
                      ) : null}
                      {user.canDelete ? (
                        <button
                          type="button"
                          className="text-button danger"
                          onClick={() => {
                            void deleteUser(user);
                          }}
                          disabled={busyId === user.id}
                        >
                          <Trash2 aria-hidden="true" size={14} />
                          حذف
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {resetTarget ? (
        <div
          className="panel-inset"
          style={{
            border: "1px solid var(--border, #333)",
            borderRadius: 12,
            padding: 16
          }}
        >
          <h3 style={{ marginTop: 0, fontSize: "1rem" }}>
            ریست رمز — {resetTarget.username}
          </h3>
          <div className="grid settings-grid">
            <div className="field">
              <label>رمز جدید</label>
              <input
                type="password"
                autoComplete="new-password"
                value={resetPassword}
                onChange={(event) => setResetPassword(event.target.value)}
                placeholder={`حداقل ${passwordMin} کاراکتر`}
              />
            </div>
            <div className="field">
              <label>تکرار رمز جدید</label>
              <input
                type="password"
                autoComplete="new-password"
                value={resetPasswordConfirm}
                onChange={(event) => setResetPasswordConfirm(event.target.value)}
                placeholder="تکرار رمز"
              />
            </div>
          </div>
          <div className="row-meta" style={{ marginTop: 12, gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                void submitResetPassword();
              }}
              disabled={resetting || !resetPassword || !resetPasswordConfirm}
            >
              <Save aria-hidden="true" />
              {resetting ? "در حال ذخیره…" : "ذخیره رمز"}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setResetForId(null);
                setResetPassword("");
                setResetPasswordConfirm("");
                setResetMessage(null);
                setResetError(null);
              }}
            >
              انصراف
            </button>
            {resetMessage ? <Badge tone="good">{resetMessage}</Badge> : null}
            {resetError ? <Badge tone="danger">{resetError}</Badge> : null}
          </div>
        </div>
      ) : null}

      <div
        className="panel-inset"
        style={{
          border: "1px solid var(--border, #333)",
          borderRadius: 12,
          padding: 16
        }}
      >
        <h3 style={{ marginTop: 0, fontSize: "1rem", display: "flex", alignItems: "center", gap: 8 }}>
          <UserPlus aria-hidden="true" size={18} />
          کاربر جدید
        </h3>
        <div className="grid settings-grid">
          <div className="field">
            <label>نام کاربری</label>
            <input
              type="text"
              autoComplete="off"
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
              placeholder="مثلاً trader01"
            />
          </div>
          <div className="field">
            <label>نقش</label>
            <select
              value={newRole}
              onChange={(event) => setNewRole(event.target.value === "admin" ? "admin" : "viewer")}
            >
              <option value="viewer">بیننده (viewer)</option>
              <option value="admin">ادمین (admin)</option>
            </select>
          </div>
          <div className="field">
            <label>رمز عبور</label>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder={`حداقل ${passwordMin} کاراکتر`}
            />
          </div>
          <div className="field">
            <label>تکرار رمز</label>
            <input
              type="password"
              autoComplete="new-password"
              value={newPasswordConfirm}
              onChange={(event) => setNewPasswordConfirm(event.target.value)}
              placeholder="تکرار رمز"
            />
          </div>
        </div>
        <div className="row-meta" style={{ marginTop: 12, gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="primary-button"
            onClick={() => {
              void createUser();
            }}
            disabled={
              creating || !newUsername.trim() || !newPassword || !newPasswordConfirm
            }
          >
            <Plus aria-hidden="true" />
            {creating ? "در حال ایجاد…" : "ایجاد کاربر"}
          </button>
          {createMessage ? <Badge tone="good">{createMessage}</Badge> : null}
          {createError ? <Badge tone="danger">{createError}</Badge> : null}
        </div>
      </div>
    </div>
  );
}
