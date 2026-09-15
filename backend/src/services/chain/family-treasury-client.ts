import {
  createPublicClient, encodeFunctionData, formatUnits, getAddress, http, keccak256,
  parseAbi, parseUnits, toBytes, type Address,
} from "viem";
import { infrastructure } from "../../config/infrastructure.js";
import type { ContractCall } from "./contract-call.js";

const treasuryAbi = parseAbi([
  "function createVault((string name,uint128 floor,uint8 withdrawalApprovalsRequired) config)",
  "function addOwner(address account)",
  "function parents() view returns (address[])",
  "function vaultCount() view returns (uint256)",
  "function vault(uint256) view returns (string name,uint128 balance,uint128 floor,uint8 withdrawalApprovalsRequired)",
  "function unallocatedBalance() view returns (uint256)",
  "function withdrawalCount() view returns (uint256)",
  "function withdrawal(uint256) view returns (uint32 vaultId,address recipient,uint128 amount,uint8 approvals,bool executed)",
  "function scheduledTransferCount() view returns (uint256)",
  "function scheduledTransfer(uint256) view returns (uint32 sourceVaultId,uint32 destinationVaultId,address recipient,uint128 amount,uint64 interval,uint64 nextExecutionAt,uint8 approvals,bool active)",
  "function deposit(uint256 amount)",
  "function allocate(uint256[] vaultIds,uint128[] amounts)",
  "function proposeWithdrawal(uint32 vaultId,address recipient,uint128 amount) returns (uint256)",
  "function approveWithdrawal(uint256 proposalId)",
  "function proposeScheduledTransfer(uint32 sourceVaultId,uint32 destinationVaultId,address recipient,uint128 amount,uint64 interval,uint64 firstExecutionAt) returns (uint256)",
  "function approveScheduledTransfer(uint256 scheduleId)",
  "function executeScheduledTransfer(uint256 scheduleId)",
]);
const factoryAbi = parseAbi([
  "function treasuryForFamily(bytes32) view returns (address)",
  "function createFamily(bytes32 familyId,address[] parents,(string name,uint128 floor,uint8 withdrawalApprovalsRequired)[] initialVaults) returns (address)",
]);
const erc20Abi = parseAbi(["function approve(address spender,uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

export const EXTERNAL_RECIPIENT = 4_294_967_295;
export type VaultSetup = { name: string; floor: string; withdrawalApprovalsRequired: number };

export class FamilyTreasuryClient {
  private readonly client = createPublicClient({ chain: infrastructure.chain, transport: http(infrastructure.rpcUrl) });

  familyKey(familyId: string) { return keccak256(toBytes(`ours:family:${familyId}`)); }
  async treasuryForFamily(factoryAddress: string, familyId: string) {
    const address = await this.client.readContract({ address: getAddress(factoryAddress), abi: factoryAbi, functionName: "treasuryForFamily", args: [this.familyKey(familyId)] });
    return address === "0x0000000000000000000000000000000000000000" ? undefined : getAddress(address);
  }
  createFamily(factoryAddress: string, familyId: string, parents: string[], vaults: VaultSetup[]): ContractCall {
    return this.call(getAddress(factoryAddress), factoryAbi, "createFamily", [
      this.familyKey(familyId), parents.map(getAddress), vaults.map((vault) => ({ name: vault.name, floor: parseUnits(vault.floor, 6), withdrawalApprovalsRequired: vault.withdrawalApprovalsRequired })),
    ]);
  }
  createVault(treasuryAddress: string, config: VaultSetup): ContractCall {
    return this.call(getAddress(treasuryAddress), treasuryAbi, "createVault", [{ name: config.name, floor: parseUnits(config.floor, 6), withdrawalApprovalsRequired: config.withdrawalApprovalsRequired }]);
  }
  addOwner(treasuryAddress: string, account: string): ContractCall { return this.call(getAddress(treasuryAddress), treasuryAbi, "addOwner", [getAddress(account)]); }
  async walletBalance(address: string) {
    return formatUnits(await this.client.readContract({ address: infrastructure.usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(address)] }), 6);
  }
  async transaction(hash: `0x${string}`) { return this.client.getTransaction({ hash }); }
  async receipt(hash: `0x${string}`) { return this.client.getTransactionReceipt({ hash }); }
  async waitReceipt(hash: `0x${string}`) { return this.client.waitForTransactionReceipt({ hash, timeout: 60000 }); }
  approveDeposit(treasuryAddress: string, amount: string): ContractCall {
    return this.call(infrastructure.usdcAddress, erc20Abi, "approve", [getAddress(treasuryAddress), parseUnits(amount, 6)]);
  }
  deposit(treasuryAddress: string, amount: string): ContractCall { return this.call(getAddress(treasuryAddress), treasuryAbi, "deposit", [parseUnits(amount, 6)]); }
  allocate(treasuryAddress: string, allocations: { vaultId: number; amount: string }[]): ContractCall {
    return this.call(getAddress(treasuryAddress), treasuryAbi, "allocate", [allocations.map((item) => BigInt(item.vaultId)), allocations.map((item) => parseUnits(item.amount, 6))]);
  }
  proposeWithdrawal(treasuryAddress: string, vaultId: number, recipient: string, amount: string): ContractCall { return this.call(getAddress(treasuryAddress), treasuryAbi, "proposeWithdrawal", [BigInt(vaultId), getAddress(recipient), parseUnits(amount, 6)]); }
  approveWithdrawal(treasuryAddress: string, proposalId: number): ContractCall { return this.call(getAddress(treasuryAddress), treasuryAbi, "approveWithdrawal", [BigInt(proposalId)]); }
  proposeScheduledTransfer(treasuryAddress: string, input: { sourceVaultId: number; destinationVaultId?: number; recipient?: string; amount: string; intervalSeconds: number; firstExecutionAt: number }): ContractCall {
    const external = input.recipient !== undefined;
    return this.call(getAddress(treasuryAddress), treasuryAbi, "proposeScheduledTransfer", [BigInt(input.sourceVaultId), BigInt(external ? EXTERNAL_RECIPIENT : input.destinationVaultId!), external ? getAddress(input.recipient!) : "0x0000000000000000000000000000000000000000", parseUnits(input.amount, 6), BigInt(input.intervalSeconds), BigInt(input.firstExecutionAt)]);
  }
  approveScheduledTransfer(treasuryAddress: string, scheduleId: number): ContractCall { return this.call(getAddress(treasuryAddress), treasuryAbi, "approveScheduledTransfer", [BigInt(scheduleId)]); }
  executeScheduledTransfer(treasuryAddress: string, scheduleId: number): ContractCall { return this.call(getAddress(treasuryAddress), treasuryAbi, "executeScheduledTransfer", [BigInt(scheduleId)]); }
  async summary(treasuryAddress: string) {
    const address = getAddress(treasuryAddress);
    const [parents, unallocated, vaultCount, withdrawalCount, scheduleCount] = await Promise.all([
      this.client.readContract({ address, abi: treasuryAbi, functionName: "parents" }), this.client.readContract({ address, abi: treasuryAbi, functionName: "unallocatedBalance" }), this.client.readContract({ address, abi: treasuryAbi, functionName: "vaultCount" }), this.client.readContract({ address, abi: treasuryAbi, functionName: "withdrawalCount" }), this.client.readContract({ address, abi: treasuryAbi, functionName: "scheduledTransferCount" }),
    ]);
    const vaults = await Promise.all(Array.from({ length: Number(vaultCount) }, async (_, vaultId) => {
      const value = await this.client.readContract({ address, abi: treasuryAbi, functionName: "vault", args: [BigInt(vaultId)] });
      return { id: vaultId, name: value[0], balance: formatUnits(value[1], 6), floor: formatUnits(value[2], 6), withdrawalApprovalsRequired: Number(value[3]) };
    }));
    const withdrawals = await Promise.all(Array.from({ length: Number(withdrawalCount) }, async (_, id) => {
      const value = await this.client.readContract({ address, abi: treasuryAbi, functionName: "withdrawal", args: [BigInt(id)] });
      return { id, vaultId: Number(value[0]), recipient: value[1], amount: formatUnits(value[2], 6), approvals: Number(value[3]), executed: value[4] };
    }));
    const scheduledTransfers = await Promise.all(Array.from({ length: Number(scheduleCount) }, async (_, id) => {
      const value = await this.client.readContract({ address, abi: treasuryAbi, functionName: "scheduledTransfer", args: [BigInt(id)] });
      return { id, sourceVaultId: Number(value[0]), destinationVaultId: Number(value[1]), recipient: value[2], amount: formatUnits(value[3], 6), intervalSeconds: Number(value[4]), nextExecutionAt: Number(value[5]), approvals: Number(value[6]), active: value[7] };
    }));
    return { address, network: infrastructure.networkName, currency: "USDC", parents, unallocatedBalance: formatUnits(unallocated, 6), vaults, withdrawals, scheduledTransfers };
  }
  async recentActivity(treasuryAddress: string) {
    const toBlock = await this.client.getBlockNumber();
    // Monad's public RPC currently caps eth_getLogs at 100 blocks.
    const fromBlock = toBlock > 99n ? toBlock - 99n : 0n;
    const events = parseAbi([
      "event Deposited(address indexed parent,uint256 amount)",
      "event Allocated(uint256 indexed vaultId,uint256 amount)",
      "event WithdrawalExecuted(uint256 indexed proposalId,address indexed recipient,uint256 amount)",
      "event ScheduledTransferExecuted(uint256 indexed scheduleId,uint256 amount,uint256 nextExecutionAt)",
    ]);
    const logs = await this.client.getLogs({ address: getAddress(treasuryAddress), events, fromBlock, toBlock });
    return { fromBlock: String(fromBlock), toBlock: String(toBlock), scope: "Last 100 blocks only; not lifetime history", entries: logs.slice(-100).map(log => ({ event: log.eventName, blockNumber: String(log.blockNumber), transactionHash: log.transactionHash, details: JSON.parse(JSON.stringify(log.args, (_key, value) => typeof value === "bigint" ? String(value) : value)) })) };
  }
  /** Executes an eth_call only; no transaction is broadcast. */
  async simulate(call: ContractCall, account: string) {
    return this.client.call({ to: getAddress(call.contractAddress), data: call.callData, account: getAddress(account) });
  }
  private call(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): ContractCall {
    return { contractAddress: address, callData: encodeFunctionData({ abi, functionName, args } as never) };
  }
}
