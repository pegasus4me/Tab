import { expect, it, vi } from "vitest";
import { runDueSchedules } from "./schedule-runner.js";
import type { FamilyTreasuryClient } from "./chain/family-treasury-client.js";
it("executes only active due schedules and isolates a rejected payment", async () => {
  const call = { contractAddress: "0x1", callData: "0x" };
  const chain = { summary: vi.fn().mockResolvedValue({ scheduledTransfers: [
    { id: 0, active: false, nextExecutionAt: 1 }, { id: 1, active: true, nextExecutionAt: 999 },
    { id: 2, active: true, nextExecutionAt: 1 }, { id: 3, active: true, nextExecutionAt: 1 },
  ] }), executeScheduledTransfer: vi.fn().mockReturnValue(call), simulate: vi.fn().mockRejectedValueOnce(new Error("floor")).mockResolvedValue(undefined) };
  const send = vi.fn().mockResolvedValue("hash");
  const result = await runDueSchedules(["treasury"], chain as unknown as FamilyTreasuryClient, "runner", send, 100);
  expect(chain.executeScheduledTransfer.mock.calls.map(call => call[1])).toEqual([2, 3]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(result[0].error).toBeDefined();
  expect(result[1].hash).toBe("hash");
});
