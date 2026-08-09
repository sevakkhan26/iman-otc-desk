/**
 * Read-only decision-cycle monitor feed.
 * GET only — cursor pagination. No mutations.
 */
import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import { getActivePaperSession } from "@/db/repositories/shadowPaper";
import {
  countDecisionTraces,
  firstCompleteTraceAt,
  listCycleSummariesAsTraces,
  listDecisionTraces
} from "@/db/repositories/shadowDecisionTraces";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 40) || 40));
  const cursor = url.searchParams.get("cursor");
  const prefer = (url.searchParams.get("source") ?? "auto").toLowerCase();

  const paper = await getActivePaperSession();
  if (!paper) {
    return new NextResponse(
      JSON.stringify({
        session: null,
        rows: [],
        nextCursor: null,
        counters: {
          cycles: 0,
          candidates: 0,
          valid: 0,
          selected: 0,
          traded: 0
        },
        firstCompleteTraceAt: null,
        historicalNoteFa:
          "نشست کاغذی فعالی نیست — مانیتور فقط وقتی نشست RUNNING/PAUSED است چرخه می‌خواند."
      }),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  }

  const traceCount = await countDecisionTraces(paper.id);
  const useTraces = prefer === "traces" || (prefer === "auto" && traceCount > 0);

  const page = useTraces
    ? await listDecisionTraces({
        sessionId: paper.id,
        limit,
        cursor: cursor || null
      })
    : await listCycleSummariesAsTraces({
        sessionId: paper.id,
        limit,
        cursor: cursor || null
      });

  let candidates = 0;
  let valid = 0;
  let selected = 0;
  let traded = 0;
  for (const r of page.rows) {
    candidates += r.candidatesEvaluated;
    valid += r.validCount;
    selected += r.selectedCount;
    traded += r.filledCount;
  }

  const firstComplete = useTraces ? await firstCompleteTraceAt(paper.id) : null;

  return new NextResponse(
    JSON.stringify({
      session: {
        id: paper.id,
        name: paper.name,
        status: paper.status,
        totalCapitalToman: paper.totalCapitalToman
      },
      source: useTraces ? "decision_trace" : "cycle_summary_only",
      rows: page.rows,
      nextCursor: page.nextCursor,
      pageCounters: {
        cycles: page.rows.length,
        candidates,
        valid,
        selected,
        traded
      },
      firstCompleteTraceAt: firstComplete,
      historicalNoteFa: useTraces
        ? firstComplete
          ? `اولین چرخه با ردپای کامل کاندید: ${firstComplete}`
          : "هنوز ردپای کامل کاندید ثبت نشده — فقط شمارنده‌های چرخه در دسترس است."
        : "جزئیات کاندید برای چرخه‌های قدیمی در دفتر ثبت نشده است. فقط خلاصهٔ چرخه (candidatesEvaluated / filled / skipped / reasonCounts) موجود است. از فعال‌سازی SHADOW_DECISION_TRACE به‌بعد ردپای کامل نوشته می‌شود."
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}
