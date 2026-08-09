import { redirect } from "next/navigation";

/**
 * Decision Monitor terminal UI removed (Step 5).
 * Stored audit/decision data and GET /api/shadow-arbitrage/decision-monitor remain.
 * Old bookmarks land on Activity.
 */
export default function DecisionMonitorRoute() {
  redirect("/shadow-arbitrage?tab=activity");
}
