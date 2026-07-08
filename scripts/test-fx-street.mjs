#!/usr/bin/env node
/**
 * Direct Node test for Navasan/Bonbast fetches.
 * Run after build: node scripts/test-fx-street.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadProvider() {
  try {
    const mod = await import(path.join(root, "src/lib/providers/fxStreet.ts"));
    return mod.getFxStreetPrices;
  } catch {
    // fallback: invoke through local API if server is running
    const response = await fetch("http://127.0.0.1:3000/api/fx-prices");
    const data = await response.json();
    console.log(JSON.stringify(data, null, 2));
    process.exit(data.items?.length ? 0 : 1);
  }
}

const settings = {
  enabledSources: { navasan: true, bonbast: true }
};

const getFxStreetPrices = await loadProvider();
const data = await getFxStreetPrices(settings);
console.log("quotes:", data.quotes.length);
for (const quote of data.quotes) {
  console.log(`${quote.sourceId} | ${quote.assetType} | buy=${quote.buyPrice} sell=${quote.sellPrice}`);
}
if (data.notes?.length) console.log("notes:", data.notes.join(" · "));
process.exit(data.quotes.length ? 0 : 1);