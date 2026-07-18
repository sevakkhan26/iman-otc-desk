import { NextResponse } from "next/server";
import { getSession } from "@/lib/authSession";
import { createPriceAlert, getPriceAlertsPage } from "@/lib/priceAlerts/service";
import type { CreateAlertInput } from "@/lib/priceAlerts/service";
import { getStorageDiagnostics, PriceAlertStorageError } from "@/lib/priceAlerts/store";
import type {
  PriceAlertCondition,
  PriceAlertInstrumentId,
  PriceAlertPriceType,
  PriceAlertProviderMode,
  PriceAlertRepeatMode
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

const NO_STORE = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

function json(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), { status, headers: NO_STORE });
}

function storageErrorResponse(error: unknown) {
  if (error instanceof PriceAlertStorageError) {
    const status = error.code === "STORAGE_NOT_CONFIGURED" || error.code === "UPSTASH_NOT_CONFIGURED" ? 503 : 500;
    return json(
      {
        error: error.code,
        message: error.message,
        diagnostics: getStorageDiagnostics()
      },
      status
    );
  }
  console.error("[api/alerts]", error instanceof Error ? error.stack ?? error.message : error);
  return json(
    {
      error: "failed",
      message: "خطای سرور هنگام بارگذاری هشدارها",
      diagnostics: getStorageDiagnostics()
    },
    500
  );
}

export async function GET() {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized", message: "ابتدا وارد شوید" }, 401);
  try {
    const page = await getPriceAlertsPage(session.r);
    return json(page);
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized", message: "ابتدا وارد شوید" }, 401);
  if (session.r !== "admin") {
    return json({ error: "forbidden", message: "فقط ادمین می‌تواند هشدار بسازد" }, 403);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json", message: "بدنه درخواست نامعتبر است" }, 400);
  }

  const input: CreateAlertInput = {
    instrument: body.instrument as PriceAlertInstrumentId,
    targetPrice: Number(body.targetPrice),
    condition: body.condition as PriceAlertCondition,
    priceType: body.priceType as PriceAlertPriceType,
    providerMode: (body.providerMode as PriceAlertProviderMode) ?? "any",
    providerId: (body.providerId as string | null | undefined) ?? null,
    enabled: body.enabled !== false,
    repeatMode: (body.repeatMode as PriceAlertRepeatMode) ?? "once",
    cooldownSeconds: body.cooldownSeconds != null ? Number(body.cooldownSeconds) : 300,
    note: (body.note as string | null | undefined) ?? null,
    createdBy: session.u
  };

  try {
    const alert = await createPriceAlert(input);
    return json({ alert }, 201);
  } catch (error) {
    if (error instanceof PriceAlertStorageError) return storageErrorResponse(error);
    const message = error instanceof Error ? error.message : "ایجاد هشدار ناموفق بود";
    return json({ error: "validation", message }, 400);
  }
}
