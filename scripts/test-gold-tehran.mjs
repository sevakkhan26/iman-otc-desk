const TEHRAN_OFFSET = "+03:30";
const TEHRAN_TZ = "Asia/Tehran";

function parseTehranNaiveDateTime(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const parsed = new Date(`${normalized}${TEHRAN_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseNavasanEpoch(value) {
  if (!Number.isFinite(value)) return null;
  const ms = value > 1e12 ? value : value * 1000;
  const parsed = new Date(ms);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function clampToNow(iso) {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = Date.now();
  if (parsed.getTime() > now) return new Date(now).toISOString();
  return iso;
}

function formatGoldTehran(iso) {
  return new Intl.DateTimeFormat("fa-IR", {
    timeZone: TEHRAN_TZ,
    dateStyle: "short",
    timeStyle: "short",
    hour12: false
  }).format(new Date(iso));
}

function tehranParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TEHRAN_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour, minute, ms: hour * 60_000 + minute * 60_000 };
}

function assertFutureClamp(label, iso) {
  const clamped = clampToNow(iso);
  if (!clamped) throw new Error(`${label}: clamp failed`);
  if (new Date(clamped).getTime() > Date.now()) {
    throw new Error(`${label}: clamped time still in the future`);
  }
}

const now = new Date();
const nowTehran = tehranParts(now);

// Talavest: prefer unix timestamp over serverTime (serverTime can be +1h ahead).
const talavestTimestamp = 1783855953;
const talavestServerTime = "2026-07-12 16:02:33";
const fromTimestamp = clampToNow(parseNavasanEpoch(talavestTimestamp).toISOString());
const fromServerTime = clampToNow(parseTehranNaiveDateTime(talavestServerTime).toISOString());
assertFutureClamp("talavest timestamp", fromTimestamp);
assertFutureClamp("talavest serverTime", fromServerTime);

const tsDisplay = tehranParts(new Date(fromTimestamp));
if (tsDisplay.hour > nowTehran.hour || (tsDisplay.hour === nowTehran.hour && tsDisplay.minute > nowTehran.minute + 1)) {
  throw new Error(`talavest timestamp display ahead of now: ${formatGoldTehran(fromTimestamp)}`);
}

// Bonbast naive datetime is Tehran local.
const bonbastIso = clampToNow(parseTehranNaiveDateTime("2026-07-12 14:10:00").toISOString());
assertFutureClamp("bonbast", bonbastIso);

// Display uses a single Asia/Tehran format pass.
const utcIso = "2026-07-12T10:40:00.000Z";
const once = formatGoldTehran(utcIso);
const twice = formatGoldTehran(new Date(utcIso).toISOString());
if (once !== twice) {
  throw new Error(`double-format mismatch: ${once} vs ${twice}`);
}

console.log("gold tehran time tests passed");
console.log("now Tehran:", formatGoldTehran(now.toISOString()));
console.log("talavest timestamp:", formatGoldTehran(fromTimestamp));
console.log("bonbast sample:", formatGoldTehran(bonbastIso));