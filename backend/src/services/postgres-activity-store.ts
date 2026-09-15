import { randomBytes } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import type { ActivityRecord, NewActivityInput } from "./activity-store.js";
import { fromActivityRow, toActivityRow, type ActivityRow } from "./supabase-activity-store.js";

type Database = { query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }> };

/** PostgreSQL persistence for Supabase direct/pooler connections. */
export class PostgresActivityStore {
  private readonly database: Database;
  constructor(connection: string | Database) {
    this.database = typeof connection === "string"
      ? new Pool({ connectionString: connection, ssl: { rejectUnauthorized: false }, max: 5 })
      : connection;
  }
  async create(input: NewActivityInput) {
    const record: ActivityRecord = { ...input, shareCode: randomBytes(12).toString("base64url"), confirmedCount: 0, status: "deployment_pending", createdAt: new Date().toISOString() };
    const row = toActivityRow(record);
    const columns = ["id", "share_code", "organizer_user_id", "organizer_name", "organizer_address", "title", "location", "starts_at", "funding_deadline", "replacement_cutoff", "capacity", "contribution", "currency", "recipient_name", "recipient_address", "description", "confirmed_count", "status", "terms_hash", "escrow_address", "deployment_transaction_hash", "created_at"] as const;
    const result = await this.database.query<ActivityRow & QueryResultRow>(`insert into public.count_me_in_activities (${columns.join(",")}) values (${columns.map((_, index) => `$${index + 1}`).join(",")}) returning *`, columns.map(column => row[column]));
    return fromActivityRow(result.rows[0]);
  }
  async get(id: string) { return this.one("id = $1", [id]); }
  async byShareCode(code: string) { return this.one("share_code = $1", [code]); }
  async listForOrganizer(userId: string) { return this.many("organizer_user_id = $1 order by created_at desc", [userId]); }
  async all() { return this.many("true order by created_at asc", []); }
  async confirmDeployment(id: string, escrowAddress: string, deploymentTransactionHash: string) { return this.update(id, "escrow_address = $2, deployment_transaction_hash = $3, status = 'collecting'", [escrowAddress, deploymentTransactionHash]); }
  async syncChainState(id: string, confirmedCount: number, status: Exclude<ActivityRecord["status"], "deployment_pending">) { return this.update(id, "confirmed_count = $2, status = $3", [confirmedCount, status]); }

  private async one(where: string, values: unknown[]) { return (await this.many(`${where} limit 1`, values))[0]; }
  private async many(where: string, values: unknown[]) { const result = await this.database.query<ActivityRow & QueryResultRow>(`select * from public.count_me_in_activities where ${where}`, values); return result.rows.map(fromActivityRow); }
  private async update(id: string, assignments: string, values: unknown[]) {
    const result = await this.database.query<ActivityRow & QueryResultRow>(`update public.count_me_in_activities set ${assignments} where id = $1 returning *`, [id, ...values]);
    if (!result.rows[0]) throw new Error("Activity not found.");
    return fromActivityRow(result.rows[0]);
  }
}
