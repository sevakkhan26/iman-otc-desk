import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import { loadHistory } from "@/lib/shadowArbitrage";
import { SHADOW_BANNER } from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


export async function GET(request: Request) {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const url = new URL(request.url);
  const activeOnly = url.searchParams.get("active") === "1";
  const size = url.searchParams.get("size");
  const netPositive = url.searchParams.get("netPositive") === "1";

  let items = await loadHistory();
  if (activeOnly) items = items.filter((o) => o.isActive);
  if (size) items = items.filter((o) => String(o.sizeUsdt) === size);
  if (netPositive) {
    items = items.filter(
      (o) => o.netProfitToman > 0 && !o.blockedReasons.includes("fee_unknown") && o.eligibility !== "BLOCKED"
    );
  }
  items = items.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, 500);

  return new NextResponse(
    JSON.stringify({
      banner: SHADOW_BANNER,
      shadowMode: true,
      serverNow: new Date().toISOString(),
      count: items.length,
      opportunities: items
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}
