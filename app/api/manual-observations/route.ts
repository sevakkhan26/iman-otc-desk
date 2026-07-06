import { NextResponse } from "next/server";
import { addManualObservation, getManualObservations, type ManualObservation } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ items: await getManualObservations() });
}

export async function POST(request: Request) {
  try {
    const item = await addManualObservation((await request.json()) as Partial<ManualObservation>);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "ثبت مشاهده انجام نشد" }, { status: 400 });
  }
}
