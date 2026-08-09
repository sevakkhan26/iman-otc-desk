# Release v4.2.0

## Summary

Production release of Local Paper work through Step 6 onto main (includes 4.1.10.2 Exir monitoring hotfix).

## Features

- Configurable Paper session setup: capital (whole toman), duration (days → frozen `endsAt`), order-cap `AUTO_CAPITAL_DERIVED` or `MANUAL`.
- `paper_policy_min` fixed at 5 USDT (not an exchange limit); ledger quantum 0.0001 USDT.
- Capital-aware smart sizing (no fixed 5/10/20/25 executable ladder in UI).
- Read-only trade details for closed Paper fills (fees, VWAP, P&amp;L, sizing audit).
- Session capital replace archives history; never silent extend.
- Decision Monitor full-page terminal UI removed (old URL redirects to Activity); API/audit data retained.
- Local fee evidence seed for RC parity only (release bootstrap unchanged in Production).

## Safety

- `LIVE_EXECUTION_IMPLEMENTED = false`
- Paper-only; DISARMED live readiness
- No automatic Paper session create/stop/replace on deploy
- Exir public v2 orderbook monitoring (4.1.10.2) preserved

## Migrations

Additive SQL only: `0017_shadow_paper_decision_traces.sql`, `0018_shadow_sizing_audit.sql` (plus prior 0015–0016 from earlier Paper work already on main lineage).

## Version

- `version.json` `appVersion`: **4.2.0**
- `package.json` `version`: **4.2.0**
