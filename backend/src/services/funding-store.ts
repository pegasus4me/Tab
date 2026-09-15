import { randomUUID } from "node:crypto";
import { JsonStore } from "./storage/json-store.js";

export type FundingStatus = "created" | "customer_setup" | "quoted" | "payment_pending" | "settled" | "allocation_pending" | "completed" | "failed" | "expired";
export type FundingIntent = {
  id: string; familyId: string; requestedBy: string; treasuryAddress: string; vaultId?: number;
  sourceAmount: string; sourceCurrency: "USD" | "EUR" | "GBP"; status: FundingStatus;
  quote?: { sourceAmount: string; destinationAmount: string; feeAmount: string; exchangeRate: string; expiresAt?: string; paymentMethod: string };
  moonPayTransactionId?: string; paymentMethod?: string; receivedAmount?: string;
  allocationTransactionHash?: `0x${string}`; createdAt: string; updatedAt: string;
};
export class FundingStore {
  private readonly records: JsonStore<FundingIntent>;
  constructor(path?: string) { this.records = new JsonStore(path); }
  all() { return this.records.all(); }
  byTransaction(transactionId: string) { return this.records.all().find(intent => intent.moonPayTransactionId === transactionId); }
  create(input: Omit<FundingIntent, "id" | "status" | "createdAt" | "updatedAt">) {
    const now = new Date().toISOString();
    return this.records.put({ ...input, id: randomUUID(), status: "created", createdAt: now, updatedAt: now });
  }
  get(id: string) { return this.records.get(id); }
  update(id: string, values: Partial<FundingIntent>) {
    const current = this.get(id); if (!current) throw new Error("Funding request not found.");
    return this.records.put({ ...current, ...values, id: current.id, updatedAt: new Date().toISOString() });
  }
}
