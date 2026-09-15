import type { FamilyRecord } from "../family-store.js";
import { FamilyTreasuryClient } from "../chain/family-treasury-client.js";

export type FamilyContext = {
  family: FamilyRecord;
  treasuryAddress: string;
  recentActivity?: Awaited<ReturnType<FamilyTreasuryClient["recentActivity"]>>;
  observedAt?: string;
  contacts?: { name: string; address: string }[];
  treasury: Awaited<ReturnType<FamilyTreasuryClient["summary"]>>;
};

export class FamilyContextService {
  constructor(private readonly chain: FamilyTreasuryClient) {}
  async load(family: FamilyRecord, treasuryAddress: string): Promise<FamilyContext> {
    const treasury = await this.chain.summary(treasuryAddress);
    // A temporary history-provider failure must not make the CFO unavailable.
    const recentActivity = await this.chain.recentActivity(treasuryAddress).catch(() => undefined);
    return { family, treasuryAddress, treasury, recentActivity, observedAt: new Date().toISOString() };
  }
}
