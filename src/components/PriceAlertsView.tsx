"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { ThemeToggleButton } from "@/components/ThemeToggleButton";
import {
  conditionLabel,
  instrumentMeta,
  priceTypeLabel,
  statusLabelFa
} from "@/lib/priceAlerts/instruments";
import type {
  DeskRole
} from "@/lib/auth";
import type {
  PriceAlertCondition,
  PriceAlertInstrumentId,
  PriceAlertInstrumentSnapshot,
  PriceAlertNotification,
  PriceAlertPriceType,
  PriceAlertProviderMode,
  PriceAlertRepeatMode,
  PriceAlertRule,
  PriceAlertsPageResponse
} from "@/lib/types";
import {
  formatDate,
  formatNumber,
  formatTehran,
  formatToman,
  formatUsd
} from "@/components/format";
import { AlertsSkeleton } from "@/components/skeletons";

function PageHeader({
  onRefresh,
  lastUpdated,
  loading,
  unread
}: {
  onRefresh: () => void;
  lastUpdated: number | null;
  loading: boolean;
  unread: number;
}) {
  return (
    <div className="page-header">
      <h2 className="page-title">
        هشدارها
        {unread > 0 ? <span className="price-alert-unread-pill">{formatNumber(unread, 0)}</span> : null}
      </h2>
      <div className="header-meta">
        <div className="last-update">
          آخرین بروزرسانی:{" "}
          <span className="number">
            {lastUpdated
              ? new Intl.DateTimeFormat("fa-IR", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  timeZone: "Asia/Tehran"
                }).format(lastUpdated)
              : "—"}
          </span>
        </div>
        <button className="icon-button" onClick={onRefresh} title="بروزرسانی" aria-label="بروزرسانی" disabled={loading}>
          <RefreshCw aria-hidden="true" className={loading ? "spinning" : undefined} />
        </button>
        <ThemeToggleButton />
      </div>
    </div>
  );
}

function formatPrice(unit: "toman" | "usd", value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return unit === "toman" ? formatToman(value) : formatUsd(value);
}

function SummaryCards({ summary }: { summary: PriceAlertsPageResponse["summary"] }) {
  const items = [
    { label: "هشدارهای فعال", value: summary.active, tone: "good" as const },
    { label: "هشدارهای فعال‌شده", value: summary.triggered, tone: "warn" as const },
    { label: "اعلان‌های خوانده‌نشده", value: summary.unread, tone: "danger" as const }
  ];
  return (
    <div className="grid metrics price-alert-summary">
      {items.map((item) => (
        <div key={item.label} className={`metric price-alert-summary-card tone-${item.tone}`}>
          <div className="metric-label">{item.label}</div>
          <div className="metric-value number">{formatNumber(item.value, 0)}</div>
        </div>
      ))}
    </div>
  );
}

function InstrumentCards({
  instruments,
  selected,
  onSelect
}: {
  instruments: PriceAlertInstrumentSnapshot[];
  selected: PriceAlertInstrumentId | null;
  onSelect: (id: PriceAlertInstrumentId) => void;
}) {
  return (
    <div className="price-alert-instruments">
      {instruments.map((inst) => (
        <button
          key={inst.id}
          type="button"
          className={`price-alert-instrument-card health-${inst.health}${selected === inst.id ? " selected" : ""}`}
          onClick={() => onSelect(inst.id)}
        >
          <div className="pai-name">{inst.label}</div>
          <div className="pai-price number">{formatPrice(inst.unit, inst.price)}</div>
          <div className="pai-meta muted">
            {inst.unitLabel}
            {inst.priceType ? ` · ${priceTypeLabel(inst.priceType)}` : ""}
          </div>
          <div className="pai-meta muted">
            {inst.sourceCount ? `${formatNumber(inst.sourceCount, 0)} منبع` : "بدون منبع"}
            {inst.lastUpdated ? ` · ${formatTehran(inst.lastUpdated)}` : ""}
          </div>
          <div className={`pai-health ${inst.health}`}>
            {inst.health === "available" ? "سالم" : inst.health === "degraded" ? "ناقص" : "قطع"}
          </div>
        </button>
      ))}
    </div>
  );
}

type FormState = {
  instrument: PriceAlertInstrumentId;
  priceType: PriceAlertPriceType;
  providerMode: PriceAlertProviderMode;
  providerId: string;
  condition: PriceAlertCondition;
  targetPrice: string;
  repeatMode: PriceAlertRepeatMode;
  cooldownSeconds: string;
  note: string;
};

function defaultForm(instrument: PriceAlertInstrumentId): FormState {
  return {
    instrument,
    priceType: "mid",
    providerMode: "any",
    providerId: "",
    condition: "gte",
    targetPrice: "",
    repeatMode: "once",
    cooldownSeconds: "300",
    note: ""
  };
}

function AlertForm({
  instruments,
  isAdmin,
  selectedInstrument,
  editing,
  onCancelEdit,
  onSaved
}: {
  instruments: PriceAlertInstrumentSnapshot[];
  isAdmin: boolean;
  selectedInstrument: PriceAlertInstrumentId | null;
  editing: PriceAlertRule | null;
  onCancelEdit: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => defaultForm(selectedInstrument ?? "usdt_irt"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editing) {
      setForm({
        instrument: editing.instrument,
        priceType: editing.priceType,
        providerMode: editing.providerMode,
        providerId: editing.providerId ?? "",
        condition: editing.condition,
        targetPrice: String(editing.targetPrice),
        repeatMode: editing.repeatMode,
        cooldownSeconds: String(editing.cooldownSeconds ?? 300),
        note: editing.note ?? ""
      });
      return;
    }
    if (selectedInstrument) {
      setForm(defaultForm(selectedInstrument));
    }
  }, [editing, selectedInstrument]);

  const snapshot = instruments.find((i) => i.id === form.instrument);
  const providers = snapshot?.providers ?? [];
  const specific = providers.find((p) => p.id === form.providerId);
  const priceTypes: PriceAlertPriceType[] =
    form.providerMode === "specific" && specific
      ? specific.supportedPriceTypes
      : Array.from(new Set(providers.flatMap((p) => p.supportedPriceTypes)));

  const priceTypesKey = priceTypes.join("|");
  useEffect(() => {
    if (priceTypes.length && !priceTypes.includes(form.priceType)) {
      setForm((f) => ({ ...f, priceType: priceTypes[0]! }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when available types change
  }, [priceTypesKey]);

  if (!isAdmin) {
    return (
      <section className="panel">
        <div className="panel-header">
          <h3 className="panel-title">ایجاد هشدار</h3>
        </div>
        <div className="panel-body">
          <div className="empty">نمایش‌دهنده فقط می‌تواند هشدارها و اعلان‌ها را ببیند.</div>
        </div>
      </section>
    );
  }

  async function submit() {
    setSaving(true);
    setError(null);
    const payload = {
      instrument: form.instrument,
      targetPrice: Number(form.targetPrice.replace(/,/g, "")),
      condition: form.condition,
      priceType: form.priceType,
      providerMode: form.providerMode,
      providerId: form.providerMode === "specific" ? form.providerId : null,
      repeatMode: form.repeatMode,
      cooldownSeconds: Number(form.cooldownSeconds) || 300,
      note: form.note || null
    };
    try {
      const url = editing ? `/api/alerts/${editing.id}` : "/api/alerts";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = (await res.json()) as { message?: string };
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setForm(defaultForm(form.instrument));
      onCancelEdit();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ذخیره ناموفق بود");
    } finally {
      setSaving(false);
    }
  }

  const unit = snapshot?.unit ?? "toman";
  const preview = Number(form.targetPrice.replace(/,/g, ""));

  return (
    <section className="panel">
      <div className="panel-header">
        <h3 className="panel-title">{editing ? "ویرایش هشدار" : "ایجاد هشدار قیمت"}</h3>
        {editing ? (
          <button type="button" className="chip" onClick={onCancelEdit}>
            انصراف
          </button>
        ) : null}
      </div>
      <div className="panel-body price-alert-form">
        <label className="field">
          <span>ابزار</span>
          <select
            value={form.instrument}
            onChange={(e) =>
              setForm({
                ...defaultForm(e.target.value as PriceAlertInstrumentId),
                instrument: e.target.value as PriceAlertInstrumentId
              })
            }
          >
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>نوع قیمت</span>
          <select
            value={form.priceType}
            onChange={(e) => setForm((f) => ({ ...f, priceType: e.target.value as PriceAlertPriceType }))}
          >
            {(priceTypes.length ? priceTypes : (["mid", "reference"] as PriceAlertPriceType[])).map((t) => (
              <option key={t} value={t}>
                {priceTypeLabel(t)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>منبع</span>
          <select
            value={form.providerMode === "any" ? "any" : form.providerId}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "any") setForm((f) => ({ ...f, providerMode: "any", providerId: "" }));
              else setForm((f) => ({ ...f, providerMode: "specific", providerId: v }));
            }}
          >
            <option value="any">هر منبع سالم</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>شرط</span>
          <select
            value={form.condition}
            onChange={(e) => setForm((f) => ({ ...f, condition: e.target.value as PriceAlertCondition }))}
          >
            <option value="gte">قیمت به هدف برسد یا بالاتر برود</option>
            <option value="lte">قیمت به هدف برسد یا پایین‌تر بیاید</option>
            <option value="cross_up">عبور صعودی از قیمت هدف</option>
            <option value="cross_down">عبور نزولی از قیمت هدف</option>
          </select>
        </label>

        <label className="field">
          <span>قیمت هدف ({snapshot?.unitLabel ?? ""})</span>
          <input
            inputMode="decimal"
            value={form.targetPrice}
            onChange={(e) => setForm((f) => ({ ...f, targetPrice: e.target.value }))}
            placeholder="مثلاً 189500"
          />
          <span className="field-hint muted number">
            پیش‌نمایش: {Number.isFinite(preview) && preview > 0 ? formatPrice(unit, preview) : "—"}
          </span>
        </label>

        <label className="field">
          <span>حالت فعال‌سازی</span>
          <select
            value={form.repeatMode}
            onChange={(e) => setForm((f) => ({ ...f, repeatMode: e.target.value as PriceAlertRepeatMode }))}
          >
            <option value="once">فقط یک‌بار</option>
            <option value="repeat">تکرارشونده</option>
          </select>
        </label>

        {form.repeatMode === "repeat" ? (
          <label className="field">
            <span>فاصلهٔ سکوت (ثانیه)</span>
            <input
              inputMode="numeric"
              value={form.cooldownSeconds}
              onChange={(e) => setForm((f) => ({ ...f, cooldownSeconds: e.target.value }))}
            />
          </label>
        ) : null}

        <label className="field">
          <span>یادداشت (اختیاری)</span>
          <input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} maxLength={200} />
        </label>

        {error ? <div className="empty danger-text">{error}</div> : null}

        <button type="button" className="primary-button" disabled={saving} onClick={() => void submit()}>
          {saving ? "در حال ذخیره..." : editing ? "ذخیره تغییرات" : "ایجاد هشدار"}
        </button>
      </div>
    </section>
  );
}

function ActiveAlerts({
  alerts,
  isAdmin,
  onEdit,
  onChanged
}: {
  alerts: PriceAlertRule[];
  isAdmin: boolean;
  onEdit: (rule: PriceAlertRule) => void;
  onChanged: () => void;
}) {
  async function toggle(rule: PriceAlertRule) {
    await fetch(`/api/alerts/${rule.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !rule.enabled })
    });
    onChanged();
  }

  async function remove(rule: PriceAlertRule) {
    if (!window.confirm(`حذف هشدار ${instrumentMeta(rule.instrument).label}؟`)) return;
    await fetch(`/api/alerts/${rule.id}`, { method: "DELETE", credentials: "same-origin" });
    onChanged();
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h3 className="panel-title">هشدارهای فعال / ثبت‌شده</h3>
        <span className="muted">{formatNumber(alerts.length, 0)} مورد</span>
      </div>
      <div className="panel-body">
        {!alerts.length ? (
          <div className="empty">هنوز هشدار قیمتی تعریف نشده است</div>
        ) : (
          <div className="price-alert-rules">
            {alerts.map((rule) => {
              const meta = instrumentMeta(rule.instrument);
              return (
                <article key={rule.id} className={`price-alert-rule status-${rule.status}`}>
                  <div className="par-head">
                    <strong>{meta.label}</strong>
                    <span className={`badge ${rule.status === "active" ? "good" : rule.status === "triggered" ? "warn" : "neutral"}`}>
                      {statusLabelFa(rule.status)}
                    </span>
                  </div>
                  <div className="par-line">
                    {conditionLabel(rule.condition)} · هدف:{" "}
                    <span className="number">{formatPrice(meta.unit, rule.targetPrice)}</span>
                  </div>
                  <div className="par-line muted">
                    {priceTypeLabel(rule.priceType)} ·{" "}
                    {rule.providerMode === "any" ? "هر منبع سالم" : rule.providerId}
                    {" · "}
                    {rule.repeatMode === "once" ? "یک‌بار" : `تکرار / ${rule.cooldownSeconds}ث`}
                  </div>
                  <div className="par-line muted">
                    آخرین قیمت:{" "}
                    {rule.lastEvaluatedPrice != null ? formatPrice(meta.unit, rule.lastEvaluatedPrice) : "—"}
                    {rule.lastEvaluatedAt ? ` · ${formatTehran(rule.lastEvaluatedAt)}` : ""}
                  </div>
                  {rule.note ? <div className="par-line muted">یادداشت: {rule.note}</div> : null}
                  {isAdmin ? (
                    <div className="par-actions">
                      <button type="button" className="chip" onClick={() => onEdit(rule)}>
                        ویرایش
                      </button>
                      <button type="button" className="chip" onClick={() => void toggle(rule)}>
                        {rule.enabled ? "غیرفعال" : "فعال"}
                      </button>
                      <button type="button" className="chip danger-chip" onClick={() => void remove(rule)}>
                        حذف
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function NotificationHistory({
  notifications,
  isAdmin,
  onChanged
}: {
  notifications: PriceAlertNotification[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [instrument, setInstrument] = useState<string>("all");
  const [readFilter, setReadFilter] = useState<"all" | "unread" | "read">("all");

  const filtered = useMemo(() => {
    return notifications.filter((n) => {
      if (instrument !== "all" && n.instrument !== instrument) return false;
      if (readFilter === "unread" && n.readAt) return false;
      if (readFilter === "read" && !n.readAt) return false;
      return true;
    });
  }, [notifications, instrument, readFilter]);

  async function markRead(id: string) {
    await fetch(`/api/alerts/notifications/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true })
    });
    onChanged();
  }

  async function markAll() {
    await fetch("/api/alerts/notifications/read-all", { method: "POST", credentials: "same-origin" });
    onChanged();
  }

  async function removeOne(id: string) {
    await fetch(`/api/alerts/notifications/${id}`, { method: "DELETE", credentials: "same-origin" });
    onChanged();
  }

  async function clearAll() {
    if (!window.confirm("تمام تاریخچه اعلان‌ها پاک شود؟")) return;
    await fetch("/api/alerts/notifications", { method: "DELETE", credentials: "same-origin" });
    onChanged();
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h3 className="panel-title">تاریخچه اعلان‌های قیمت</h3>
        <div className="par-actions">
          <button type="button" className="chip" onClick={() => void markAll()}>
            همه خوانده‌شده
          </button>
          {isAdmin ? (
            <button type="button" className="chip danger-chip" onClick={() => void clearAll()}>
              پاک‌کردن تاریخچه
            </button>
          ) : null}
        </div>
      </div>
      <div className="panel-body">
        <div className="price-alert-history-filters">
          <select value={instrument} onChange={(e) => setInstrument(e.target.value)}>
            <option value="all">همه ابزارها</option>
            {["usdt_irt", "xau_usd", "coin_emami", "gold_18", "aed", "btc_usdt", "eth_usdt"].map((id) => (
              <option key={id} value={id}>
                {instrumentMeta(id as PriceAlertInstrumentId).label}
              </option>
            ))}
          </select>
          <select value={readFilter} onChange={(e) => setReadFilter(e.target.value as typeof readFilter)}>
            <option value="all">همه وضعیت‌ها</option>
            <option value="unread">خوانده‌نشده</option>
            <option value="read">خوانده‌شده</option>
          </select>
        </div>
        {!filtered.length ? (
          <div className="empty">اعلانی در تاریخچه نیست</div>
        ) : (
          <div className="price-alert-history">
            {filtered.map((n) => {
              const meta = instrumentMeta(n.instrument);
              return (
                <article key={n.id} className={`price-alert-note${n.readAt ? "" : " unread"}`}>
                  <div className="par-head">
                    <strong>
                      {meta.label} · {n.providerName}
                    </strong>
                    <span className="muted">{formatTehran(n.triggeredAt)}</span>
                  </div>
                  <div className="par-line">
                    {priceTypeLabel(n.priceType)}:{" "}
                    <span className="number">{formatPrice(meta.unit, n.actualPrice)}</span>
                    {" · هدف: "}
                    <span className="number">{formatPrice(meta.unit, n.targetPrice)}</span>
                  </div>
                  <div className="par-line muted">{conditionLabel(n.condition)}</div>
                  {n.note ? <div className="par-line muted">یادداشت: {n.note}</div> : null}
                  <div className="par-actions">
                    {!n.readAt ? (
                      <button type="button" className="chip" onClick={() => void markRead(n.id)}>
                        علامت‌گذاری خوانده‌شده
                      </button>
                    ) : (
                      <span className="muted">خوانده‌شده{n.readAt ? ` · ${formatDate(n.readAt)}` : ""}</span>
                    )}
                    {isAdmin ? (
                      <button type="button" className="chip danger-chip" onClick={() => void removeOne(n.id)}>
                        حذف
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export function PriceAlertsView() {
  const { data, loading, error, reload, lastUpdated } = useApi<PriceAlertsPageResponse>("/api/alerts", 45_000);
  const [role, setRole] = useState<DeskRole | null>(null);
  const [selected, setSelected] = useState<PriceAlertInstrumentId | null>(null);
  const [editing, setEditing] = useState<PriceAlertRule | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then(async (r) => (r.ok ? ((await r.json()) as { role?: DeskRole }) : null))
      .then((d) => {
        if (d?.role === "admin" || d?.role === "viewer") setRole(d.role);
      })
      .catch(() => {});
  }, []);

  const isAdmin = role === "admin";

  const onSaved = useCallback(() => {
    setEditing(null);
    setFormKey((k) => k + 1);
    reload();
  }, [reload]);

  if (loading && !data) {
    return (
      <>
        <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} unread={0} />
        <AlertsSkeleton />
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} unread={0} />
        <div className="empty">
          داده‌ای دریافت نشد: {error}
          <div style={{ marginTop: 10 }}>
            <button type="button" className="chip" onClick={() => reload()}>
              تلاش مجدد
            </button>
          </div>
        </div>
      </>
    );
  }

  if (!data) return null;

  const storageWarn =
    data.diagnostics && !data.diagnostics.storageConfigured
      ? "ذخیره‌سازی هشدارها در این محیط پیکربندی نشده است. برای production باید Upstash Redis REST تنظیم شود."
      : data.diagnostics?.lastErrorCode
        ? `وضعیت ذخیره‌سازی: ${data.diagnostics.lastErrorCode}`
        : null;

  return (
    <div className="price-alerts-page" data-layout-version="price-alerts-v1">
      <PageHeader
        onRefresh={reload}
        lastUpdated={lastUpdated}
        loading={loading}
        unread={data.summary.unread}
      />
      <div className="grid">
        {storageWarn ? (
          <div className="empty danger-text" role="status">
            {storageWarn}
          </div>
        ) : null}
        <SummaryCards summary={data.summary} />
        <section className="panel">
          <div className="panel-header">
            <h3 className="panel-title">انتخاب ابزار</h3>
            <span className="muted">برای ایجاد هشدار روی کارت کلیک کنید</span>
          </div>
          <div className="panel-body">
            <InstrumentCards
              instruments={data.instruments}
              selected={selected}
              onSelect={(id) => {
                setSelected(id);
                setEditing(null);
                setFormKey((k) => k + 1);
              }}
            />
          </div>
        </section>

        <div className="price-alert-main-grid">
          <AlertForm
            key={`${formKey}-${selected ?? "none"}-${editing?.id ?? "new"}`}
            instruments={data.instruments}
            isAdmin={isAdmin}
            selectedInstrument={selected}
            editing={editing}
            onCancelEdit={() => setEditing(null)}
            onSaved={onSaved}
          />
          <ActiveAlerts
            alerts={data.alerts}
            isAdmin={isAdmin}
            onEdit={(rule) => {
              setEditing(rule);
              setSelected(rule.instrument);
            }}
            onChanged={() => reload()}
          />
        </div>

        <NotificationHistory
          notifications={data.notifications}
          isAdmin={isAdmin}
          onChanged={() => reload()}
        />
      </div>
    </div>
  );
}
