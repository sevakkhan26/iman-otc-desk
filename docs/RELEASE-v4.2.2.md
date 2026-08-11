# Release v4.2.2

Hotfix for Shadow UI defects found after v4.2.1.

## Fixes

1. **Exchange status layout** — root cause was `repeat(auto-fill, minmax(0, 1fr))`, which created near-zero-width tracks and collapsed venue cards. Replaced with responsive 3 → 2 → 1 columns using `minmax(0, 1fr)`. Cards show name, health, buy/sell taker fees, buyer depth, seller depth only.

2. **Why trade decision copy** — replaced technical field dumps and English `Unavailable` with a Persian headline (`معامله انجام شد چون…` / `معامله انجام نشد چون…`), grouped available facts, and collapsed advanced details. Missing values are omitted or one concise Persian note; rejection reasons preserved; no invented numbers.

## Non-goals

No engine, sizing, fees, accounting, risk, session, schema, or audit history changes.

## Version

- `version.json` / `package.json`: **4.2.2**
