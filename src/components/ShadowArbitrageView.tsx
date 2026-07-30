"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DeskPageHeader } from "@/components/DeskPageHeader";
import { AccountReadiness } from "@/components/shadowArbitrage/AccountReadiness";
import { AnalyticsPanels } from "@/components/shadowArbitrage/AnalyticsPanels";
import { ObservationHeader } from "@/components/shadowArbitrage/ObservationHeader";
import { OpportunityDrawer } from "@/components/shadowArbitrage/OpportunityDrawer";
import { OpportunityTable } from "@/components/shadowArbitrage/OpportunityTable";
import { SourceTable } from "@/components/shadowArbitrage/SourceTable";
import { SHADOW_WARNING_FA } from "@/components/shadowArbitrage/labels";
import { SummaryCards } from "@/components/shadowArbitrage/SummaryCards";
import type {
  ObservationPayload,
  ShadowAnalytics,
  ShadowMatrixResponse,
  ShadowOpportunity
} from "@/components/shadowArbitrage/types";

/**
 * Admin-only Shadow Arbitrage dashboard.
 *
 * Reads only what the server persisted — the browser never contacts an exchange
 * and no action on this page can place an order or move funds.
 */
export function ShadowArbitrageView() {
  const [matrix, setMatrix] = useState<ShadowMatrixResponse | null>(null);
  const [history, setHistory] = useState<ShadowOpportunity[]>([]);
  const [analytics, setAnalytics] = useState<ShadowAnalytics | null>(null);
  const [obs, setObs] = useState<ObservationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ShadowOpportunity | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const q = refresh ? "?refresh=1" : "";
      const [mRes, hRes, aRes, oRes] = await Promise.all([
        fetch(`/api/shadow-arbitrage/matrix${q}`, { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/history", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/analytics", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/observation", { cache: "no-store", credentials: "same-origin" })
      ]);

      if (mRes.status === 403 || mRes.status === 401) {
        setError("این صفحه فقط برای مدیر سیستم است.");
        setMatrix(null);
        return;
      }
      if (mRes.ok) {
        setMatrix((await mRes.json()) as ShadowMatrixResponse);
      } else {
        const body = (await mRes.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "دریافت دادهٔ فرصت‌ها ممکن نشد.");
      }
      if (hRes.ok) {
        const h = (await hRes.json()) as { opportunities?: ShadowOpportunity[] };
        setHistory(h.opportunities ?? []);
      }
      if (aRes.ok) {
        const a = (await aRes.json()) as { analytics?: ShadowAnalytics };
        setAnalytics(a.analytics ?? null);
      }
      if (oRes.ok) {
        setObs((await oRes.json()) as ObservationPayload);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطای غیرمنتظره در دریافت داده.");
    } finally {
      setLoading(false);
    }
  }, []);

  const control = useCallback(
    async (action: "pause" | "resume") => {
      setNotice(null);
      try {
        const res = await fetch("/api/shadow-arbitrage/observation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ action })
        });
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        if (!res.ok) throw new Error(body?.message ?? "تغییر وضعیت ممکن نشد.");
        setNotice(action === "pause" ? "پایش متوقف شد." : "پایش ادامه یافت.");
        await load(false);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "تغییر وضعیت ممکن نشد.");
      }
    },
    [load]
  );

  useEffect(() => {
    // Cache-first: the background collector is the data source, not this page.
    void load(false);
    const id = window.setInterval(() => void load(false), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const sources = matrix?.sources ?? [];
  const observation = obs?.observation ?? null;
  const worker = obs?.worker ?? null;
  const pollIntervalMs = worker?.pollIntervalMs ?? observation?.pollIntervalMs ?? 30_000;
  const serverNow = matrix?.serverNow ?? obs?.serverNow ?? null;

  // Active rows come from the matrix; ended ones only exist in history.
  const allOpportunities = useMemo(() => {
    const byId = new Map<string, ShadowOpportunity>();
    for (const o of history) byId.set(o.id, o);
    for (const o of matrix?.opportunities ?? []) byId.set(o.id, o);
    return [...byId.values()];
  }, [matrix, history]);

  const stale =
    serverNow && matrix?.serverNow
      ? Date.now() - Date.parse(matrix.serverNow) > pollIntervalMs * 4
      : false;

  return (
    <div className="sa-page">
      <DeskPageHeader
        title="آربیتراژ آزمایشی"
        serverNow={serverNow}
        loading={loading}
        onRefresh={() => void load(true)}
        lastUpdated={matrix?.serverNow ? Date.parse(matrix.serverNow) : null}
      />

      {/* Permanent, compact, never hidden. */}
      <div className="sa-warning" role="status">
        <span className="sa-warning-icon" aria-hidden="true">
          ⚠
        </span>
        <span>{SHADOW_WARNING_FA}</span>
      </div>

      {error ? (
        <div className="sa-callout sa-callout-danger" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? <div className="sa-callout sa-callout-muted">{notice}</div> : null}
      {stale && !error ? (
        <div className="sa-callout sa-callout-warn">
          دادهٔ نمایش‌داده‌شده از آخرین چرخهٔ جمع‌آوری قدیمی‌تر از حد انتظار است. اگر جمع‌آورنده متوقف
          شده باشد، ارقام زیر به‌روز نیستند.
        </div>
      ) : null}

      <ObservationHeader
        observation={observation}
        worker={worker}
        runStats={obs?.runStats ?? null}
        dataCoveragePercent={analytics?.dataCoveragePercent ?? null}
        serverNow={serverNow}
        loading={loading}
        onPause={() => void control("pause")}
        onResume={() => void control("resume")}
      />

      <SummaryCards
        opportunities={allOpportunities}
        sources={sources}
        dataCoveragePercent={analytics?.dataCoveragePercent ?? null}
        loading={loading}
      />

      <OpportunityTable
        opportunities={allOpportunities}
        sources={sources}
        sizes={matrix?.sizes ?? [5, 10, 20, 25]}
        pollIntervalMs={pollIntervalMs}
        loading={loading}
        onSelect={setSelected}
      />

      <SourceTable
        certifications={obs?.certifications ?? []}
        health={obs?.sourceHealth ?? []}
        sources={sources}
        analytics={analytics}
        pollIntervalMs={pollIntervalMs}
        loading={loading}
      />

      <AccountReadiness />

      <AnalyticsPanels
        analytics={analytics}
        costRecords={obs?.costRecords ?? []}
        loading={loading}
      />

      <OpportunityDrawer
        opportunity={selected}
        sources={sources}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
