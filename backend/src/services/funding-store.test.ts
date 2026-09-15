import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FundingStore } from "./funding-store.js";

describe("FundingStore", () => {
  it("persists pending bank funding across restarts and binds one provider transaction", () => {
    const dir = mkdtempSync(join(tmpdir(), "ours-funding-")); const file = join(dir, "funding.json");
    try {
      const store = new FundingStore(file);
      const intent = store.create({ familyId: "family", requestedBy: "owner", treasuryAddress: "0x0000000000000000000000000000000000000001", vaultId: 2, sourceAmount: "100", sourceCurrency: "EUR" });
      store.update(intent.id, { moonPayTransactionId: "transaction-1", paymentMethod: "sepa", status: "payment_pending" });
      expect(new FundingStore(file).get(intent.id)).toMatchObject({ moonPayTransactionId: "transaction-1", paymentMethod: "sepa", status: "payment_pending", vaultId: 2 });
      expect(new FundingStore(file).byTransaction("transaction-1")?.id).toBe(intent.id);
    } finally { rmSync(dir, { recursive: true }); }
  });
});
