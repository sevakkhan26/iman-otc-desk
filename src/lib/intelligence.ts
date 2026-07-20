/**
 * Intelligence reports — durable store: PostgreSQL app_settings key `intelligence_history`.
 */
import { pgGetKv, pgSetKv } from "@/db/repositories/kv";
import { outboundFetch } from "@/lib/http";
import type {
  AlertItem,
  DeskSettings,
  ExchangeOperationalStatus,
  GlobalPrice,
  ImpactNewsItem,
  IntelligenceReport,
  IntelligenceState,
  Severity,
  TetherMarketResponse
} from "@/lib/types";

type IntelligenceInput = {
  tetherMarket: TetherMarketResponse;
  globalMarket: GlobalPrice[];
  globalStatuses: ExchangeOperationalStatus[];
  news: ImpactNewsItem[];
  alerts: AlertItem[];
  settings: DeskSettings;
};

const KV_KEY = "intelligence_history";

const systemPrompt = `تو تحلیلگر ارشد Dealing Desk و OTC هستی.

بر اساس داده‌های واقعی ورودی، یک گزارش فارسی کوتاه و عملیاتی تولید کن.

فقط موارد مهم را بگو.

اگر اتفاق مهمی نیست، بنویس:

«ریسک خاصی مشاهده نشد.»

از ساختن عدد، خبر یا منبع خودداری کن.

فقط از داده ورودی استفاده کن.

خروجی شامل این بخش‌ها باشد:

* خلاصه وضعیت
* سطح ریسک
* قیمت تتر و اختلاف رقبا
* اخبار اثرگذار
* ریسک‌های عملیاتی
* اقدام پیشنهادی برای Pricing
* اقدام پیشنهادی برای Spread
* اقدام پیشنهادی برای LP Selection
* اقدام پیشنهادی برای Risk Limits
* اقدام پیشنهادی برای Treasury`;

async function readHistory(): Promise<IntelligenceReport[]> {
  try {
    const parsed = await pgGetKv<IntelligenceReport[] | { items?: IntelligenceReport[] }>(KV_KEY);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch {
    return [];
  }
}

async function writeHistory(history: IntelligenceReport[]) {
  await pgSetKv(KV_KEY, { items: history.slice(0, 200) }, "intelligence");
}

function section(text: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextLabels =
    "خلاصه وضعیت|سطح ریسک|قیمت تتر و اختلاف رقبا|اخبار اثرگذار|ریسک‌های عملیاتی|اقدام پیشنهادی برای Pricing|اقدام پیشنهادی برای Spread|اقدام پیشنهادی برای LP Selection|اقدام پیشنهادی برای Risk Limits|اقدام پیشنهادی برای Treasury";
  const regex = new RegExp(`${escaped}\\s*[:：]?\\s*([\\s\\S]*?)(?=\\n\\s*(?:\\*\\s*)?(?:${nextLabels})\\s*[:：]?|$)`, "i");
  return text.match(regex)?.[1]?.replace(/^[\s*-]+/, "").trim() || "داده‌ای دریافت نشد";
}

function riskFromText(text: string): Severity {
  if (/زیاد|بالا|پرریسک|high/i.test(text)) return "high";
  if (/متوسط|احتیاط|medium/i.test(text)) return "medium";
  return "low";
}

function parseReport(rawText: string): IntelligenceReport {
  const generatedAt = new Date().toISOString();
  const riskText = section(rawText, "سطح ریسک");
  return {
    id: `intel-${generatedAt}`,
    generatedAt,
    riskLevel: riskFromText(riskText),
    summary: section(rawText, "خلاصه وضعیت"),
    tetherAndCompetitors: section(rawText, "قیمت تتر و اختلاف رقبا"),
    importantNews: section(rawText, "اخبار اثرگذار"),
    operationalRisks: section(rawText, "ریسک‌های عملیاتی"),
    pricingAction: section(rawText, "اقدام پیشنهادی برای Pricing"),
    spreadAction: section(rawText, "اقدام پیشنهادی برای Spread"),
    lpSelectionAction: section(rawText, "اقدام پیشنهادی برای LP Selection"),
    riskLimitsAction: section(rawText, "اقدام پیشنهادی برای Risk Limits"),
    treasuryAction: section(rawText, "اقدام پیشنهادی برای Treasury"),
    rawText
  };
}

function shouldRefresh(history: IntelligenceReport[], refreshMinutes: number) {
  const latest = history[0];
  if (!latest) return true;
  const ageMs = Date.now() - new Date(latest.generatedAt).getTime();
  return ageMs > refreshMinutes * 60_000;
}

function snapshotForModel(input: IntelligenceInput) {
  return {
    generatedAt: new Date().toISOString(),
    tetherMarket: input.tetherMarket,
    globalMarket: input.globalMarket,
    globalExchangeStatuses: input.globalStatuses,
    impactNews: input.news,
    activeAlerts: input.alerts,
    thresholds: {
      outlierThresholdPercent: input.settings.outlierThresholdPercent,
      marketSpreadAlertThresholdPercent: input.settings.marketSpreadAlertThresholdPercent,
      depegAlertThresholdPercent: input.settings.depegAlertThresholdPercent
    }
  };
}

function responseText(payload: unknown) {
  if (payload && typeof payload === "object" && "output_text" in payload) {
    const value = (payload as { output_text?: unknown }).output_text;
    return typeof value === "string" ? value : null;
  }
  const output = payload && typeof payload === "object" ? (payload as { output?: unknown }).output : undefined;
  if (!Array.isArray(output)) return null;
  const textParts: string[] = [];
  for (const item of output) {
    const content = item && typeof item === "object" ? (item as { content?: unknown }).content : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && "text" in block) {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") textParts.push(text);
      }
    }
  }
  return textParts.join("\n").trim() || null;
}

async function generateWithOpenAI(input: IntelligenceInput): Promise<IntelligenceReport> {
  const apiKey = input.settings.openAiApiKey;
  const model = process.env.OPENAI_MODEL || "gpt-5";
  const response = await outboundFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: JSON.stringify(snapshotForModel(input), null, 2)
        }
      ],
      max_output_tokens: 900
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API خطا داد: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as unknown;
  const text = responseText(payload);
  if (!text) {
    throw new Error("خروجی متنی از OpenAI API دریافت نشد");
  }
  return parseReport(text);
}

export async function getIntelligenceState(input: IntelligenceInput): Promise<IntelligenceState> {
  const history = await readHistory();
  const latest = history[0] ?? null;
  if (!input.settings.openAiApiKey) {
    return {
      enabled: false,
      message: "تحلیل هوشمند فعال نیست",
      latest
    };
  }

  if (!shouldRefresh(history, input.settings.intelligenceRefreshMinutes)) {
    return {
      enabled: true,
      message: "آخرین تحلیل هوشمند موجود است",
      latest
    };
  }

  try {
    const report = await generateWithOpenAI(input);
    await writeHistory([report, ...history]);
    return {
      enabled: true,
      message: "تحلیل هوشمند تولید شد",
      latest: report
    };
  } catch (error) {
    return {
      enabled: true,
      message: error instanceof Error ? error.message : "تحلیل هوشمند تولید نشد",
      latest
    };
  }
}