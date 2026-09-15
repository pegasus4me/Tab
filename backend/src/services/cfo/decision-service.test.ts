import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionService } from "./decision-service.js";
import type { FamilyContext } from "./family-context-service.js";
const context = { family: { name: "Family", focus: "Protect our reserve" }, treasury: { unallocatedBalance: "450", vaults: [{ id: 0, name: "Emergency", balance: "100", floor: "100" }] } } as unknown as FamilyContext;
const output = (value: unknown, status = "completed") => new Response(JSON.stringify({ status, output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }] }));
afterEach(() => vi.unstubAllEnvs());
describe("CFO decisions", () => {
  it("sends real family context and a strict output schema, while allowing clarification without a payment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const request = vi.fn().mockResolvedValue(output({ reply: "What is your goal?", plan: null }));
    const result = await new DecisionService(request).decide([{ role: "user", content: "Help us plan" }], context);
    const body = JSON.parse(request.mock.calls[0][1].body);
    expect(JSON.parse(body.input[0].content).liveFamilyContext.treasury.unallocatedBalance).toBe("450");
    expect(body.text.format.strict).toBe(true);
    expect(result.plan).toBeNull();
  });
  it("rejects unsupported asset execution even when returned by the model", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const request = vi.fn().mockResolvedValue(output({ reply: "Buy", plan: { summary: "Buy", requiredApprovals: 1, actions: [{ type: "swap", amount: "100" }] } }));
    await expect(new DecisionService(request).decide([], context)).rejects.toThrow();
  });
  it("does not prepare partial or truncated output", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    await expect(new DecisionService(vi.fn().mockResolvedValue(output({}, "incomplete"))).decide([], context)).rejects.toThrow(/did not finish/);
  });
  it("rejects multi-operation plans to avoid partially executed approvals", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test");
    const action = { type: "allocate", allocations: [{ vaultId: 0, amount: "100" }] };
    const request = vi.fn().mockResolvedValue(output({ reply: "Allocate", plan: { summary: "Allocate", requiredApprovals: 1, actions: [action, action] } }));
    await expect(new DecisionService(request).decide([], context)).rejects.toThrow(/one operation/);
  });
});
