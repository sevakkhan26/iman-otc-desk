import { NextResponse } from "next/server";
import { getTelegramPrices } from "@/lib/providers/telegram";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getTelegramPrices());
}
