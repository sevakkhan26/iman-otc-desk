"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DeskPageHeader } from "@/components/DeskPageHeader";
import { AccountReadiness } from "@/components/shadowArbitrage/AccountReadiness";
import { AnalyticsPanels } from "@/components/shadowArbitrage/AnalyticsPanels";
import { CapitalSimulator } from "@/components/shadowArbitrage/CapitalSimulator";
import { ObservationHeader } from "@/components/shadowArbitrage/ObservationHeader";
import { LiveReadiness } from "@/components/shadowArbitrage/LiveReadiness";
import { OpportunityDrawer } from "@/components/shadowArbitrage/OpportunityDrawer";
import { OpportunityTable } from "@/components/shadowArbitrage/OpportunityTable";
import { OverviewPanel } from "@/components/shadowArbitrage/OverviewPanel";
import { PaperExecution } from "@/components/shadowArbitrage/PaperExecution";
import { ShadowTabs } from "@/components/shadowArbitrage/ShadowTabs";
import { SourceTable } from "@/components/shadowArbitrage/SourceTable";
import { SHADOW_WARNING_FA } from "@/components/shadowArbitrage/labels";
import { SummaryCards } from "@/components/shadowArbitrage/SummaryCards";
import { parseShadowTab, shadowTabLabel, type ShadowTabId } from "@/components/shadowArbitrage/tabs";
import type {
  ObservationPayload,
  ShadowAnalytics,
  ShadowMatrixResponse,
  ShadowOpportunity
} from "@/components/shadowArbitrage/types";

/** Shapes read only for the Overview summaries — no behaviour depends on them. */
type PaperPayload = {
  session: { status: string; mode: string } | null;
  stats: { filled: number; skipped: number; economicNetPnlToman: number } | null;
};

type ReadinessPayload = {
  report: {
    passedCount: number;
    gates: Array<{ id: string }>;
    effectiveState: string;
    blockers: Array<{ blockerFa: string }>;
  } | null;
};

/**
 * Admin-only Shadow Arbitrage dashboard.
 *
 * Phase 8A turns one very long page into URL-addressable tabs. Data fetching,
 * calculations and every safety boundary are unchanged: this component still
 * only reads what the server persisted, the browser never contacts an exchange,
 * and no action here can place an order or move funds.
 */
export function ShadowArbitrageView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseShadowTab(searchParams.get("tab"));

  const [matrix, setMatrix] = useState<ShadowMatrixResponse | null>(null);
  const [history, setHistory] = useState<ShadowOpportunity[]>([]);
  const [analytics, setAnalytics] = useState<ShadowAnalytics | null>(null);
  const [obs, setObs] = useState<ObservationPayload | null>(null);
  const [paper, setPaper] = useState<PaperPayload | null>(null);
  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ShadowOpportunity | null>(null);

  /**
   * Tab changes go through the URL, so back/forward and refresh restore the
   * same view. `replace` keeps the history stack from filling with tab clicks
   * while still updating the address.
   */
  const selectTab = useCallback(
    (next: ShadowTabId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const q = refresh ? "?refresh=1" : "";
      const [mRes, hRes, aRes, oRes, pRes, rRes] = await Promise.all([
        fetch(`/api/shadow-arbitrage/matrix${q}`, { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/history", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/analytics", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/observation", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/paper", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/live-readiness", {
          cache: "no-store",
          credentials: "same-origin"
        })
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
      // The two summary sources are best-effort: the page is useful without them.
      if (pRes.ok) setPaper((await pRes.json()) as PaperPayload);
      if (rRes.ok) setReadiness((await rRes.json()) as ReadinessPayload);
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

  const accountsSummary = useMemo(() => {
    const certifications = obs?.certifications ?? [];
    if (!certifications.length) return null;
    const executable = certifications.filter((c) => c.status === "LIVE_VERIFIED").length;
    const firstBlocked = certifications.find((c) => c.status !== "LIVE_VERIFIED");
    return {
      executable,
      total: certifications.length,
      blockedFa: firstBlocked
        ? `${firstBlocked.sourceName}: ${firstBlocked.statusReason ?? "گواهی نشده"}`
        : null
    };
  }, [obs]);

  const readinessSummary = useMemo(() => {
    const report = readiness?.report;
    if (!report) return null;
    return {
      passed: report.passedCount,
      total: report.gates.length,
      effectiveState: report.effectiveState,
      topBlockerFa: report.blockers[0]?.blockerFa ?? null
    };
  }, [readiness]);

  const paperSummary = useMemo(() => {
    if (!paper) return null;
    return {
      present: Boolean(paper.session),
      status: paper.session?.status ?? "NONE",
      mode: paper.session?.mode ?? null,
      filled: paper.stats?.filled ?? 0,
      skipped: paper.stats?.skipped ?? 0,
      economicNetPnlToman: paper.stats?.economicNetPnlToman ?? 0
    };
  }, [paper]);

  const badges: Partial<Record<ShadowTabId, string>> = {};
  if (readinessSummary && readinessSummary.total > readinessSummary.passed) {
    badges.live = String(readinessSummary.total - readinessSummary.passed);
  }

  return (
    <div className="sa-page sa-page-tabbed">
      <DeskPageHeader
        title="آربیتراژ آزمایشی"
        serverNow={serverNow}
        loading={loading}
        onRefresh={() => void load(true)}
        lastUpdated={matrix?.serverNow ? Date.parse(matrix.serverNow) : null}
      />

      {/* Permanent, compact, never hidden — on every tab. */}
      {/* Material from the shared .glass-control primitive; amber is a tint. */}
      <div className="sa-warning sa-warning-compact glass-control" role="status">
        <span className="sa-warning-icon" aria-hidden="true">
          ⚠
        </span>
        <span>{SHADOW_WARNING_FA}</span>
      </div>

      <ShadowTabs active={tab} onSelect={selectTab} badges={badges} />

      {notice ? <div className="sa-callout sa-callout-muted">{notice}</div> : null}

      <div
        className="sa-tabpanel"
        role="tabpanel"
        id={`sa-panel-${tab}`}
        aria-labelledby={`sa-tab-${tab}`}
        tabIndex={-1}
        aria-label={shadowTabLabel(tab)}
      >
        {tab === "overview" ? (
          <OverviewPanel
            loading={loading}
            error={error}
            stale={stale}
            observation={observation}
            worker={worker}
            runStats={obs?.runStats ?? null}
            analytics={analytics}
            opportunities={allOpportunities}
            sources={sources}
            serverNow={serverNow}
            paper={paperSummary}
            readiness={readinessSummary}
            accounts={accountsSummary}
            onRefresh={() => void load(true)}
            onOpenTab={selectTab}
          />
        ) : null}

        {tab === "opportunities" ? (
          <>
            {error ? (
              <div className="sa-callout sa-callout-danger" role="alert">
                {error}
              </div>
            ) : null}
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
          </>
        ) : null}

        {tab === "sources" ? (
          <>
            <SourceTable
              certifications={obs?.certifications ?? []}
              health={obs?.sourceHealth ?? []}
              sources={sources}
              analytics={analytics}
              pollIntervalMs={pollIntervalMs}
              loading={loading}
            />
            <AccountReadiness />
          </>
        ) : null}

        {tab === "capital" ? <CapitalSimulator /> : null}

        {tab === "paper" ? <PaperExecution /> : null}

        {/* The red live warning lives here and only here. */}
        {tab === "live" ? <LiveReadiness /> : null}

        {tab === "analytics" ? (
          <>
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
            <AnalyticsPanels
              analytics={analytics}
              costRecords={obs?.costRecords ?? []}
              loading={loading}
            />
          </>
        ) : null}
      </div>

      <OpportunityDrawer
        opportunity={selected}
        sources={sources}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
