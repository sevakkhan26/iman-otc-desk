#!/usr/bin/env npx tsx
/**
 * Live public certification probe for every Shadow Arbitrage source.
 *
 * No API keys, no authenticated endpoints, no orders — public market data only.
 * Prints the evidence behind each certification status so the table in
 * docs/SHADOW-ARBITRAGE-PHASE2.md can be reproduced on demand.
 *
 *   pnpm shadow:certify
 *   SHADOW_CERTIFY_ROUNDS=3 pnpm shadow:certify   # repeat to judge stability
 */
import { collectAllShadowSources } from "../src/lib/shadowArbitrage/adapters/index.ts";
import {
  certifyFromSnapshot,
  getCertification,
  setCertification
} from "../src/lib/shadowArbitrage/certification.ts";
import { SHADOW_SOURCES } from "../src/lib/shadowArbitrage/config.ts";
import type { NormalizedSourceSnapshot } from "../src/lib/shadowArbitrage/types.ts";

const rounds = Math.max(1, Number(process.env.SHADOW_CERTIFY_ROUNDS ?? 1) || 1);

function pad(v: unknown, n: number): string {
  return String(v ?? "—").padEnd(n);
}

async function main() {
  console.log("\nShadow Arbitrage — live public certification (read-only)\n");
  console.log("No exchange credentials are used and no orders are placed.\n");

  const perSource = new Map<string, NormalizedSourceSnapshot[]>();

  for (let round = 1; round <= rounds; round += 1) {
    const t0 = Date.now();
    const sources = await collectAllShadowSources();
    console.log(`round ${round}/${rounds} — wall time ${Date.now() - t0}ms`);
    for (const s of sources) {
      // Carry each round's verdict forward, exactly as the collector does.
      setCertification(certifyFromSnapshot(s));
      const list = perSource.get(s.sourceId) ?? [];
      list.push(s);
      perSource.set(s.sourceId, list);
    }
    if (round < rounds) await new Promise((r) => setTimeout(r, 2_000));
  }

  console.log("");
  console.log(
    [
      pad("source", 12),
      pad("status", 16),
      pad("http", 6),
      pad("lat", 8),
      pad("unit", 6),
      pad("depth", 7),
      pad("dir", 6),
      pad("user buy", 11),
      pad("user sell", 11),
      pad("max USDT", 10),
      "notes"
    ].join(" ")
  );
  console.log("-".repeat(150));

  for (const cfg of SHADOW_SOURCES) {
    const samples = perSource.get(cfg.id) ?? [];
    const last = samples[samples.length - 1];
    const cert = getCertification(cfg.id);
    const okCount = samples.filter((s) => s.health !== "unavailable").length;
    console.log(
      [
        pad(cfg.id, 12),
        pad(cert.status, 16),
        pad(last?.meta.httpStatus, 6),
        pad(last?.meta.latencyMs != null ? `${last.meta.latencyMs}ms` : null, 8),
        pad(last?.meta.priceUnit, 6),
        pad(last?.meta.depthAvailable, 7),
        pad(last?.meta.directionVerified, 6),
        pad(last?.userBuyPriceToman, 11),
        pad(last?.userSellPriceToman, 11),
        pad(last?.maxExecutableUsdt, 10),
        `${okCount}/${samples.length} reachable · ${(cert.statusReason ?? last?.degradedReason ?? "").slice(0, 60)}`
      ].join(" ")
    );
  }

  console.log("\nDocumented facts per source:\n");
  for (const cfg of SHADOW_SOURCES) {
    const cert = getCertification(cfg.id);
    console.log(`${cfg.id} — ${cert.status}`);
    console.log(`  endpoint      ${cert.endpoint}`);
    console.log(`  symbol/model  ${cert.marketSymbol} · ${cert.marketModel}`);
    console.log(`  units         price ${cert.priceUnit} → IRT · quantity ${cert.quantityUnit}`);
    console.log(`  direction     ${cert.directionNote}`);
    console.log(`  depth         ${cert.depthNote}`);
    console.log(`  timestamp     ${cert.timestampNote}`);
    console.log(`  rate limit    ${cert.rateLimitNote}`);
    console.log(
      `  fee           ${cert.feeStatus}${cert.feeValueBps != null ? ` ${cert.feeValueBps / 100}%` : ""}` +
        `${cert.feeVerifiedAt ? ` (checked ${cert.feeVerifiedAt})` : ""} — ${cert.feeExplanation}`
    );
    console.log(`  limitation    ${cert.limitations}`);
    console.log("");
  }

  const byStatus = new Map<string, string[]>();
  for (const cfg of SHADOW_SOURCES) {
    const st = getCertification(cfg.id).status;
    byStatus.set(st, [...(byStatus.get(st) ?? []), cfg.id]);
  }
  for (const [status, ids] of byStatus) console.log(`${status}: ${ids.join(", ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
