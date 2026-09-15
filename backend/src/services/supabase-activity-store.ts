import { randomBytes } from "node:crypto";
import type { ActivityRecord, NewActivityInput } from "./activity-store.js";

export type ActivityRow = {
  id: string; share_code: string; organizer_user_id: string; organizer_name: string; organizer_address: string;
  title: string; location: string; starts_at: string; funding_deadline: string; replacement_cutoff: string;
  capacity: number; contribution: string; currency: "EUR"; recipient_name: string; recipient_address: string;
  description: string | null; confirmed_count: number; status: ActivityRecord["status"]; terms_hash: string;
  escrow_address: string | null; deployment_transaction_hash: string | null; created_at: string;
};

export class SupabaseActivityStore {
  constructor(private readonly url: string, private readonly serviceRoleKey: string, private readonly request = fetch) {}

  async create(input: NewActivityInput) {
    const record: ActivityRecord = { ...input, shareCode: randomBytes(12).toString("base64url"), confirmedCount: 0, status: "deployment_pending", createdAt: new Date().toISOString() };
    const response = await this.rest("/rest/v1/count_me_in_activities", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(toActivityRow(record)) });
    return fromActivityRow((await this.json<ActivityRow[]>(response))[0]);
  }
  async get(id: string) { return this.one(`id=eq.${encodeURIComponent(id)}`); }
  async byShareCode(code: string) { return this.one(`share_code=eq.${encodeURIComponent(code)}`); }
  async listForOrganizer(userId: string) { return this.many(`organizer_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`); }
  async all() { return this.many("order=created_at.asc"); }
  async confirmDeployment(id: string, escrowAddress: string, deploymentTransactionHash: string) {
    return this.update(id, { escrow_address: escrowAddress, deployment_transaction_hash: deploymentTransactionHash, status: "collecting" });
  }
  async syncChainState(id: string, confirmedCount: number, status: Exclude<ActivityRecord["status"], "deployment_pending">) {
    return this.update(id, { confirmed_count: confirmedCount, status });
  }

  private async one(filter: string) { return (await this.many(`${filter}&limit=1`))[0]; }
  private async many(query: string) {
    const response = await this.rest(`/rest/v1/count_me_in_activities?select=*&${query}`);
    return (await this.json<ActivityRow[]>(response)).map(fromActivityRow);
  }
  private async update(id: string, values: Partial<ActivityRow>) {
    const response = await this.rest(`/rest/v1/count_me_in_activities?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(values) });
    const [row] = await this.json<ActivityRow[]>(response);
    if (!row) throw new Error("Activity not found.");
    return fromActivityRow(row);
  }
  private rest(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("apikey", this.serviceRoleKey); headers.set("Authorization", `Bearer ${this.serviceRoleKey}`); headers.set("Content-Type", "application/json");
    return this.request(new URL(path, this.url), { ...init, headers });
  }
  private async json<T>(response: Response): Promise<T> { if (!response.ok) throw new Error(`Supabase activity persistence failed (${response.status}): ${await response.text()}`); return response.json() as Promise<T>; }
}

export function toActivityRow(value: ActivityRecord): ActivityRow {
  return { id: value.id, share_code: value.shareCode, organizer_user_id: value.organizerUserId, organizer_name: value.organizerName,
    organizer_address: value.organizerAddress, title: value.title, location: value.location, starts_at: value.startsAt,
    funding_deadline: value.fundingDeadline, replacement_cutoff: value.replacementCutoff, capacity: value.capacity,
    contribution: value.contribution, currency: value.currency, recipient_name: value.recipientName, recipient_address: value.recipientAddress,
    description: value.description ?? null, confirmed_count: value.confirmedCount, status: value.status, terms_hash: value.termsHash,
    escrow_address: value.escrowAddress ?? null, deployment_transaction_hash: value.deploymentTransactionHash ?? null, created_at: value.createdAt };
}
export function fromActivityRow(row: ActivityRow): ActivityRecord {
  return { id: row.id, shareCode: row.share_code, organizerUserId: row.organizer_user_id, organizerName: row.organizer_name,
    organizerAddress: row.organizer_address, title: row.title, location: row.location, startsAt: iso(row.starts_at),
    fundingDeadline: iso(row.funding_deadline), replacementCutoff: iso(row.replacement_cutoff), capacity: row.capacity,
    contribution: row.contribution, currency: row.currency, recipientName: row.recipient_name, recipientAddress: row.recipient_address,
    description: row.description ?? undefined, confirmedCount: row.confirmed_count, status: row.status, termsHash: row.terms_hash,
    escrowAddress: row.escrow_address ?? undefined, deploymentTransactionHash: row.deployment_transaction_hash ?? undefined, createdAt: iso(row.created_at) };
}
function iso(value: string | Date) { return value instanceof Date ? value.toISOString() : value; }
