# Release v4.2.4

Visible order-book Bid/Ask volume on Exchange Status.

## Formulas

- **Buyer (Bid) volume** = Σ quantity of every valid received Bid level  
- **Seller (Ask) volume** = Σ quantity of every valid received Ask level  
- **Toman** = Σ (`priceToman` × `quantity`) on all included levels  
- No `max_slippage_bps`, capital, balances, caps, or capacity fallbacks  
- Stale/missing/empty/malformed/crossed → `ناموجود`  
- Quote-only (e.g. AbanTether) → `دفتر سفارش چندسطحی ارائه نمی‌شود`  
- Label: «حجم قابل‌مشاهده در دفتر سفارش دریافتی»  

Engine slippage-bounded depth (`slippageBoundedDepth` / sizing) is unchanged.

## Version

**4.2.4**
