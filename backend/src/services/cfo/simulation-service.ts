import type { ContractCall } from "../chain/contract-call.js";
import { FamilyTreasuryClient } from "../chain/family-treasury-client.js";

export class SimulationService {
  constructor(private readonly chain: FamilyTreasuryClient) {}
  async simulate(calls: ContractCall[], account: string) {
    const results = await Promise.all(calls.map(async (call) => {
      try { await this.chain.simulate(call, account); return { to: call.contractAddress, data: call.callData, ok: true }; }
      catch (error) { return { to: call.contractAddress, data: call.callData, ok: false, error: error instanceof Error ? error.message : "Simulation failed." }; }
    }));
    return { ok: results.every((result) => result.ok), calls: results };
  }
}
