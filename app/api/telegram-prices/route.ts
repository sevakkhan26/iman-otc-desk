import { NextResponse } from "next/server";
import { getTelegramPrices } from "@/lib/providers/telegram";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  return NextResponse.json(await getTelegramPrices());
}
