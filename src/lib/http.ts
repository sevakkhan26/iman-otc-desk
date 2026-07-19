import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { Agent as HttpsAgent } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FX_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
  "user-agent": BROWSER_UA
};

const SINKHOLE_IPS = new Set(["10.10.34.36", "0.0.0.0", "127.0.0.1"]);

const DOH_RESOLVERS = [
  { ip: "1.1.1.1", host: "cloudflare-dns.com" },
  { ip: "8.8.8.8", host: "dns.google" },
  { ip: "9.9.9.9", host: "dns.quad9.net" }
] as const;

const FALLBACK_HOST_IPS: Record<string, string[]> = {
  "www.navasan.net": ["104.21.44.125", "172.67.199.191"],
  "bonbast.com": ["104.21.44.125", "172.67.199.191"],
  // ArvanCloud edges for Arzinja (IR) — helps when DoH/system DNS fails on production
  "api-v2.arzinja.ir": ["185.143.234.235", "185.143.233.235"],
  "arzinja.ir": ["185.143.234.235", "185.143.233.235"]
};

/**
 * Hosts forced through OUTBOUND_HTTPS_PROXY.
 * Default `*` = all outbound provider traffic when a proxy URL is set.
 * Override with PROXY_HOSTS=bonbast.com,www.navasan.net for a allow-list.
 */
const DEFAULT_PROXY_HOSTS = ["*"];

const ipCache = new Map<string, { ips: string[]; at: number }>();
const IP_CACHE_TTL_MS = 10 * 60_000;

let cachedProxyAgent: HttpsAgent | null | undefined;

function readOutboundProxyUrl(): string | null {
  const raw =
    process.env.OUTBOUND_HTTPS_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    "";
  return raw || null;
}

function getOutboundProxyAgent(): HttpsAgent | undefined {
  if (cachedProxyAgent !== undefined) {
    return cachedProxyAgent ?? undefined;
  }
  const url = readOutboundProxyUrl();
  if (!url) {
    cachedProxyAgent = null;
    return undefined;
  }
  try {
    cachedProxyAgent = new HttpsProxyAgent(url) as unknown as HttpsAgent;
    return cachedProxyAgent;
  } catch {
    cachedProxyAgent = null;
    return undefined;
  }
}

function proxyHostList(): string[] {
  const raw = process.env.PROXY_HOSTS?.trim();
  if (!raw) return DEFAULT_PROXY_HOSTS;
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether this hostname should use the configured outbound HTTP(S) proxy. */
export function shouldUseOutboundProxy(hostname: string): boolean {
  if (!getOutboundProxyAgent()) return false;
  const host = hostname.toLowerCase();
  const list = proxyHostList();
  if (list.includes("*")) return true;
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

/**
 * fetch that honors OUTBOUND_HTTPS_PROXY for matching hosts.
 * HTTPS uses HttpsProxyAgent; plain HTTP uses classic proxy request path.
 * Use this (or fetchJson/fetchText/…) for all server-side outbound HTTP.
 */
export async function outboundFetch(url: string, init?: RequestInit): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return fetch(url, init);
  }

  if (!shouldUseOutboundProxy(target.hostname)) {
    return fetch(url, init);
  }

  const proxyUrl = readOutboundProxyUrl();
  if (!proxyUrl) {
    return fetch(url, init);
  }

  const method = (init?.method ?? "GET").toUpperCase();
  const headers = headersToRecord(init?.headers);
  const body =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof URLSearchParams
        ? init.body.toString()
        : undefined;

  if (target.protocol === "https:") {
    const agent = getOutboundProxyAgent();
    if (!agent) return fetch(url, init);
    const result = await httpsRequestOnce(
      target.hostname,
      target.hostname,
      {
        url,
        timeoutMs: 30_000,
        headers,
        method: method === "POST" ? "POST" : "GET",
        body
      },
      agent
    );
    const responseHeaders = new Headers();
    for (const cookie of result.setCookie) {
      responseHeaders.append("set-cookie", cookie);
    }
    return new Response(result.text, { status: result.status, headers: responseHeaders });
  }

  // HTTP via proxy: request absolute URL to the proxy host.
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new ProviderError("زمان پاسخ‌دهی منبع تمام شد"));
    }, 30_000);

    const auth =
      proxy.username || proxy.password
        ? Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
          ).toString("base64")
        : null;

    const req = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port || 80),
        method,
        path: url,
        headers: {
          ...headers,
          Host: target.host,
          ...(auth ? { "Proxy-Authorization": `Basic ${auth}` } : {}),
          ...(body
            ? {
                "content-type": headers["content-type"] ?? "application/x-www-form-urlencoded",
                "content-length": Buffer.byteLength(body)
              }
            : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          clearTimeout(timer);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value == null) continue;
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(key, item);
            } else {
              responseHeaders.set(key, value);
            }
          }
          resolve(
            new Response(Buffer.concat(chunks).toString("utf8"), {
              status: res.statusCode ?? 0,
              headers: responseHeaders
            })
          );
        });
      }
    );

    req.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProviderError(error.message || "خطای شبکه proxy"));
    });
    if (body) req.write(body);
    req.end();
  });
}

function shouldRetryWithHttps(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("econnreset") ||
    msg.includes("timed out")
  );
}

function isSinkholeIp(ip: string): boolean {
  if (SINKHOLE_IPS.has(ip)) return true;
  if (ip.startsWith("10.")) return true;
  return false;
}

function parseDoH(text: string): string[] {
  const payload = JSON.parse(text) as { Answer?: Array<{ type: number; data: string }> };
  return (payload.Answer ?? [])
    .filter((entry) => entry.type === 1 && entry.data && !isSinkholeIp(entry.data))
    .map((entry) => entry.data);
}

function dohLookup(hostname: string, resolver: (typeof DOH_RESOLVERS)[number], timeoutMs: number): Promise<string[]> {
  const path = `/dns-query?name=${encodeURIComponent(hostname)}&type=A`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new ProviderError("زمان پاسخ‌دهی DNS تمام شد"));
    }, timeoutMs);

    const req = https.request(
      {
        hostname: resolver.ip,
        servername: resolver.host,
        port: 443,
        path,
        method: "GET",
        headers: {
          accept: "application/dns-json",
          host: resolver.host
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          clearTimeout(timer);
          if ((res.statusCode ?? 0) >= 400) {
            reject(new ProviderError(`DoH HTTP ${res.statusCode ?? 0}`));
            return;
          }
          try {
            const ips = parseDoH(Buffer.concat(chunks).toString("utf8"));
            if (!ips.length) {
              reject(new ProviderError("آدرس معتبری از DoH دریافت نشد"));
              return;
            }
            resolve(ips);
          } catch {
            reject(new ProviderError("پاسخ DoH معتبر نبود"));
          }
        });
      }
    );

    req.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProviderError(error.message || "خطای DoH"));
    });
    req.end();
  });
}

async function resolveViaDoH(hostname: string, timeoutMs: number): Promise<string[]> {
  let lastError: ProviderError | null = null;
  for (const resolver of DOH_RESOLVERS) {
    try {
      return await dohLookup(hostname, resolver, Math.min(timeoutMs, 8_000));
    } catch (error) {
      lastError = error instanceof ProviderError ? error : new ProviderError("خطای DoH");
    }
  }
  throw lastError ?? new ProviderError("خطای DoH");
}

async function resolveHostname(hostname: string, timeoutMs: number): Promise<string[]> {
  const cached = ipCache.get(hostname);
  if (cached && Date.now() - cached.at < IP_CACHE_TTL_MS) {
    return cached.ips;
  }

  let ips: string[] = [];
  try {
    ips = await resolveViaDoH(hostname, timeoutMs);
  } catch {
    try {
      const lookedUp = await dns.lookup(hostname, { family: 4 });
      if (!isSinkholeIp(lookedUp.address)) {
        ips = [lookedUp.address];
      }
    } catch {
      // fall through
    }
  }

  if (!ips.length) {
    ips = [...(FALLBACK_HOST_IPS[hostname] ?? [])];
  }

  try {
    const lookedUp = await dns.lookup(hostname, { family: 4 });
    if (lookedUp.address && !ips.includes(lookedUp.address)) {
      ips.push(lookedUp.address);
    }
  } catch {
    // ignore
  }

  if (!ips.length) {
    throw new ProviderError(`نام دامنه ${hostname} قابل resolve نیست`);
  }

  ipCache.set(hostname, { ips, at: Date.now() });
  return ips;
}

type HttpsRequestOptions = {
  url: string;
  timeoutMs: number;
  headers: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
};

function httpsRequestOnce(
  hostname: string,
  /** Connect target: IP for direct, or hostname when using proxy agent. */
  connectHost: string,
  options: HttpsRequestOptions,
  agent?: HttpsAgent
): Promise<{ status: number; text: string; setCookie: string[] }> {
  const target = new URL(options.url);
  const payload = options.body ?? "";

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new ProviderError("زمان پاسخ‌دهی منبع تمام شد"));
    }, options.timeoutMs);

    const req = https.request(
      {
        host: connectHost,
        servername: hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        agent,
        headers: {
          ...options.headers,
          host: hostname,
          ...(options.method === "POST"
            ? {
                // Keep caller content-type (e.g. application/json); default form for POST bodies.
                ...(!(
                  options.headers["content-type"] ||
                  options.headers["Content-Type"]
                )
                  ? { "content-type": "application/x-www-form-urlencoded" }
                  : {}),
                "content-length": Buffer.byteLength(payload)
              }
            : {})
        }
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const setCookie = (res.headers["set-cookie"] ?? []).map((entry) => entry.split(";")[0]);
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({ status, text: Buffer.concat(chunks).toString("utf8"), setCookie });
        });
      }
    );

    req.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProviderError(error.message || "خطای شبکه"));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

async function httpsRequestViaProxy(
  options: HttpsRequestOptions,
  agent: HttpsAgent
): Promise<{ text: string; setCookie: string[] }> {
  const target = new URL(options.url);
  const response = await httpsRequestOnce(target.hostname, target.hostname, options, agent);
  if (response.status >= 400) {
    throw new ProviderError(`HTTP ${response.status}`);
  }
  if (!response.text.trim()) {
    throw new ProviderError("پاسخ خالی بود");
  }
  return response;
}

async function httpsRequestResolved(options: HttpsRequestOptions): Promise<{ text: string; setCookie: string[] }> {
  const target = new URL(options.url);
  if (target.protocol !== "https:") {
    throw new ProviderError("فقط HTTPS پشتیبانی می‌شود");
  }

  // Filtered sources (e.g. Bonbast) — use HTTP CONNECT proxy when configured.
  if (shouldUseOutboundProxy(target.hostname)) {
    const agent = getOutboundProxyAgent();
    if (agent) {
      try {
        return await httpsRequestViaProxy(options, agent);
      } catch (error) {
        // Fall through to direct path only if proxy fails (usually still blocked).
        if (error instanceof ProviderError) {
          // Prefer surfacing proxy error so ops can see it in provider status.
          throw new ProviderError(`proxy: ${error.message}`);
        }
        throw error;
      }
    }
  }

  const ips = await resolveHostname(target.hostname, options.timeoutMs);
  let lastError: ProviderError | null = null;

  for (const ip of ips) {
    try {
      const response = await httpsRequestOnce(target.hostname, ip, options);
      if (response.status >= 400) {
        throw new ProviderError(`HTTP ${response.status}`);
      }
      if (!response.text.trim()) {
        throw new ProviderError("پاسخ خالی بود");
      }
      return response;
    } catch (error) {
      lastError = error instanceof ProviderError ? error : new ProviderError("خطای شبکه");
    }
  }

  throw lastError ?? new ProviderError("اتصال به منبع برقرار نشد");
}

function httpsGetText(url: string, timeoutMs: number, headers: Record<string, string>): Promise<string> {
  return httpsRequestResolved({ url, timeoutMs, headers }).then((response) => response.text);
}

function httpsPostForm<T>(
  url: string,
  body: Record<string, string>,
  timeoutMs: number,
  headers: Record<string, string>
): Promise<T> {
  const payload = new URLSearchParams(body).toString();
  return httpsRequestResolved({
    url,
    timeoutMs,
    headers,
    method: "POST",
    body: payload
  }).then((response) => {
    try {
      return JSON.parse(response.text) as T;
    } catch {
      throw new ProviderError("پاسخ JSON معتبر نبود");
    }
  });
}

function httpsGetWithCookies(url: string, timeoutMs: number, headers: Record<string, string>): Promise<{ html: string; cookies: string }> {
  return httpsRequestResolved({ url, timeoutMs, headers }).then((response) => ({
    html: response.text,
    cookies: response.setCookie.join("; ")
  }));
}

function parseJsonResponse<T>(text: string): T {
  if (!text.trim()) {
    throw new ProviderError("پاسخ خالی بود");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError("پاسخ JSON معتبر نبود");
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 10_000, init?: RequestInit): Promise<T> {
  const headers = {
    accept: "application/json, text/plain;q=0.8, */*;q=0.5",
    "user-agent": BROWSER_UA,
    ...(init?.headers ?? {})
  } as Record<string, string>;

  try {
    const text = await httpsGetText(url, timeoutMs, headers);
    return parseJsonResponse<T>(text);
  } catch (httpsError) {
    if (!(httpsError instanceof ProviderError)) {
      throw httpsError;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await outboundFetch(url, {
      ...init,
      cache: "no-store",
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new ProviderError(`HTTP ${response.status}`);
    }

    return parseJsonResponse<T>(await response.text());
  } catch (error) {
    if (shouldRetryWithHttps(error)) {
      try {
        return parseJsonResponse<T>(await httpsGetText(url, timeoutMs, headers));
      } catch (retryError) {
        if (retryError instanceof ProviderError) throw retryError;
      }
    }
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
    }
    throw new ProviderError(error instanceof Error ? error.message : "خطای نامشخص منبع");
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(url: string, timeoutMs = 10_000, init?: RequestInit): Promise<string> {
  const headers = {
    accept: "application/rss+xml, application/xml, text/xml, text/plain;q=0.8, */*;q=0.8",
    "user-agent": BROWSER_UA,
    ...(init?.headers ?? {})
  } as Record<string, string>;

  try {
    return await httpsGetText(url, timeoutMs, headers);
  } catch (httpsError) {
    if (!(httpsError instanceof ProviderError)) {
      throw httpsError;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await outboundFetch(url, {
      ...init,
      cache: "no-store",
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new ProviderError(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new ProviderError("پاسخ خالی بود");
    }

    return text;
  } catch (error) {
    if (shouldRetryWithHttps(error)) {
      return httpsGetText(url, timeoutMs, headers);
    }
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
    }
    throw new ProviderError(error instanceof Error ? error.message : "خطای نامشخص منبع");
  } finally {
    clearTimeout(timeout);
  }
}

function cookieHeaderFrom(response: Response): string {
  const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie
      .call(response.headers)
      .map((entry) => entry.split(";")[0])
      .join("; ");
  }
  const single = response.headers.get("set-cookie");
  return single ? single.split(";")[0] : "";
}

export async function fetchPostForm<T>(
  url: string,
  body: Record<string, string>,
  timeoutMs = 10_000,
  init?: RequestInit
): Promise<T> {
  const headers = {
    accept: "application/json, text/plain;q=0.8, */*;q=0.5",
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": BROWSER_UA,
    ...(init?.headers ?? {})
  } as Record<string, string>;

  try {
    return await httpsPostForm<T>(url, body, timeoutMs, headers);
  } catch (httpsError) {
    if (!(httpsError instanceof ProviderError)) {
      throw httpsError;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await outboundFetch(url, {
      ...init,
      method: "POST",
      cache: "no-store",
      headers,
      body: new URLSearchParams(body).toString(),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new ProviderError(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new ProviderError("پاسخ خالی بود");
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError("پاسخ JSON معتبر نبود");
    }
  } catch (error) {
    if (shouldRetryWithHttps(error)) {
      return httpsPostForm<T>(url, body, timeoutMs, headers);
    }
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
    }
    throw new ProviderError(error instanceof Error ? error.message : "خطای نامشخص منبع");
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPageWithCookies(
  url: string,
  timeoutMs = 10_000
): Promise<{ html: string; cookies: string }> {
  const headers = { ...FX_HEADERS };

  try {
    return await httpsGetWithCookies(url, timeoutMs, headers);
  } catch (httpsError) {
    if (!(httpsError instanceof ProviderError)) {
      throw httpsError;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await outboundFetch(url, {
      cache: "no-store",
      headers,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new ProviderError(`HTTP ${response.status}`);
    }

    const html = await response.text();
    if (!html.trim()) {
      throw new ProviderError("پاسخ خالی بود");
    }

    return { html, cookies: cookieHeaderFrom(response) };
  } catch (error) {
    if (shouldRetryWithHttps(error)) {
      return httpsGetWithCookies(url, timeoutMs, headers);
    }
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
    }
    throw new ProviderError(error instanceof Error ? error.message : "خطای نامشخص منبع");
  } finally {
    clearTimeout(timeout);
  }
}

export function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}