# Release v4.2.1

Shadow UI simplification and decision explainability. Read-only UI release.

## Scope

- Primary nav order: سرمایه و حساب → سفارش‌ها → فعالیت‌ها → وضعیت صرافی‌ها → تنظیمات
- Compact permanent `PAPER / DISARMED` safety strip
- Accounts: portfolio + per-exchange capital + cycle count; experiment panel removed; session setup moved to Settings
- Orders: open/queued statuses only (`QUEUED` / `OPEN` / `PENDING` / `HELD`)
- Activity: top section «چرا معامله شد یا نشد؟» + completed trade details; Unavailable when data missing
- Venues: health + buy/sell taker fees + two usable depth values
- Settings: Paper session control + collapsed advanced diagnostics

## Non-goals

No changes to trading logic, smart sizing, fees, accounting, risk limits, Paper execution engine, session history storage, or audit APIs.

## Version

- `version.json` `appVersion`: **4.2.1**
- `package.json` `version`: **4.2.1**
