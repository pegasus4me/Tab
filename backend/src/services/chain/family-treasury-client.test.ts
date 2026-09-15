import { decodeFunctionData, parseAbi, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { EXTERNAL_RECIPIENT, FamilyTreasuryClient } from "./family-treasury-client.js";

const treasury = "0x0000000000000000000000000000000000000010";
const mamie = "0x0000000000000000000000000000000000000020";

describe("FamilyTreasuryClient calldata", () => {
  const client = new FamilyTreasuryClient();

  it("encodes one atomic allocation plan", () => {
    const call = client.allocate(treasury, [{ vaultId: 0, amount: "1000" }, { vaultId: 3, amount: "300" }]);
    const decoded = decodeFunctionData({ abi: parseAbi(["function allocate(uint256[] vaultIds,uint128[] amounts)"]), data: call.callData });
    expect(decoded.functionName).toBe("allocate");
    expect(decoded.args).toEqual([[0n, 3n], [parseUnits("1000", 6), parseUnits("300", 6)]]);
  });

  it("uses a fixed sentinel for an external scheduled transfer", () => {
    const call = client.proposeScheduledTransfer(treasury, { sourceVaultId: 2, recipient: mamie, amount: "300", intervalSeconds: 604800, firstExecutionAt: 1_800_000_000 });
    const decoded = decodeFunctionData({ abi: parseAbi(["function proposeScheduledTransfer(uint32 sourceVaultId,uint32 destinationVaultId,address recipient,uint128 amount,uint64 interval,uint64 firstExecutionAt)"]), data: call.callData });
    expect(decoded.args).toEqual([2, EXTERNAL_RECIPIENT, mamie, parseUnits("300", 6), 604800n, 1800000000n]);
  });
});
