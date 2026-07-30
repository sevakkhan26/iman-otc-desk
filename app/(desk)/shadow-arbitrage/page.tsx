import { Suspense } from "react";
import { ShadowArbitrageView } from "@/components/ShadowArbitrageView";

/**
 * The view reads `?tab=` through useSearchParams, which Next requires to sit
 * inside a Suspense boundary so the shell can stream before the query is known.
 */
export default function ShadowArbitragePage() {
  return (
    <Suspense fallback={<div className="sa-page sa-page-booting" aria-busy="true" />}>
      <ShadowArbitrageView />
    </Suspense>
  );
}
