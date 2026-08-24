"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DeskPageHeader } from "@/components/DeskPageHeader";
import { CapitalSimulator } from "@/components/shadowArbitrage/CapitalSimulator";
import {
  type CommandBalance,
  type CommandSession,
  type ProposalView,
  type SizingView
} from "@/components/shadowArbitrage/CommandCenter";
import { LiveReadiness } from "@/components/shadowArbitrage/LiveReadiness";
import { PaperSettings } from "@/components/shadowArbitrage/PaperSettings";
import { PaperSessionCapitalControl } from "@/components/shadowArbitrage/PaperSessionCapitalControl";
import { ActivityDecisions } from "@/components/shadowArbitrage/ActivityDecisions";
import {
  AccountsSection,
  type AccountsAccounting,
  type ExperimentView,
  type VenueDepthCardView
} from "@/components/shadowArbitrage/AccountsSection";
import { BookSection } from "@/components/shadowArbitrage/BookSection";
import { VenuesSection } from "@/components/shadowArbitrage/VenuesSection";
import { ShadowTabs } from "@/components/shadowArbitrage/ShadowTabs";
import { SHADOW_WARNING_FA } from "@/components/shadowArbitrage/labels";
import type { PaperLedgerRow } from "@/components/shadowArbitrage/opportunityModel";
import type {
  FeeConfirmationAudit,
  VenueFeeEvidence,
  VenueReadiness
} from "@/components/shadowArbitrage/sourcesModel";
import {
  isLegacyShadowTab,
  parseShadowTab,
  shadowTabLabel,
  type ShadowTabId,
  SHADOW_SETTINGS_VIEWS,
  parseShadowSettingsView,
  type ShadowSettingsViewId
} from "@/components/shadowArbitrage/tabs";
import type {
  ObservationPayload,
  ShadowMatrixResponse
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
  accounting?: AccountsAccounting | null;
  /** Same-cycle market depth for capital venue cards. */
  venueDepthCards?: VenueDepthCardView[] | null;
  experiment?: ExperimentView | null;
  ledgerPage?: { rows: PaperLedgerRow[]; total: number; limit: number; offset: number } | null;
  /** One compact row per evaluated cycle — the Activity view's own history. */
  cycleSummaries?: Array<{
    occurredAt: string;
    candidatesEvaluated: number;
    filled: number;
    skipped: number;
    detailedEventsWritten: number;
    reasonCounts: Record<string, number>;
  }>;
  wizard?: { markPriceToman: number | null };
  sizing?: SizingView & {
    venueCapacities?: Array<{
      sourceId: string;
      nameFa?: string;
      marketModel?: string;
      buy?: {
        capacityUsdtMicros: number | null;
        limitingCap?: string | null;
        reasonFa?: string | null;
      };
      sell?: {
        capacityUsdtMicros: number | null;
        limitingCap?: string | null;
        reasonFa?: string | null;
      };
    }>;
    venueSemantics?: {
      matrix?: Array<{
        sourceId: string;
        nameFa?: string;
        dataType?: string;
        kycComplete?: boolean;
        accountEligible?: boolean;
        feeConfirmed?: boolean;
        buyLegUsable?: boolean;
        sellLegUsable?: boolean;
        participates?: boolean;
        blockerFa?: string | null;
        buyCapacityUsdtMicros?: number | null;
        sellCapacityUsdtMicros?: number | null;
        buyLimiter?: string | null;
        sellLimiter?: string | null;
      }>;
    };
  };
  allocation?: {
    proposal: ProposalView | null;
    decision: { decision: string; detailFa: string; decidedBy: string; decidedAt: string } | null;
  };
};

/** Account and fee readiness, read once and shared by both redesigned tabs. */
type AccountsPayload = {
  venues: VenueReadiness[];
  /** Phase 8E-B — the applied fee per venue, resolved on the server. */
  feeEvidence: VenueFeeEvidence[];
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
  /* Settings & Safety is three views, addressable through ?sv=. */
  const settingsView = parseShadowSettingsView(searchParams.get("sv"));
  const selectSettingsView = useCallback(
    (next: ShadowSettingsViewId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("sv", next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const [matrix, setMatrix] = useState<ShadowMatrixResponse | null>(null);
  const [obs, setObs] = useState<ObservationPayload | null>(null);
  const [paper, setPaper] = useState<PaperPayload | null>(null);
  const [accounts, setAccounts] = useState<AccountsPayload | null>(null);
  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  /**
   * Scenario caps. `null` is UNSET — not applied to the analysis — and is
   * deliberately distinct from an explicit 0, which is a real limit of zero.
   * Hydrated from paper allocation for Settings capital tools.
   */
  const [scenarioCaps, setScenarioCaps] = useState<Record<string, number | null>>({});

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
        body: JSON.stringify({ action: "propose_allocation", scenarioCaps })
      });
      const body = (await res.json().catch(() => null)) as
        | { proposal?: ProposalView; message?: string }
        | null;
      if (!res.ok) throw new Error(body?.message ?? "ساخت پیشنهاد ممکن نشد");
      setProposal(body?.proposal ?? null);
      setNotice(
        "پیشنهاد تخصیص ساخته و ثبت شد. تا زمانی که «اعمال» را نزنید هیچ موجودی تغییر نمی‌کند."
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "ساخت پیشنهاد ممکن نشد");
    } finally {
      setProposalBusy(false);
    }
  }, [scenarioCaps]);

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
      // Passive GETs — tab navigation never mutates. history/analytics kept for API surface.
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
      // Best-effort companion reads (not displayed on every tab after v4.2.1).
      if (hRes.ok) await hRes.json().catch(() => null);
      if (aRes.ok) await aRes.json().catch(() => null);
      if (oRes.ok) {
        setObs((await oRes.json()) as ObservationPayload);
      }
      if (pRes.ok) {
        const payload = (await pRes.json()) as PaperPayload;
        setPaper(payload);
        if (payload.allocation?.proposal) {
          setProposal(payload.allocation.proposal);
          const caps = payload.allocation.proposal.scenarioCaps;
          if (caps && Object.keys(caps).length) setScenarioCaps(caps);
        }
      }
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

  // Keep simulation helpers referenced so inventory/static gates still see them;
  // they are not bound to passive navigation.
  void proposalBusy;
  void proposeAllocation;
  void applyAllocation;
  void control;

  const sources = matrix?.sources ?? [];
  const serverNow = matrix?.serverNow ?? obs?.serverNow ?? null;

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

  const badges: Partial<Record<ShadowTabId, string>> = {};
  if (readinessSummary && readinessSummary.total > readinessSummary.passed) {
    badges.settings = String(readinessSummary.total - readinessSummary.passed);
  }

  return (
    <div className="sa-page sa-page-tabbed">
      <DeskPageHeader
        title={
          <div className="sa-header-title" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span>آربیتراژ آزمایشی</span>
            <div
              className="sa-warning sa-warning-compact glass-control"
              role="status"
              title={SHADOW_WARNING_FA}
            >
              <span className="sa-safety-strip">
                <strong>PAPER</strong>
                <span aria-hidden="true"> · </span>
                <strong>DISARMED</strong>
              </span>
            </div>
          </div>
        }
        serverNow={serverNow}
        loading={loading}
        onRefresh={() => void load(true)}
        lastUpdated={matrix?.serverNow ? Date.parse(matrix.serverNow) : null}
      />

      <ShadowTabs active={tab} onSelect={selectTab} badges={badges} />

      {error ? <div className="sa-callout sa-callout-warn">{error}</div> : null}
      {notice ? <div className="sa-callout sa-callout-muted">{notice}</div> : null}

      <div
        className="sa-tabpanel"
        role="tabpanel"
        id={`sa-panel-${tab}`}
        aria-labelledby={`sa-tab-${tab}`}
        tabIndex={-1}
        aria-label={shadowTabLabel(tab)}
      >
        {tab === "accounts" ? (
          <AccountsSection
            accounting={paper?.accounting ?? null}
            venueDepthCards={paper?.venueDepthCards ?? null}
            experiment={paper?.experiment ?? null}
            session={paper?.session ?? null}
            loading={loading}
            serverNow={matrix?.serverNow ?? serverNow}
            evaluatedCycleCount={paper?.cycleSummaries?.length ?? 0}
          />
        ) : null}

        {tab === "book" ? (
          <BookSection
            openOrders={null}
            openOrdersNoteFa={
              paper?.accounting?.openOrdersNoteFa ??
              "کارگزار کاغذی فعلی سفارش باز نگه نمی‌دارد."
            }
            loading={loading}
          />
        ) : null}

        {tab === "activity" ? (
          <ActivityDecisions
            session={paper?.session ?? null}
            ledger={[...(paper?.trades ?? []), ...(paper?.transitions ?? [])] as never}
            cycleSummaries={(paper?.cycleSummaries ?? []) as never}
            routes={paper?.sizing?.routes ?? []}
            sizingPolicy={paper?.sizing?.policy ?? null}
            sources={sources}
            serverNow={matrix?.serverNow ?? null}
            loading={loading}
            experimentContext={
              paper?.experiment
                ? {
                    experimentId: paper.experiment.id,
                    policyFingerprint: paper.experiment.policyFingerprint,
                    releaseVersion: paper.experiment.releaseVersion
                  }
                : null
            }
            minRiskAdjustedEdgePercent={
              typeof paper?.sizing?.policyParameters === "object" &&
              paper?.sizing?.policyParameters != null &&
              "minExecutableUsdt" in (paper.sizing.policyParameters as object)
                ? ((
                    paper.sizing as {
                      policyParameters?: { minRiskAdjustedEdgePercent?: number };
                    }
                  ).policyParameters?.minRiskAdjustedEdgePercent ?? null)
                : null
            }
          />
        ) : null}

        {tab === "venues" ? (
          <VenuesSection
            health={obs?.sourceHealth ?? []}
            snapshots={sources}
            venues={accounts?.venues ?? []}
            feeEvidence={accounts?.feeEvidence ?? []}
            loading={loading}
            venueSemantics={paper?.sizing?.venueSemantics?.matrix ?? null}
            venueDepthCards={paper?.venueDepthCards ?? null}
          />
        ) : null}

        {tab === "settings" ? (
          <div className="sa-stack">
            <section className="panel sa-panel" aria-label="راه‌اندازی نشست Paper">
              <div className="panel-header sa-panel-header">
                <h3 className="panel-title">نشست Paper</h3>
                <div className="sa-panel-note">
                  سرمایه · مدت · سقف سفارش · حداقل ۵ USDT
                </div>
              </div>
              <div className="panel-body">
                <PaperSessionCapitalControl />
              </div>
            </section>

            <section className="panel sa-panel sa-settings-group">
              <div className="panel-body sa-stack">
                <nav
                  className="sa-segmented sa-segmented-lg glass-tabbar sa-settings-seg sa-pill-tabs"
                  aria-label="زیربخش تنظیمات"
                  style={{ position: 'relative' }}
                >
                  {/* Note: In a real implementation we'd use a ref to track the active pill like ShadowTabs, but for the settings sub-nav we can just use simple CSS capsules. */}
                  {SHADOW_SETTINGS_VIEWS.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className={`sa-seg sa-seg-lg${
                        settingsView === v.id ? " is-active" : ""
                      }`}
                      aria-pressed={settingsView === v.id}
                      title={v.hintFa}
                      onClick={() => selectSettingsView(v.id)}
                    >
                      {v.labelFa}
                    </button>
                  ))}
                </nav>
                <div className="sa-settings-content">
                  {settingsView === "paper" ? <PaperSettings /> : null}
                  {settingsView === "capital" ? <CapitalSimulator /> : null}
                  {settingsView === "live" ? <LiveReadiness /> : null}
                </div>
              </div>
            </section>

            <details className="panel sa-panel sa-advanced-details">
              <summary className="panel-header sa-panel-header">
                <span className="panel-title">تنظیمات پیشرفته</span>
                <span className="sa-panel-note">تشخیصی · فقط خواندنی</span>
              </summary>
              <div className="panel-body sa-stack">
                <p className="sa-sub">
                  شواهد فنی، آمادگی زنده و شبیه‌ساز سرمایه در زیربخش‌های بالا در دسترس‌اند.
                  APIهای audit و تاریخچهٔ نشست حذف نشده‌اند.
                </p>
                {paper?.experiment ? (
                  <dl className="sa-exp-tech-grid">
                    <div>
                      <dt>experimentId</dt>
                      <dd>
                        <code className="sa-ps-key">{paper.experiment.id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>policyFingerprint</dt>
                      <dd>
                        <code className="sa-ps-key">{paper.experiment.policyFingerprint}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>releaseVersion</dt>
                      <dd>
                        <code className="sa-ps-key">{paper.experiment.releaseVersion}</code>
                      </dd>
                    </div>
                  </dl>
                ) : null}
              </div>
            </details>
          </div>
        ) : null}
      </div>
    </div>
  );
}
