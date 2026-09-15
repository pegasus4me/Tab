import type { FamilyTreasuryClient } from "./chain/family-treasury-client.js";
import type { ContractCall } from "./chain/contract-call.js";

/** A cycle executes at most one due instalment per schedule. Contract rules remain authoritative. */
export async function runDueSchedules(addresses: string[], chain: Pick<FamilyTreasuryClient, "summary" | "executeScheduledTransfer" | "simulate">, account: string, send: (call: ContractCall) => Promise<string>, now = Math.floor(Date.now() / 1000)) {
  const results: { treasury: string; scheduleId?: number; hash?: string; error?: string }[] = [];
  for (const address of addresses) {
    try {
      const summary = await chain.summary(address);
      for (const schedule of summary.scheduledTransfers) {
        if (!schedule.active || schedule.nextExecutionAt > now) continue;
        try {
          const call = chain.executeScheduledTransfer(address, schedule.id);
          await chain.simulate(call, account);
          results.push({ treasury: address, scheduleId: schedule.id, hash: await send(call) });
        } catch { results.push({ treasury: address, scheduleId: schedule.id, error: "Execution deferred: check the schedule, available funds and runner account." }); }
      }
    } catch { results.push({ treasury: address, error: "Unable to read treasury." }); }
  }
  return results;
}
