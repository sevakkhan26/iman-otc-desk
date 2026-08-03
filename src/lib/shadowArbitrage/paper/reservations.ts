/**
 * Atomic capacity reservation for paper fills.
 *
 * Several routes compete for the same virtual balance inside one cycle. Sizing
 * each of them against the FULL balance is how two candidates end up sized to
 * spend the same toman: both look affordable, the first commits, and the second
 * only discovers the problem when the ledger refuses it. That is a race the
 * engine can lose quietly, and quietly is the dangerous part — the second
 * candidate is then recorded as "insufficient balance" as though the market had
 * changed, when in fact the desk had already spent the money on itself.
 *
 * This module removes the race by making capacity a resource that is HELD
 * before a fill is planned and released or committed afterwards. A hold is
 * all-or-nothing across both legs: a fill that cannot reserve both sides
 * reserves neither, so no partial hold can strand capacity on one venue.
 *
 * Holds are keyed by the caller's own identifier — the lifecycle id — which is
 * what makes a retry safe. Re-reserving an id that is already held is reported
 * as a duplicate rather than doubling the hold, so a cycle that is re-run after
 * a restart cannot reserve the same capacity twice.
 *
 * Pure module: no database, no network, no clock, no exchange client. It moves
 * numbers between two in-memory maps and nothing else.
 */
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";
import type { VenueBalance } from "@/lib/shadowArbitrage/paper/broker";

/** What one leg of a fill needs held on one venue. Both figures are positive. */
export type ReservationEntry = {
  sourceId: string;
  /** Toman that must remain available on this venue until the fill settles. */
  irtToman: number;
  /** USDT micros that must remain available on this venue. */
  usdtMicros: number;
};

export type ReservationBook = {
  balances: Map<string, { irtToman: number; usdtMicros: number }>;
  reserved: Map<string, { irtToman: number; usdtMicros: number }>;
  holds: Map<string, ReservationEntry[]>;
};

const ZERO = { irtToman: 0, usdtMicros: 0 };

/** A book over a copy of the balances — the caller's array is never mutated. */
export function createReservationBook(balances: VenueBalance[]): ReservationBook {
  return {
    balances: new Map(
      balances.map((b) => [b.sourceId as string, { irtToman: b.irtToman, usdtMicros: b.usdtMicros }])
    ),
    reserved: new Map(),
    holds: new Map()
  };
}

/** Balance minus everything currently held. Null when the venue is unknown. */
export function availableFor(
  book: ReservationBook,
  sourceId: string
): { irtToman: number; usdtMicros: number } | null {
  const balance = book.balances.get(sourceId);
  if (!balance) return null;
  const held = book.reserved.get(sourceId) ?? ZERO;
  return {
    irtToman: balance.irtToman - held.irtToman,
    usdtMicros: balance.usdtMicros - held.usdtMicros
  };
}

/**
 * The unreserved book, in the shape the sizer expects.
 *
 * This is what makes sizing race-free: a route sized against THIS array cannot
 * propose spending capacity another route in the same cycle already holds.
 */
export function availableBalances(book: ReservationBook): VenueBalance[] {
  const out: VenueBalance[] = [];
  // Map iteration follows insertion order, so the caller's own venue order is
  // preserved — a book that comes back reordered is a book nobody can diff.
  for (const [sourceId] of book.balances) {
    const a = availableFor(book, sourceId);
    if (!a) continue;
    out.push({
      sourceId: sourceId as ShadowSourceId,
      irtToman: Math.max(0, a.irtToman),
      usdtMicros: Math.max(0, a.usdtMicros)
    });
  }
  return out;
}

export type ReservationFailureCode =
  | "duplicate_hold"
  | "no_balance_record"
  | "insufficient_irt"
  | "insufficient_usdt";

export const RESERVATION_FAILURE_FA: Record<ReservationFailureCode, string> = {
  duplicate_hold: "برای این شناسه پیش‌تر ظرفیت رزرو شده است",
  no_balance_record: "برای این صرافی موجودی مجازی ثبت نشده است",
  insufficient_irt: "موجودی تومانی آزاد این صرافی کافی نیست",
  insufficient_usdt: "موجودی تتری آزاد این صرافی کافی نیست"
};

export type ReservationResult =
  | { ok: true; holdId: string; entries: ReservationEntry[] }
  | {
      ok: false;
      code: ReservationFailureCode;
      sourceId: string | null;
      shortfallIrtToman: number;
      shortfallUsdtMicros: number;
      reasonFa: string;
    };

function failure(
  code: ReservationFailureCode,
  sourceId: string | null,
  shortfallIrtToman = 0,
  shortfallUsdtMicros = 0
): ReservationResult {
  return {
    ok: false,
    code,
    sourceId,
    shortfallIrtToman,
    shortfallUsdtMicros,
    reasonFa: RESERVATION_FAILURE_FA[code]
  };
}

/**
 * Hold capacity for a whole fill, or hold nothing.
 *
 * Every entry is checked against the CURRENT availability before any of them is
 * applied. That ordering is the atomicity: a failure on the second leg leaves
 * the first leg untouched, so a rejected fill never strands capacity that no
 * later candidate can use.
 */
export function reserveAtomic(
  book: ReservationBook,
  holdId: string,
  entries: ReservationEntry[]
): ReservationResult {
  if (book.holds.has(holdId)) return failure("duplicate_hold", null);

  // Same venue on both legs would otherwise be checked twice against the same
  // headroom and pass while needing double. Merging first makes that impossible.
  const merged = new Map<string, ReservationEntry>();
  for (const e of entries) {
    const prev = merged.get(e.sourceId);
    merged.set(e.sourceId, {
      sourceId: e.sourceId,
      irtToman: (prev?.irtToman ?? 0) + Math.max(0, Math.round(e.irtToman)),
      usdtMicros: (prev?.usdtMicros ?? 0) + Math.max(0, Math.round(e.usdtMicros))
    });
  }

  for (const e of merged.values()) {
    const a = availableFor(book, e.sourceId);
    if (!a) return failure("no_balance_record", e.sourceId);
    if (a.irtToman < e.irtToman) {
      return failure("insufficient_irt", e.sourceId, e.irtToman - a.irtToman, 0);
    }
    if (a.usdtMicros < e.usdtMicros) {
      return failure("insufficient_usdt", e.sourceId, 0, e.usdtMicros - a.usdtMicros);
    }
  }

  const applied = [...merged.values()];
  for (const e of applied) {
    const held = book.reserved.get(e.sourceId) ?? ZERO;
    book.reserved.set(e.sourceId, {
      irtToman: held.irtToman + e.irtToman,
      usdtMicros: held.usdtMicros + e.usdtMicros
    });
  }
  book.holds.set(holdId, applied);
  return { ok: true, holdId, entries: applied };
}

/** Give the capacity back. Unknown ids are a no-op, so a double release is safe. */
export function releaseHold(book: ReservationBook, holdId: string): boolean {
  const entries = book.holds.get(holdId);
  if (!entries) return false;
  for (const e of entries) {
    const held = book.reserved.get(e.sourceId) ?? ZERO;
    book.reserved.set(e.sourceId, {
      irtToman: Math.max(0, held.irtToman - e.irtToman),
      usdtMicros: Math.max(0, held.usdtMicros - e.usdtMicros)
    });
  }
  book.holds.delete(holdId);
  return true;
}

export type CommitEntry = {
  sourceId: string;
  /** Signed. A debit is negative — the same numbers the broker's legs carry. */
  deltaIrtToman: number;
  deltaUsdtMicros: number;
};

export type CommitResult =
  | { ok: true; balancesAfter: VenueBalance[] }
  | { ok: false; code: "unknown_hold" | "negative_balance_guard"; sourceId: string | null };

/**
 * Settle a held fill: release the hold and apply the real signed movements.
 *
 * The hold is the worst case (the full debit); the commit is what actually
 * moved, which is never larger. Balances are checked after the movement and
 * before anything is written back, so a fill that would drive either asset
 * negative leaves the book exactly as it was — hold included.
 */
export function commitHold(
  book: ReservationBook,
  holdId: string,
  deltas: CommitEntry[]
): CommitResult {
  if (!book.holds.has(holdId)) return { ok: false, code: "unknown_hold", sourceId: null };

  const next = new Map<string, { irtToman: number; usdtMicros: number }>();
  for (const d of deltas) {
    const current = next.get(d.sourceId) ?? book.balances.get(d.sourceId);
    if (!current) return { ok: false, code: "unknown_hold", sourceId: d.sourceId };
    const updated = {
      irtToman: current.irtToman + Math.round(d.deltaIrtToman),
      usdtMicros: current.usdtMicros + Math.round(d.deltaUsdtMicros)
    };
    if (updated.irtToman < 0 || updated.usdtMicros < 0) {
      return { ok: false, code: "negative_balance_guard", sourceId: d.sourceId };
    }
    next.set(d.sourceId, updated);
  }

  releaseHold(book, holdId);
  const balancesAfter: VenueBalance[] = [];
  for (const [sourceId, value] of next) {
    book.balances.set(sourceId, value);
    balancesAfter.push({
      sourceId: sourceId as ShadowSourceId,
      irtToman: value.irtToman,
      usdtMicros: value.usdtMicros
    });
  }
  return { ok: true, balancesAfter };
}

/**
 * The book's current balances, holds excluded — what the session now owns.
 * Returned in the order the caller supplied, so a before/after diff lines up.
 */
export function settledBalances(book: ReservationBook): VenueBalance[] {
  return [...book.balances.entries()].map(([sourceId, v]) => ({
    sourceId: sourceId as ShadowSourceId,
    irtToman: v.irtToman,
    usdtMicros: v.usdtMicros
  }));
}

/** Total capacity currently held, for reporting. Never used as a limit itself. */
export function totalReserved(book: ReservationBook): {
  irtToman: number;
  usdtMicros: number;
  holds: number;
} {
  let irtToman = 0;
  let usdtMicros = 0;
  for (const r of book.reserved.values()) {
    irtToman += r.irtToman;
    usdtMicros += r.usdtMicros;
  }
  return { irtToman, usdtMicros, holds: book.holds.size };
}
