"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import type { ApiKeyPublic, ApiKeyScope } from "@/lib/apiKeys/types";
import { ALL_API_KEY_SCOPES, API_KEY_SCOPE_LABELS } from "@/lib/apiKeys/types";
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

function statusTone(status: ApiKeyPublic["status"]): "good" | "warn" | "danger" | "neutral" {
  if (status === "active") return "good";
  if (status === "expired") return "warn";
  return "danger";
}

function statusLabel(status: ApiKeyPublic["status"]): string {
  if (status === "active") return "فعال";
  if (status === "expired") return "منقضی";
  return "لغو‌شده";
}

const SCOPE_ENDPOINTS: Record<ApiKeyScope, string> = {
  "tether:read": "/api/v1/tether-prices",
  "usd:read": "/api/v1/usd-prices",
  "aed:read": "/api/v1/aed-prices",
  "gold:read": "/api/v1/gold-prices"
};

function ScopeChecklist({
  selected,
  onChange,
  idPrefix
}: {
  selected: ApiKeyScope[];
  onChange: (next: ApiKeyScope[]) => void;
  idPrefix: string;
}) {
  const set = new Set(selected);
  function toggle(scope: ApiKeyScope) {
    const next = new Set(set);
    if (next.has(scope)) next.delete(scope);
    else next.add(scope);
    onChange([...next]);
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          className="button"
          style={{ fontSize: 12, padding: "4px 10px" }}
          onClick={() => onChange([...ALL_API_KEY_SCOPES])}
        >
          انتخاب همه
        </button>
        <button
          type="button"
          className="button"
          style={{ fontSize: 12, padding: "4px 10px" }}
          onClick={() => onChange([])}
        >
          پاک‌کردن انتخاب‌ها
        </button>
      </div>
      <div className="toggle-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
        {ALL_API_KEY_SCOPES.map((scope) => (
          <label className="toggle" key={scope} htmlFor={`${idPrefix}-${scope}`}>
            <span>{API_KEY_SCOPE_LABELS[scope]}</span>
            <input
              id={`${idPrefix}-${scope}`}
              type="checkbox"
              checked={set.has(scope)}
              onChange={() => toggle(scope)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

export function TetherApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [storageNote, setStorageNote] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [createScopes, setCreateScopes] = useState<ApiKeyScope[]>(["tether:read"]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [plaintextOnce, setPlaintextOnce] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [editScopes, setEditScopes] = useState<ApiKeyScope[]>([]);
  const [editSaving, setEditSaving] = useState(false);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setListError(null);
    try {
      const response = await fetch("/api/admin/api-keys", {
        cache: "no-store",
        credentials: "same-origin"
      });
      const payload = (await response.json()) as {
        keys?: ApiKeyPublic[];
        message?: string;
        storage?: { backend?: string; durable?: boolean };
      };
      if (!response.ok) {
        setListError(payload.message ?? "بارگذاری کلیدها ناموفق بود");
        setKeys([]);
        return;
      }
      setKeys(payload.keys ?? []);
      if (payload.storage && payload.storage.durable === false) {
        setStorageNote("ذخیره‌سازی پایدار پیکربندی نشده — ایجاد کلید ممکن نیست.");
      } else {
        setStorageNote(null);
      }
    } catch {
      setListError("بارگذاری کلیدها ناموفق بود");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  async function createKey() {
    setCreating(true);
    setCreateError(null);
    setPlaintextOnce(null);
    setCopied(false);
    if (!createScopes.length) {
      setCreateError("حداقل یک سطح دسترسی باید انتخاب شود.");
      setCreating(false);
      return;
    }
    try {
      const response = await fetch("/api/admin/api-keys", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          scopes: createScopes
        })
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        plaintext?: string;
        message?: string;
      };
      if (!response.ok || !payload.ok || !payload.plaintext) {
        setCreateError(payload.message ?? "ایجاد کلید ناموفق بود");
        return;
      }
      setPlaintextOnce(payload.plaintext);
      setName("");
      setExpiresAt("");
      setCreateScopes(["tether:read"]);
      await loadKeys();
    } catch {
      setCreateError("ایجاد کلید ناموفق بود");
    } finally {
      setCreating(false);
    }
  }

  async function saveEditScopes() {
    if (!editId) return;
    if (!editScopes.length) {
      setActionError("حداقل یک سطح دسترسی باید انتخاب شود.");
      return;
    }
    setEditSaving(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/admin/api-keys/${editId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scopes: editScopes })
      });
      const payload = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !payload.ok) {
        setActionError(payload.message ?? "به‌روزرسانی دسترسی‌ها ناموفق بود");
        return;
      }
      setEditId(null);
      await loadKeys();
    } catch {
      setActionError("به‌روزرسانی دسترسی‌ها ناموفق بود");
    } finally {
      setEditSaving(false);
    }
  }

  async function copyPlaintext() {
    if (!plaintextOnce) return;
    try {
      await navigator.clipboard.writeText(plaintextOnce);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCreateError("کپی در کلیپ‌بورد ناموفق بود — کلید را دستی کپی کنید.");
    }
  }

  async function revokeKey(id: string, keyName: string) {
    if (!window.confirm(`کلید «${keyName}» لغو شود؟ این عمل برگشت‌پذیر نیست.`)) return;
    setBusyId(id);
    setActionError(null);
    try {
      const response = await fetch(`/api/admin/api-keys/${id}`, {
        method: "DELETE",
        credentials: "same-origin"
      });
      const payload = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !payload.ok) {
        setActionError(payload.message ?? "لغو کلید ناموفق بود");
        return;
      }
      if (editId === id) setEditId(null);
      await loadKeys();
    } catch {
      setActionError("لغو کلید ناموفق بود");
    } finally {
      setBusyId(null);
    }
  }

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-host.example";

  const docsScopes = useMemo(
    () => (createScopes.length ? createScopes : [...ALL_API_KEY_SCOPES]),
    [createScopes]
  );

  return (
    <div className="stack" style={{ gap: 16 }}>
      <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
        کلیدهای فقط‌خواندنی برای دریافت قیمت‌های بازار از طریق API خارجی (سرور به سرور). هر کلید
        می‌تواند یک یا چند مجموعهٔ داده را پوشش دهد. احراز هویت فقط با{" "}
        <code className="number">Authorization: Bearer</code> است.
      </p>

      {storageNote ? <div className="empty" style={{ margin: 0 }}>{storageNote}</div> : null}
      {listError ? <div className="empty" style={{ margin: 0 }}>{listError}</div> : null}
      {actionError ? <div className="empty" style={{ margin: 0 }}>{actionError}</div> : null}

      <div className="card" style={{ padding: 14 }}>
        <div className="stack" style={{ gap: 10 }}>
          <strong style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Plus size={16} aria-hidden="true" />
            ایجاد کلید جدید
          </strong>
          <div className="grid settings-grid">
            <div className="field">
              <label htmlFor="api-key-name">نام توصیفی (الزامی)</label>
              <input
                id="api-key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً Blue Market Partner"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="api-key-exp">تاریخ انقضا (اختیاری)</label>
              <input
                id="api-key-exp"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              سطح دسترسی (حداقل یکی)
            </div>
            <ScopeChecklist idPrefix="create-scope" selected={createScopes} onChange={setCreateScopes} />
          </div>
          {createError ? <div className="empty" style={{ margin: 0 }}>{createError}</div> : null}
          <div>
            <button
              type="button"
              className="button"
              disabled={creating || !name.trim() || !createScopes.length}
              onClick={() => void createKey()}
            >
              <KeyRound size={15} aria-hidden="true" />
              {creating ? "در حال ایجاد…" : "ایجاد کلید"}
            </button>
          </div>
        </div>
      </div>

      {plaintextOnce ? (
        <div
          className="card"
          style={{
            padding: 14,
            borderColor: "var(--yellow)",
            background: "var(--yellow-bg)"
          }}
        >
          <strong>کلید را الان کپی کنید</strong>
          <p className="muted" style={{ fontSize: 13, margin: "8px 0" }}>
            این مقدار فقط یک‌بار نمایش داده می‌شود و دیگر قابل مشاهده نیست.
          </p>
          <div
            className="number"
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 13,
              wordBreak: "break-all",
              padding: "10px 12px",
              borderRadius: 8,
              background: "var(--input-bg)",
              border: "1px solid var(--line)"
            }}
          >
            {plaintextOnce}
          </div>
          <div style={{ marginTop: 10 }}>
            <button type="button" className="button" onClick={() => void copyPlaintext()}>
              <Copy size={15} aria-hidden="true" />
              {copied ? "کپی شد" : "کپی کلید"}
            </button>
          </div>
        </div>
      ) : null}

      <div>
        <strong style={{ display: "block", marginBottom: 8 }}>کلیدهای موجود</strong>
        {loading ? (
          <div className="muted">در حال بارگذاری…</div>
        ) : !keys.length ? (
          <div className="empty" style={{ margin: 0 }}>
            هنوز کلیدی ساخته نشده است
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>نام</th>
                  <th>کلید</th>
                  <th>دسترسی‌ها</th>
                  <th>ایجاد</th>
                  <th>انقضا</th>
                  <th>آخرین استفاده</th>
                  <th>وضعیت</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const scopes = k.scopes?.length ? k.scopes : [k.scope];
                  return (
                    <tr key={k.id}>
                      <td>
                        <strong>{k.name}</strong>
                      </td>
                      <td
                        className="number nowrap"
                        style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}
                      >
                        {k.keyHint}
                      </td>
                      <td>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {scopes.map((s) => (
                            <Badge key={s} tone="neutral">
                              {API_KEY_SCOPE_LABELS[s] ?? s}
                            </Badge>
                          ))}
                        </div>
                        {editId === k.id ? (
                          <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                            <ScopeChecklist
                              idPrefix={`edit-${k.id}`}
                              selected={editScopes}
                              onChange={setEditScopes}
                            />
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button
                                type="button"
                                className="button"
                                disabled={editSaving || !editScopes.length}
                                onClick={() => void saveEditScopes()}
                              >
                                {editSaving ? "در حال ذخیره…" : "ذخیره دسترسی‌ها"}
                              </button>
                              <button
                                type="button"
                                className="button"
                                disabled={editSaving}
                                onClick={() => setEditId(null)}
                              >
                                انصراف
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </td>
                      <td className="nowrap">{formatDate(k.createdAt)}</td>
                      <td className="nowrap">{k.expiresAt ? formatDate(k.expiresAt) : "—"}</td>
                      <td className="nowrap">{k.lastUsedAt ? formatDate(k.lastUsedAt) : "—"}</td>
                      <td>
                        <Badge tone={statusTone(k.status)}>{statusLabel(k.status)}</Badge>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          {k.status === "active" ? (
                            <button
                              type="button"
                              className="icon-button icon-button--compact"
                              title="ویرایش دسترسی‌ها"
                              aria-label={`ویرایش دسترسی‌های ${k.name}`}
                              onClick={() => {
                                setEditId(k.id);
                                setEditScopes(scopes);
                                setActionError(null);
                              }}
                            >
                              <Pencil size={15} aria-hidden="true" />
                            </button>
                          ) : null}
                          {k.status !== "revoked" ? (
                            <button
                              type="button"
                              className="icon-button icon-button--compact"
                              title="لغو کلید"
                              aria-label={`لغو کلید ${k.name}`}
                              disabled={busyId === k.id}
                              onClick={() => void revokeKey(k.id, k.name)}
                            >
                              <Trash2 size={15} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 14 }}>
        <strong>مستندات و نمونه استفاده</strong>
        <p className="muted" style={{ fontSize: 13, margin: "8px 0", lineHeight: 1.6 }}>
          هر سطح دسترسی endpoint اختصاصی دارد. endpoint ترکیبی{" "}
          <code className="number">/api/v1/market-prices</code> فقط بخش‌های مجاز برای همان کلید را
          برمی‌گرداند (مثلاً بدون <code>tether:read</code> فیلد <code>data.tether</code> اصلاً وجود
          ندارد).
        </p>
        <ul className="muted" style={{ fontSize: 13, margin: "0 0 12px", paddingInlineStart: 18 }}>
          {docsScopes.map((s) => (
            <li key={s}>
              {API_KEY_SCOPE_LABELS[s]} → <code className="number">{SCOPE_ENDPOINTS[s]}</code>
            </li>
          ))}
          <li>
            ترکیبی → <code className="number">/api/v1/market-prices</code>
          </li>
        </ul>
        <pre
          className="number"
          style={{
            margin: 0,
            padding: 12,
            borderRadius: 8,
            background: "var(--input-bg)",
            border: "1px solid var(--line)",
            overflow: "auto",
            fontSize: 12,
            direction: "ltr",
            textAlign: "left",
            whiteSpace: "pre-wrap"
          }}
        >{`# single scope
curl -sS \\
  -H "Authorization: Bearer otc_live_YOUR_KEY" \\
  -H "Accept: application/json" \\
  "${origin}${SCOPE_ENDPOINTS[docsScopes[0] ?? "tether:read"]}"

# combined — only authorized sections in data
curl -sS \\
  -H "Authorization: Bearer otc_live_YOUR_KEY" \\
  -H "Accept: application/json" \\
  "${origin}/api/v1/market-prices"`}</pre>
      </div>
    </div>
  );
}
