import { Suspense } from "react";
import { DecisionMonitorPage } from "@/components/shadowArbitrage/DecisionMonitorPage";

export default function DecisionMonitorRoute() {
  return (
    <Suspense fallback={<div className="sa-dm-page" aria-busy="true" />}>
      <DecisionMonitorPage />
    </Suspense>
  );
}
