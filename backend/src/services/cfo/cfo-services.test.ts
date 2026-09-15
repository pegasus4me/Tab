import { describe, expect, it } from "vitest";
import { actionSchema } from "./action-schema.js";
import { CfoAgentService } from "./cfo-agent-service.js";
import { PolicyValidator } from "./policy-validator.js";
import type { FamilyContext } from "./family-context-service.js";

const parent = "0x0000000000000000000000000000000000000001";
const mamie = "0x0000000000000000000000000000000000000002";
const context: FamilyContext = {
  family: { id: "00000000-0000-4000-8000-000000000001", name: "Martin", parentAddresses: [parent], createdAt: "2026-01-01T00:00:00.000Z" },
  treasuryAddress: "0x0000000000000000000000000000000000000010",
  treasury: {
    address: "0x0000000000000000000000000000000000000010", network: "monad-testnet", currency: "USDC", parents: [parent], unallocatedBalance: "500",
    vaults: [{ id: 0, name: "Mamie", balance: "1000", floor: "200", withdrawalApprovalsRequired: 2 }], withdrawals: [], scheduledTransfers: [],
  },
};

describe("CFO plan boundary", () => {
  it("turns a weekly request into a typed plan, not calldata", () => {
    const plan = new CfoAgentService().interpret(`Envoyer 300 USDC chaque semaine depuis Mamie à ${mamie}`, context);
    expect(plan.actions).toEqual([expect.objectContaining({ type: "propose_scheduled_transfer", sourceVaultId: 0, recipient: mamie, amount: "300", intervalSeconds: 604800 })]);
    expect(plan.requiredApprovals).toBe(2);
  });

  it("rejects a plan that breaches a vault floor before simulation", () => {
    const result = new PolicyValidator().validate({ summary: "Pay", requiredApprovals: 2, actions: [{ type: "propose_withdrawal", vaultId: 0, recipient: mamie, amount: "801" }] }, context);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/floor/i);
  });

  it("does not allow zero-value actions into a plan", () => {
    expect(actionSchema.safeParse({ type: "allocate", allocations: [{ vaultId: 0, amount: "0.000000" }] }).success).toBe(false);
  });
});

it("reserves funds for pending payments and rejects invented recipients", () => {
  const state = structuredClone(context);
  state.contacts = [{ name: "Mamie", address: mamie }];
  state.treasury.withdrawals = [{ id: 0, vaultId: 0, recipient: mamie, amount: "700", approvals: 1, executed: false }];
  const plan = { summary: "Pay", requiredApprovals: 2, actions: [{ type: "propose_withdrawal" as const, vaultId: 0, recipient: mamie, amount: "200" }] };
  expect(new PolicyValidator().validate(plan, state).issues.join(" ")).toMatch(/commitments/);
  plan.actions[0].recipient = parent;
  expect(new PolicyValidator().validate(plan, state).issues.join(" ")).toMatch(/Invite/);
});
