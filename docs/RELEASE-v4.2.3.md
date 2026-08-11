# Release v4.2.3

Correct pure order-book market depth on Exchange Status.

## Root cause of ~29.5-USDT class values

Exchange Status read `usableCapacityUsdt` (and capacity micros fallbacks), which is
`min(slippage depth, Paper balance, allocation, order cap, …)` — **not** book
depth. Live sample (local pglite):

| Venue  | Market Ask USDT | Market Bid USDT | Usable (old display class) |
|--------|-----------------|-----------------|----------------------------|
| nobitex | ~4395 | ~8768 | ~2954 |
| wallex  | ~1147 | ~3120 | ~2942 |

So the UI showed capital/policy-capped capacity, often far below pure depth.
Additionally `rawDepthToman` was approximated as `USDT × bestPrice` instead of
`Σ(price × qty)`.

## Formulas (pure market depth)

- **Ask depth** (`عمق سفارش‌های فروش (Ask)`): sum of ask levels within
  `max_slippage_bps` above best ask.
- **Bid depth** (`عمق سفارش‌های خرید (Bid)`): sum of bid levels within
  `max_slippage_bps` below best bid.
- **USDT** = Σ accepted `amountUsdt`.
- **Toman** = Σ (`priceToman` × `amountUsdt`) on accepted levels only.
- Per-venue own normalized book; no shared values, balances, caps, or fallbacks.
- Stale / missing / empty / malformed / crossed → **`ناموجود`**.

Executable capacity remains computed for sizing elsewhere and is **not** shown
as depth. Engine sizing unchanged.

## Version

`package.json` / `version.json` → **4.2.3**
