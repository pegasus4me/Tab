import { JsonStore } from "../storage/json-store.js";
import type { ContractCall } from "../chain/contract-call.js";
import type { CfoPlan } from "./action-schema.js";

export type PlanStatus = "ready_for_confirmation" | "confirmed" | "rejected" | "submitted" | "executed" | "reverted";
export type StoredPlan = {
  id: string;
  familyId: string;
  requestedBy: string;
  message: string;
  plan?: CfoPlan;
  explanation: string;
  status: PlanStatus;
  createdAt: string;
  policyIssues: string[];
  preparedCall?: ContractCall;
  transactionHash?: `0x${string}`;
  executedAt?: string;
  simulation?: { ok: boolean; calls: { to: string; data: string; ok: boolean; error?: string }[] };
};

/** Development adapter; replace with a durable DB implementation in production. */
export class PlanStore {
  private readonly plans: JsonStore<StoredPlan>;
  constructor(path?: string) { this.plans = new JsonStore(path); }
  list(familyId: string) { return this.plans.all().filter(plan => plan.familyId === familyId); }
  update(plan: StoredPlan) { return this.plans.put(plan); }
  create(plan: StoredPlan) { this.plans.put(plan); return plan; }
  get(familyId: string, planId: string) {
    const plan = this.plans.get(planId);
    return plan?.familyId === familyId ? plan : undefined;
  }
  confirm(familyId: string, planId: string) {
    const plan = this.get(familyId, planId);
    if (!plan) throw new Error("Plan not found.");
    if (plan.status !== "ready_for_confirmation") throw new Error("Only a ready plan can be confirmed.");
    const next = { ...plan, status: "confirmed" as const };
    this.plans.put(next);
    return next;
  }
}
