import { NextResponse } from "next/server";
import { getMedianHistory } from "@/lib/history";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  const range = new URL(request.url).searchParams.get("range") === "7d" ? "7d" : "24h";
  return NextResponse.json(await getMedianHistory(range));
}
