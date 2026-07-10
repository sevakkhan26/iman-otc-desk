import { NextResponse } from "next/server";
import { getGoldHistory } from "@/lib/goldHistory";
import type { GoldHistoryRange, GoldInstrumentType } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const INSTRUMENTS: GoldInstrumentType[] = [
  "اونس طلا به دلار",
  "یک گرم طلای 18 عیار",
  "سکه طرح امامی",
  "مثقال طلای آبشده"
];

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const range: GoldHistoryRange = params.get("range") === "7d" ? "7d" : "24h";
  const instrumentParam = params.get("instrument");
  const instrument = INSTRUMENTS.includes(instrumentParam as GoldInstrumentType)
    ? (instrumentParam as GoldInstrumentType)
    : "یک گرم طلای 18 عیار";

  return NextResponse.json(await getGoldHistory(range, instrument));
}