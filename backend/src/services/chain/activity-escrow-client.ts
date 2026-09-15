import { createPublicClient, encodeFunctionData, formatUnits, getAddress, http, keccak256, parseAbi, parseUnits, toBytes, zeroAddress } from "viem";
import { infrastructure } from "../../config/infrastructure.js";
import type { ContractCall } from "./contract-call.js";

const factoryAbi = parseAbi([
  "function escrowForActivity(bytes32) view returns (address)",
  "function createActivity(bytes32 activityId,address recipient,uint256 contribution,uint256 capacity,uint64 fundingDeadline,uint64 activityStart,uint64 replacementCutoff,bytes32 termsHash) returns (address)",
]);
const escrowAbi = parseAbi([
  "function organizer() view returns (address)", "function recipient() view returns (address)",
  "function contribution() view returns (uint256)", "function capacity() view returns (uint256)",
  "function fundingDeadline() view returns (uint64)", "function activityStart() view returns (uint64)",
  "function replacementCutoff() view returns (uint64)", "function termsHash() view returns (bytes32)",
  "function state() view returns (uint8)", "function placeCount() view returns (uint256)",
  "function hasActivePlace(address) view returns (bool)", "function places(uint256) view returns (address owner,uint64 offerNonce,bool refunded)",
  "function join() returns (uint256)", "function settle()", "function expire()", "function cancel()", "function refund(uint256 placeId)",
  "function replace(uint256 placeId,uint256 expiry,uint256 nonce,address designatedBuyer,bytes signature)",
  "function invalidateOffer(uint256 placeId)",
]);
const erc20Abi = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);

export type ActivityTerms = { recipient: string; contribution: string; capacity: number; fundingDeadline: number; activityStart: number; replacementCutoff: number; termsHash: `0x${string}` };
const stateNames = ["collecting", "ready", "funded", "failed", "cancelled"] as const;

export class ActivityEscrowClient {
  private readonly client = createPublicClient({ chain: infrastructure.chain, transport: http(infrastructure.rpcUrl) });
  activityKey(activityId: string) { return keccak256(toBytes(`count-me-in:activity:${activityId}`)); }
  createActivity(factoryAddress: string, activityId: string, terms: ActivityTerms): ContractCall {
    return this.call(factoryAddress, factoryAbi, "createActivity", [this.activityKey(activityId), getAddress(terms.recipient), parseUnits(terms.contribution, 6), BigInt(terms.capacity), BigInt(terms.fundingDeadline), BigInt(terms.activityStart), BigInt(terms.replacementCutoff), terms.termsHash]);
  }
  async escrowForActivity(factoryAddress: string, activityId: string) {
    const value = await this.client.readContract({ address: getAddress(factoryAddress), abi: factoryAbi, functionName: "escrowForActivity", args: [this.activityKey(activityId)] });
    return value === "0x0000000000000000000000000000000000000000" ? undefined : getAddress(value);
  }
  approveContribution(escrowAddress: string, amount: string): ContractCall { return this.call(infrastructure.usdcAddress, erc20Abi, "approve", [getAddress(escrowAddress), parseUnits(amount, 6)]); }
  join(escrowAddress: string): ContractCall { return this.call(escrowAddress, escrowAbi, "join", []); }
  settle(escrowAddress: string): ContractCall { return this.call(escrowAddress, escrowAbi, "settle", []); }
  expire(escrowAddress: string): ContractCall { return this.call(escrowAddress, escrowAbi, "expire", []); }
  cancel(escrowAddress: string): ContractCall { return this.call(escrowAddress, escrowAbi, "cancel", []); }
  refund(escrowAddress: string, placeId: number): ContractCall { return this.call(escrowAddress, escrowAbi, "refund", [BigInt(placeId)]); }
  replace(escrowAddress: string, placeId: number, expiry: number, nonce: number, designatedBuyer: string | undefined, signature: `0x${string}`): ContractCall {
    return this.call(escrowAddress, escrowAbi, "replace", [BigInt(placeId), BigInt(expiry), BigInt(nonce), designatedBuyer ? getAddress(designatedBuyer) : zeroAddress, signature]);
  }
  invalidateOffer(escrowAddress: string, placeId: number): ContractCall { return this.call(escrowAddress, escrowAbi, "invalidateOffer", [BigInt(placeId)]); }
  replacementTypedData(escrowAddress: string, placeId: number, owner: string, price: string, expiry: number, nonce: number, designatedBuyer?: string) {
    return {
      domain: { name: "Count Me In Activity", version: "1", chainId: infrastructure.chain.id, verifyingContract: getAddress(escrowAddress) },
      primaryType: "ReplacementOffer" as const,
      types: { ReplacementOffer: [
        { name: "placeId", type: "uint256" }, { name: "owner", type: "address" },
        { name: "price", type: "uint256" }, { name: "expiry", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "designatedBuyer", type: "address" },
      ] },
      message: { placeId: BigInt(placeId), owner: getAddress(owner), price: parseUnits(price, 6), expiry: BigInt(expiry), nonce: BigInt(nonce), designatedBuyer: designatedBuyer ? getAddress(designatedBuyer) : zeroAddress },
    };
  }
  async hasActivePlace(escrowAddress: string, account: string) { return this.client.readContract({ address: getAddress(escrowAddress), abi: escrowAbi, functionName: "hasActivePlace", args: [getAddress(account)] }); }
  async placeForOwner(escrowAddress: string, owner: string) {
    const address = getAddress(escrowAddress); const expected = getAddress(owner);
    const count = Number(await this.client.readContract({ address, abi: escrowAbi, functionName: "placeCount" }));
    for (let placeId = 0; placeId < count; placeId += 1) {
      const place = await this.client.readContract({ address, abi: escrowAbi, functionName: "places", args: [BigInt(placeId)] });
      if (place[0].toLowerCase() === expected.toLowerCase() && !place[2]) return { placeId, owner: place[0], offerNonce: Number(place[1]), refunded: place[2] };
    }
    return undefined;
  }
  async place(escrowAddress: string, placeId: number) {
    const value = await this.client.readContract({ address: getAddress(escrowAddress), abi: escrowAbi, functionName: "places", args: [BigInt(placeId)] });
    return { placeId, owner: value[0], offerNonce: Number(value[1]), refunded: value[2] };
  }
  async summary(escrowAddress: string) {
    const address = getAddress(escrowAddress);
    // Monad Testnet limits this public RPC to 15 requests/second. The runner
    // may reconcile several escrows at once, so avoid the burst from Promise.all.
    const read = async (functionName: any) => {
      const value = await this.client.readContract({ address, abi: escrowAbi, functionName });
      await new Promise(resolve => setTimeout(resolve, 80));
      return value;
    };
    const organizer = await read("organizer");
    const recipient = await read("recipient");
    const contribution = await read("contribution");
    const capacity = await read("capacity");
    const fundingDeadline = await read("fundingDeadline");
    const activityStart = await read("activityStart");
    const replacementCutoff = await read("replacementCutoff");
    const termsHash = await read("termsHash");
    const state = await read("state");
    const placeCount = await read("placeCount");
    return { address, organizer: organizer as string, recipient: recipient as string, contribution: formatUnits(contribution as bigint, 6), capacity: Number(capacity), fundingDeadline: Number(fundingDeadline), activityStart: Number(activityStart), replacementCutoff: Number(replacementCutoff), termsHash: termsHash as string, state: stateNames[Number(state)], placeCount: Number(placeCount) };
  }
  async transaction(hash: `0x${string}`) { return this.client.getTransaction({ hash }); }
  async waitReceipt(hash: `0x${string}`) { return this.client.waitForTransactionReceipt({ hash, timeout: 60000 }); }
  async simulate(call: ContractCall, account: string) { return this.client.call({ to: call.contractAddress, data: call.callData, account: getAddress(account) }); }
  private call(address: string, abi: readonly unknown[], functionName: string, args: readonly unknown[]): ContractCall { return { contractAddress: getAddress(address), callData: encodeFunctionData({ abi, functionName, args } as never) }; }
}
