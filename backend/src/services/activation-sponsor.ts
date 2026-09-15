import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { createPublicClient, createWalletClient, getAddress, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { infrastructure } from "../config/infrastructure.js";
import { JsonStore } from "./storage/json-store.js";

type Grant = { id: string; amount: string; hash?: `0x${string}`; status: "reserved" | "sent" | "confirmed" };
export function activationCredit(balance: bigint, gasPrice: bigint) {
  const target = gasPrice * 5_000_000n;
  if (target > parseEther("1")) throw new Error("Account setup is temporarily busy. Please try again later.");
  return balance < target ? target - balance : 0n;
}

/** Development-only, one-time fee credit. Never loads a key or sends funds on mainnet. */
export class ActivationSponsor {
  private queue: Promise<unknown> = Promise.resolve();
  private grants: JsonStore<Grant>;
  constructor(path: string) { this.grants = new JsonStore(path); }
  ensure(address: string) {
    const run = this.queue.then(() => this.fund(address));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async fund(address: string) {
    if (infrastructure.networkName !== "monad-testnet") return;
    const rpc = createPublicClient({ chain: infrastructure.chain, transport: http(infrastructure.rpcUrl) });
    const recipient = getAddress(address);
    const [balance, gasPrice] = await Promise.all([rpc.getBalance({ address: recipient }), rpc.getGasPrice()]);
    const value = activationCredit(balance, gasPrice);
    if (!value) return;
    const existing = this.grants.get(recipient.toLowerCase());
    if (existing?.hash) {
      const receipt = await rpc.waitForTransactionReceipt({ hash: existing.hash, timeout: 60000 });
      if (receipt.status === "success") { this.grants.put({ ...existing, status: "confirmed" }); return; }
      throw new Error("Account setup needs support. Your money has not been charged.");
    }
    if (existing) throw new Error("Account setup is still being checked. Please try again shortly.");
    const keyFile = process.env.OURS_TESTNET_SPONSOR_ENV_FILE;
    const key = process.env.OURS_TESTNET_SPONSOR_PRIVATE_KEY || (keyFile ? parse(readFileSync(keyFile)).DEPLOYER_PRIVATE_KEY : undefined);
    if (!key || !/^0x[a-fA-F0-9]{64}$/.test(key)) throw new Error("Account setup is temporarily unavailable. Ours needs to enable its setup fee coverage.");
    const spent = this.grants.all().reduce((sum, grant) => sum + BigInt(grant.amount), 0n);
    if (spent + value > parseEther("5")) throw new Error("Account setup is temporarily unavailable. Please contact support.");
    const account = privateKeyToAccount(key as `0x${string}`);
    if (await rpc.getBalance({ address: account.address }) < value + gasPrice * 21000n) throw new Error("Account setup is temporarily unavailable. Please contact support.");
    const grant: Grant = { id: recipient.toLowerCase(), amount: String(value), status: "reserved" };
    this.grants.put(grant);
    const wallet = createWalletClient({ account, chain: infrastructure.chain, transport: http(infrastructure.rpcUrl) });
    const hash = await wallet.sendTransaction({ to: recipient, value });
    this.grants.put({ ...grant, hash, status: "sent" });
    const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 60000 });
    if (receipt.status !== "success") throw new Error("Account setup needs support. Please try again later.");
    this.grants.put({ ...grant, hash, status: "confirmed" });
  }
}
