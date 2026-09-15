import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";

const scrypt = promisify(scryptCallback);
const MAX_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

type PinRecord = {
  salt: string;
  hash: string;
  failedAttempts: number;
  lockedUntil?: number;
};

export type PinVerification = { ok: boolean; remainingAttempts?: number; lockedUntil?: string };
export type PinPersistence = {
  has(userId: string): Promise<boolean>;
  set(userId: string, pin: string): Promise<boolean>;
  verify(userId: string, pin: string, now?: number): Promise<PinVerification>;
};

/**
 * Development adapter. Persist this interface in the application's database
 * before production; PIN values are never stored, only a salted scrypt hash.
 */
export class PinStore implements PinPersistence {
  private readonly records = new Map<string, PinRecord>();

  async has(userId: string) { return this.records.has(userId); }

  async set(userId: string, pin: string) {
    if (this.records.has(userId)) return false;
    const salt = randomBytes(16).toString("base64url");
    const hash = await hashPin(pin, salt);
    this.records.set(userId, { salt, hash, failedAttempts: 0 });
    return true;
  }

  async verify(userId: string, pin: string, now = Date.now()): Promise<PinVerification> {
    const record = this.records.get(userId);
    if (!record) return { ok: false };
    if (record.lockedUntil && record.lockedUntil > now) return { ok: false, lockedUntil: new Date(record.lockedUntil).toISOString() };
    const candidate = Buffer.from(await hashPin(pin, record.salt), "hex");
    const expected = Buffer.from(record.hash, "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      this.records.set(userId, { ...record, failedAttempts: 0, lockedUntil: undefined });
      return { ok: true };
    }
    const failedAttempts = record.failedAttempts + 1;
    const lockedUntil = failedAttempts >= MAX_ATTEMPTS ? now + LOCK_DURATION_MS : undefined;
    this.records.set(userId, { ...record, failedAttempts: lockedUntil ? 0 : failedAttempts, lockedUntil });
    return lockedUntil
      ? { ok: false, lockedUntil: new Date(lockedUntil).toISOString() }
      : { ok: false, remainingAttempts: MAX_ATTEMPTS - failedAttempts };
  }
}

type SupabasePinRecord = {
  user_id: string;
  salt: string;
  hash: string;
  failed_attempts: number;
  locked_until: string | null;
};

/** Production adapter; the service-role key stays in the backend only. */
export class SupabasePinStore implements PinPersistence {
  constructor(private readonly url: string, private readonly serviceRoleKey: string, private readonly request = fetch) {}

  async has(userId: string) {
    const response = await this.rest(`/rest/v1/user_pins?select=user_id&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    return (await this.json<SupabasePinRecord[]>(response)).length > 0;
  }

  async set(userId: string, pin: string) {
    const salt = randomBytes(16).toString("base64url");
    const hash = await hashPin(pin, salt);
    const response = await this.rest("/rest/v1/user_pins", {
      method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: userId, salt, hash }),
    });
    if (response.status === 409) return false;
    await this.ensureOk(response);
    return true;
  }

  async verify(userId: string, pin: string, now = Date.now()): Promise<PinVerification> {
    const response = await this.rest(`/rest/v1/user_pins?select=user_id,salt,hash,failed_attempts,locked_until&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    const [record] = await this.json<SupabasePinRecord[]>(response);
    if (!record) return { ok: false };
    const rawLockedUntil = record.locked_until as string | Date | null;
    const lockedUntil = rawLockedUntil ? (rawLockedUntil instanceof Date ? rawLockedUntil.getTime() : Date.parse(rawLockedUntil)) : undefined;
    if (lockedUntil && lockedUntil > now) return { ok: false, lockedUntil: new Date(lockedUntil).toISOString() };
    const candidate = Buffer.from(await hashPin(pin, record.salt), "hex");
    const expected = Buffer.from(record.hash, "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      await this.update(userId, { failed_attempts: 0, locked_until: null });
      return { ok: true };
    }
    const failedAttempts = record.failed_attempts + 1;
    const nextLockedUntil = failedAttempts >= MAX_ATTEMPTS ? new Date(now + LOCK_DURATION_MS).toISOString() : null;
    await this.update(userId, { failed_attempts: nextLockedUntil ? 0 : failedAttempts, locked_until: nextLockedUntil });
    return nextLockedUntil ? { ok: false, lockedUntil: nextLockedUntil } : { ok: false, remainingAttempts: MAX_ATTEMPTS - failedAttempts };
  }

  private async update(userId: string, values: { failed_attempts: number; locked_until: string | null }) {
    await this.ensureOk(await this.rest(`/rest/v1/user_pins?user_id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(values),
    }));
  }

  private rest(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("apikey", this.serviceRoleKey);
    headers.set("Authorization", `Bearer ${this.serviceRoleKey}`);
    headers.set("Content-Type", "application/json");
    return this.request(new URL(path, this.url), { ...init, headers });
  }

  private async json<T>(response: Response): Promise<T> {
    await this.ensureOk(response);
    return response.json() as Promise<T>;
  }

  private async ensureOk(response: Response) {
    if (response.ok) return;
    throw new Error(`Supabase PIN persistence failed (${response.status}): ${await response.text()}`);
  }
}

export class PostgresPinStore implements PinPersistence {
  private readonly database: Pool;
  constructor(connectionString: string) { this.database = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 5 }); }
  async has(userId: string) { return (await this.database.query("select 1 from public.user_pins where user_id = $1 limit 1", [userId])).rowCount === 1; }
  async set(userId: string, pin: string) {
    const salt = randomBytes(16).toString("base64url"); const hash = await hashPin(pin, salt);
    return (await this.database.query("insert into public.user_pins (user_id,salt,hash) values ($1,$2,$3) on conflict (user_id) do nothing", [userId, salt, hash])).rowCount === 1;
  }
  async verify(userId: string, pin: string, now = Date.now()): Promise<PinVerification> {
    const result = await this.database.query<SupabasePinRecord>("select user_id,salt,hash,failed_attempts,locked_until from public.user_pins where user_id = $1", [userId]);
    const record = result.rows[0]; if (!record) return { ok: false };
    const rawLockedUntil = record.locked_until as string | Date | null;
    const lockedUntil = rawLockedUntil ? (rawLockedUntil instanceof Date ? rawLockedUntil.getTime() : Date.parse(rawLockedUntil)) : undefined;
    if (lockedUntil && lockedUntil > now) return { ok: false, lockedUntil: new Date(lockedUntil).toISOString() };
    const candidate = Buffer.from(await hashPin(pin, record.salt), "hex"); const expected = Buffer.from(record.hash, "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) { await this.update(userId, 0, null); return { ok: true }; }
    const failedAttempts = record.failed_attempts + 1; const nextLockedUntil = failedAttempts >= MAX_ATTEMPTS ? new Date(now + LOCK_DURATION_MS).toISOString() : null;
    await this.update(userId, nextLockedUntil ? 0 : failedAttempts, nextLockedUntil);
    return nextLockedUntil ? { ok: false, lockedUntil: nextLockedUntil } : { ok: false, remainingAttempts: MAX_ATTEMPTS - failedAttempts };
  }
  private async update(userId: string, failedAttempts: number, lockedUntil: string | null) { await this.database.query("update public.user_pins set failed_attempts = $2, locked_until = $3 where user_id = $1", [userId, failedAttempts, lockedUntil]); }
}

async function hashPin(pin: string, salt: string) {
  return (await scrypt(pin, salt, 64) as Buffer).toString("hex");
}
