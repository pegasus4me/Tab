import { decodeFunctionData, parseAbi, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { ActivityEscrowClient } from "./activity-escrow-client.js";

describe("ActivityEscrowClient calldata", () => {
  const client = new ActivityEscrowClient();
  const factory = "0x0000000000000000000000000000000000000010";
  const recipient = "0x0000000000000000000000000000000000000020";
  it("encodes immutable activity terms", () => {
    const termsHash = `0x${"ab".repeat(32)}` as `0x${string}`;
    const call = client.createActivity(factory, "activity-id", { recipient, contribution: "12.50", capacity: 10, fundingDeadline: 1000, activityStart: 2000, replacementCutoff: 1900, termsHash });
    const decoded = decodeFunctionData({ abi: parseAbi(["function createActivity(bytes32,address,uint256,uint256,uint64,uint64,uint64,bytes32)"]), data: call.callData });
    expect(decoded.args?.[1]).toBe(recipient);
    expect(decoded.args?.[2]).toBe(parseUnits("12.50", 6));
    expect(decoded.args?.[3]).toBe(10n);
    expect(decoded.args?.[7]).toBe(termsHash);
  });
  it("prepares approval and join separately", () => {
    const escrow = "0x0000000000000000000000000000000000000030";
    expect(decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: client.approveContribution(escrow, "12.50").callData }).args).toEqual([escrow, parseUnits("12.50", 6)]);
    expect(decodeFunctionData({ abi: parseAbi(["function join()"]), data: client.join(escrow).callData }).functionName).toBe("join");
  });
  it("encodes a signed atomic replacement", () => {
    const escrow = "0x0000000000000000000000000000000000000030";
    const signature = `0x${"11".repeat(65)}` as `0x${string}`;
    const call = client.replace(escrow, 4, 2_000, 3, recipient, signature);
    const decoded = decodeFunctionData({ abi: parseAbi(["function replace(uint256,uint256,uint256,address,bytes)"]), data: call.callData });
    expect(decoded.args).toEqual([4n, 2_000n, 3n, recipient, signature]);
    const typedData = client.replacementTypedData(escrow, 4, recipient, "12.50", 2_000, 3);
    expect(typedData.message.price).toBe(parseUnits("12.50", 6));
    expect(typedData.domain.chainId).toBe(10_143);
  });
});
