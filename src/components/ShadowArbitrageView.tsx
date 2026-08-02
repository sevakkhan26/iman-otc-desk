"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DeskPageHeader } from "@/components/DeskPageHeader";
import { AnalyticsPanels } from "@/components/shadowArbitrage/AnalyticsPanels";
import { CapitalSimulator } from "@/components/shadowArbitrage/CapitalSimulator";
import {
  CommandCenter,
  type CommandBalance,
  type CommandSession,
  type ProposalView,
  type SizingView
} from "@/components/shadowArbitrage/CommandCenter";
import { ObservationHeader } from "@/components/shadowArbitrage/ObservationHeader";
import { LiveReadiness } from "@/components/shadowArbitrage/LiveReadiness";
import { OpportunitiesPanel } from "@/components/shadowArbitrage/OpportunitiesPanel";
import { OpportunityDrawer } from "@/components/shadowArbitrage/OpportunityDrawer";
import { OverviewPanel } from "@/components/shadowArbitrage/OverviewPanel";
import { PaperExecution } from "@/components/shadowArbitrage/PaperExecution";
import { PaperSimple } from "@/components/shadowArbitrage/PaperSimple";
import { ShadowTabs } from "@/components/shadowArbitrage/ShadowTabs";
import { SourcesPanel } from "@/components/shadowArbitrage/SourcesPanel";
import { SHADOW_WARNING_FA } from "@/components/shadowArbitrage/labels";
import {
  evidenceFor,
  indexPaperEvidence,
  type PaperLedgerRow
} from "@/components/shadowArbitrage/opportunityModel";
import type {
  FeeConfirmationAudit,
  VenueReadiness
} from "@/components/shadowArbitrage/sourcesModel";
import {
  isLegacyShadowTab,
  parseShadowTab,
  shadowTabLabel,
  type ShadowTabId
} from "@/components/shadowArbitrage/tabs";
import type {
  ObservationPayload,
  ShadowAnalytics,
  ShadowMatrixResponse,
  ShadowOpportunity
} from "@/components/shadowArbitrage/types";

/**
 * Paper payload shape.
 *
 * `trades` and `transitions` are the immutable paper ledger; Phase 8B joins
 * them to opportunities by lifecycle id, so the PnL figures shown on the
 * Opportunities tab are the engine's own recorded numbers, never re-derived.
 */
type PaperPayload = {
  session: CommandSession | null;
  stats: { filled: number; skipped: number; economicNetPnlToman: number } | null;
  balances?: CommandBalance[];
  trades?: PaperLedgerRow[];
  transitions?: PaperLedgerRow[];
  wizard?: { markPriceToman: number | null };
  sizing?: SizingView;
};

/** Account and fee readiness, read once and shared by both redesigned tabs. */
type AccountsPayload = {
  venues: VenueReadiness[];
  auditHistory: FeeConfirmationAudit[];
  feeReverifyDays: number;
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
  const rawTab = searchParams.get("tab");

  const [matrix, setMatrix] = useState<ShadowMatrixResponse | null>(null);
  const [history, setHistory] = useState<ShadowOpportunity[]>([]);
  const [analytics, setAnalytics] = useState<ShadowAnalytics | null>(null);
  const [obs, setObs] = useState<ObservationPayload | null>(null);
  const [paper, setPaper] = useState<PaperPayload | null>(null);
  const [accounts, setAccounts] = useState<AccountsPayload | null>(null);
  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<ShadowOpportunity | null>(null);
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);

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

  /**
   * Backward compatibility for the seven retired tabs.
   *
   * `parseShadowTab` already resolves an old slug to the section that now owns
   * its content, so the page renders correctly on arrival. This rewrites the
   * address afterwards so the link the operator copies next is the new one, and
   * `replace` keeps the retired URL out of the history stack.
   */
  useEffect(() => {
    if (!isLegacyShadowTab(rawTab)) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [rawTab, tab, pathname, router, searchParams]);

  /**
   * Generate an allocation proposal. This only computes and stores — the active
   * allocation is untouched until an admin presses Apply.
   */
  const proposeAllocation = useCallback(async () => {
    setProposalBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/shadow-arbitrage/paper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "propose_allocation" })
      });
      const body = (await res.json().catch(() => null)) as
        | { proposal?: ProposalView; message?: string }
        | null;
      if (!res.ok) throw new Error(body?.message ?? "ساخت پیشنهاد ممکن نشد");
      setProposal(body?.proposal ?? null);
      setNotice("پیشنهاد تخصیص ساخته و ثبت شد. تا زمانی که «اعمال» را نزنید هیچ موجودی تغییر نمی‌کند.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "ساخت پیشنهاد ممکن نشد");
    } finally {
      setProposalBusy(false);
    }
  }, []);

  /**
   * Apply the current proposal. The idempotency key is derived from the
   * proposal id, so a double click or a retried request cannot apply twice.
   */
  const applyAllocation = useCallback(async () => {
    if (!proposal) return;
    setProposalBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/shadow-arbitrage/paper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "apply_allocation",
          proposalId: proposal.id,
          idempotencyKey: `apply:${proposal.id}`
        })
      });
      const body = (await res.json().catch(() => null)) as
        | { outcome?: { detailFa?: string }; message?: string }
        | null;
      setNotice(body?.outcome?.detailFa ?? body?.message ?? "اعمال پیشنهاد ممکن نشد");
      await load(false);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "اعمال پیشنهاد ممکن نشد");
    } finally {
      setProposalBusy(false);
    }
    // `load` is defined below and is stable; referencing it here is intentional.
  }, [proposal]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const q = refresh ? "?refresh=1" : "";
      const [mRes, hRes, aRes, oRes, pRes, rRes, accRes] = await Promise.all([
        fetch(`/api/shadow-arbitrage/matrix${q}`, { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/history", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/analytics", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/observation", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/paper", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/live-readiness", {
          cache: "no-store",
          credentials: "same-origin"
        }),
        fetch("/api/shadow-arbitrage/accounts", { cache: "no-store", credentials: "same-origin" })
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
      // These sources are best-effort: the page stays useful without them, and
      // a tab that needs one says so rather than showing an invented value.
      if (pRes.ok) setPaper((await pRes.json()) as PaperPayload);
      if (rRes.ok) setReadiness((await rRes.json()) as ReadinessPayload);
      if (accRes.ok) setAccounts((await accRes.json()) as AccountsPayload);
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

  /**
   * The paper ledger as one list. Fills carry the settled figures and skips
   * carry the exact reason a candidate did not trade; both are evidence.
   */
  const paperLedger = useMemo(
    () => [...(paper?.trades ?? []), ...(paper?.transitions ?? [])],
    [paper]
  );
  const paperEvidence = useMemo(() => indexPaperEvidence(paperLedger), [paperLedger]);

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

  /**
   * The portfolio slice the Command Center reads.
   *
   * Only fills carry a settled PnL, so only fills feed the summary; skips are
   * counted separately and stay in the ledger where their reason is visible.
   */
  const portfolio = useMemo(() => {
    if (!paper) return null;
    return {
      session: paper.session,
      balances: paper.balances ?? [],
      fills: (paper.trades ?? []).map((t) => ({
        economicNetPnlToman: t.economicNetPnlToman,
        riskAdjustedPnlToman: t.riskAdjustedPnlToman,
        occurredAt: t.occurredAt
      })),
      rejected: paper.stats?.skipped ?? 0,
      markPriceToman: paper.wizard?.markPriceToman ?? null
    };
  }, [paper]);

  const badges: Partial<Record<ShadowTabId, string>> = {};
  if (readinessSummary && readinessSummary.total > readinessSummary.passed) {
    badges.settings = String(readinessSummary.total - readinessSummary.passed);
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
        {/* ── 1. Command Center — the landing section ───────────────────── */}
        {tab === "command" ? (
          <CommandCenter
            loading={loading}
            error={error}
            stale={stale}
            observation={observation}
            worker={worker}
            opportunities={allOpportunities}
            paperEvidence={paperEvidence}
            sources={sources}
            portfolio={portfolio}
            sizing={paper?.sizing ?? null}
            accounts={accountsSummary}
            readiness={readinessSummary}
            serverNow={serverNow}
            onRefresh={() => void load(true)}
            onOpenSection={selectTab}
            proposal={proposal}
            proposalBusy={proposalBusy}
            onProposeAllocation={() => void proposeAllocation()}
            onApplyAllocation={() => void applyAllocation()}
            /* Create, start, pause, resume and end the virtual session. */
            sessionControls={<PaperSimple parts={{ session: true, summary: false, ledger: false }} />}
            /*
             * Diagnostics, gates, policies and evidence — everything an
             * operator does not need on the first screen — behind one fold.
             */
            advanced={
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
                <PaperExecution />
              </>
            }
          />
        ) : null}

        {/* ── 2. Capital & Allocation ───────────────────────────────────── */}
        {tab === "capital" ? <CapitalSimulator /> : null}

        {/* ── 3. Opportunities & Trades ─────────────────────────────────── */}
        {tab === "trades" ? (
          <div className="sa-stack">
            <OpportunitiesPanel
              opportunities={allOpportunities}
              sources={sources}
              sizes={matrix?.sizes ?? [5, 10, 20, 25]}
              venues={accounts?.venues ?? []}
              paperLedger={paperLedger}
              paperSessionPresent={Boolean(paper?.session)}
              pollIntervalMs={pollIntervalMs}
              loading={loading}
              stale={stale}
              error={error}
              onSelect={setSelected}
            />
            {/* The immutable ledger of what the paper engine actually did. */}
            <PaperSimple parts={{ session: false, summary: false, ledger: true }} />
            <details className="panel sa-panel sa-advanced-details">
              <summary className="panel-header sa-panel-header">
                <span className="panel-title">تشخیص‌های پیشرفته</span>
                <span className="sa-panel-note">تحلیل بازهٔ پایش، مسیرها و هزینه‌ها</span>
              </summary>
              <div className="panel-body">
                <AnalyticsPanels
                  analytics={analytics}
                  costRecords={obs?.costRecords ?? []}
                  loading={loading}
                />
              </div>
            </details>
          </div>
        ) : null}

        {/* ── 4. Settings & Safety ──────────────────────────────────────── */}
        {tab === "settings" ? (
          <div className="sa-stack">
            <SourcesPanel
              certifications={obs?.certifications ?? []}
              health={obs?.sourceHealth ?? []}
              snapshots={sources}
              venues={accounts?.venues ?? []}
              auditHistory={accounts?.auditHistory ?? []}
              feeReverifyDays={accounts?.feeReverifyDays ?? null}
              pollIntervalMs={pollIntervalMs}
              loading={loading}
              error={error}
              onReload={() => void load(false)}
            />
            {/*
              Readiness gates, risk policies and evidence are diagnostics, not
              daily work — and the red live banner lives inside this panel, so
              it is still mounted exactly once on the page.
            */}
            <details className="panel sa-panel sa-advanced-details">
              <summary className="panel-header sa-panel-header">
                <span className="panel-title">تشخیص‌های پیشرفته</span>
                <span className="sa-panel-note">
                  دروازه‌های آمادگی اجرای واقعی، سیاست‌های ریسک و شواهد
                </span>
              </summary>
              <div className="panel-body">
                <LiveReadiness />
              </div>
            </details>
          </div>
        ) : null}
      </div>

      <OpportunityDrawer
        opportunity={selected}
        sources={sources}
        evidence={selected ? (evidenceFor(selected, paperEvidence) ?? null) : null}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
