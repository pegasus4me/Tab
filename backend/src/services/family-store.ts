import { JsonStore } from "./storage/json-store.js";
export type FamilyRecord = {
  id: string;
  name: string;
  parentAddresses: string[];
  createdAt: string;
  treasuryAddress?: string;
  focus?: string;
  initialVaults?: { name: string; floor: string; withdrawalApprovalsRequired: number }[];
};

/**
 * Development adapter. The API deliberately depends on this tiny interface so it
 * can be replaced with Postgres without changing the onchain domain layer.
 */
export class FamilyStore {
  private readonly records: JsonStore<FamilyRecord>;
  constructor(path?: string) { this.records = new JsonStore(path); }
  list(wallets: string[]) { return this.records.all().filter(record => record.parentAddresses.some(parent => wallets.some(wallet => wallet.toLowerCase() === parent.toLowerCase()))); }
  all() { return this.records.all(); }
  updateProfile(id: string, name: string, focus: string) {
    const record = this.get(id); if (!record) throw new Error("Family not found.");
    return this.records.put({ ...record, name, focus });
  }
  create(record: FamilyRecord) {
    if (this.records.get(record.id)) throw new Error("This family already exists.");
    this.records.put(record);
    return record;
  }
  get(id: string) { return this.records.get(id); }
  setTreasury(id: string, treasuryAddress: string) {
    const record = this.records.get(id);
    if (!record) throw new Error("Family not found.");
    const next = { ...record, treasuryAddress };
    this.records.put(next);
    return next;
  }
  addOwner(id: string, address: string) {
    const record = this.get(id); if (!record) throw new Error("Family not found.");
    if (record.parentAddresses.some(parent => parent.toLowerCase() === address.toLowerCase())) return record;
    return this.records.put({ ...record, parentAddresses: [...record.parentAddresses, address] });
  }
}
