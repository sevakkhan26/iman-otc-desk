/**
 * Phase 7A — the only executable implementation of `ExecutionSurfacePort`.
 *
 * It delegates to the Phase 6 paper broker, so "executing" a leg means running
 * the same virtual-balance arithmetic the paper session already uses. There is
 * no network call, no credential and no venue on the other end.
 *
 * `canPlaceRealOrders` is the literal `false`. A live surface would have to be
 * a different file that does not exist, and the port's type forbids one from
 * claiming otherwise.
 */
import { feeFromBps, mulPriceSizeToman } from "@/lib/shadowArbitrage/money";
import { settlementFor, settlementUsable, usdtToMicros } from "@/lib/shadowArbitrage/paper/broker";
import type {
  ExecutionSurfacePort,
  LegOutcome,
  LegRequest
} from "@/lib/shadowArbitrage/live/executionPlan";

/**
 * Paper surface.
 *
 * Idempotent on `clientOrderId`: a repeated request returns the original
 * outcome flagged as a duplicate instead of simulating a second fill. That is
 * the behaviour a real venue's client-order-id de-duplication would provide,
 * and it is what makes a retry-after-timeout safe to specify and test now.
 */
export function createPaperSurface(): ExecutionSurfacePort {
  const answered = new Map<string, LegOutcome>();

  return {
    surface: "PAPER",
    canPlaceRealOrders: false,
    async simulateLeg(request: LegRequest): Promise<LegOutcome> {
      const prior = answered.get(request.clientOrderId);
      if (prior) return { ...prior, duplicateOfPriorRequest: true };

      const side = request.side === "BUY" ? "buy" : "sell";
      const settlement = settlementFor(request.sourceId, side);
      const requestedUsdtMicros = usdtToMicros(request.sizeUsdt);

      if (!settlementUsable(settlement)) {
        const rejected: LegOutcome = {
          clientOrderId: request.clientOrderId,
          filledUsdtMicros: 0,
          requestedUsdtMicros,
          avgPriceToman: null,
          status: "REJECTED",
          duplicateOfPriorRequest: false,
          reasonFa: "نحوهٔ تسویهٔ کارمزد این صرافی تأیید نشده است"
        };
        answered.set(request.clientOrderId, rejected);
        return rejected;
      }

      // A paper leg fills completely at the stated limit price: the depth check
      // already happened upstream, and inventing partials here would fabricate
      // execution quality the desk has no evidence for.
      const notional = mulPriceSizeToman(request.limitPriceToman, request.sizeUsdt);
      void feeFromBps(notional, 0);

      const outcome: LegOutcome = {
        clientOrderId: request.clientOrderId,
        filledUsdtMicros: requestedUsdtMicros,
        requestedUsdtMicros,
        avgPriceToman: request.limitPriceToman,
        status: "FILLED",
        duplicateOfPriorRequest: false,
        reasonFa: null
      };
      answered.set(request.clientOrderId, outcome);
      return outcome;
    }
  };
}
