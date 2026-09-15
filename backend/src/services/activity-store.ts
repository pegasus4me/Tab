import { randomBytes } from "node:crypto";
import { JsonStore } from "./storage/json-store.js";

export type ActivityRecord = {
  id: string;
  shareCode: string;
  organizerUserId: string;
  organizerName: string;
  organizerAddress: string;
  title: string;
  location: string;
  startsAt: string;
  fundingDeadline: string;
  replacementCutoff: string;
  capacity: number;
  contribution: string;
  currency: "EUR";
  recipientName: string;
  recipientAddress: string;
  description?: string;
  confirmedCount: number;
  status: "deployment_pending" | "collecting" | "ready" | "funded" | "failed" | "cancelled";
  termsHash: string;
  escrowAddress?: string;
  deploymentTransactionHash?: string;
  createdAt: string;
};
export type NewActivityInput = Omit<ActivityRecord, "shareCode" | "confirmedCount" | "status" | "createdAt">;

export class ActivityStore {
  private readonly records: JsonStore<ActivityRecord>;
  constructor(path?: string) { this.records = new JsonStore(path); }
  create(input: NewActivityInput) {
    const record: ActivityRecord = {
      ...input,
      shareCode: randomBytes(12).toString("base64url"),
      confirmedCount: 0,
      status: "deployment_pending",
      createdAt: new Date().toISOString(),
    };
    this.records.put(record);
    return record;
  }
  get(id: string) { return this.records.get(id); }
  all() { return this.records.all(); }
  byShareCode(code: string) { return this.records.all().find((record) => record.shareCode === code); }
  listForOrganizer(userId: string) { return this.records.all().filter((record) => record.organizerUserId === userId); }
  confirmDeployment(id: string, escrowAddress: string, deploymentTransactionHash: string) {
    const record = this.get(id); if (!record) throw new Error("Activity not found.");
    return this.records.put({ ...record, escrowAddress, deploymentTransactionHash, status: "collecting" });
  }
  syncChainState(id: string, confirmedCount: number, status: Exclude<ActivityRecord["status"], "deployment_pending">) {
    const record = this.get(id); if (!record) throw new Error("Activity not found.");
    return this.records.put({ ...record, confirmedCount, status });
  }
}
