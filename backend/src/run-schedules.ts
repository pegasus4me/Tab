import "dotenv/config";
import { join } from "node:path";
import { createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { infrastructure } from "./config/infrastructure.js";
import { FamilyStore } from "./services/family-store.js";
import { FamilyTreasuryClient } from "./services/chain/family-treasury-client.js";
import { runDueSchedules } from "./services/schedule-runner.js";

// Dedicated fee-paying relayer: it must not be a parent or hold family funds.
const key = process.env.OURS_RELAYER_PRIVATE_KEY;
if (!key || !/^0x[a-fA-F0-9]{64}$/.test(key)) throw new Error("Set OURS_RELAYER_PRIVATE_KEY for the payment runner.");
const account = privateKeyToAccount(key as `0x${string}`);
const wallet = createWalletClient({ account, chain: infrastructure.chain, transport: http(infrastructure.rpcUrl) });
const chain = new FamilyTreasuryClient();
const dataDir = process.env.OURS_DATA_DIR || new URL("../.data/", import.meta.url).pathname;
const families = new FamilyStore(join(dataDir, `${infrastructure.networkName}-families.json`));
const addresses: string[] = [];
for (const family of families.all()) {
  const address = family.treasuryAddress ?? (infrastructure.factoryAddress ? await chain.treasuryForFamily(infrastructure.factoryAddress, family.id) : undefined);
  if (address) addresses.push(address);
}
const results = await runDueSchedules(addresses, chain, account.address, async call => {
  const hash = await wallet.sendTransaction({ to: getAddress(call.contractAddress), data: call.callData });
  const receipt = await chain.waitReceipt(hash);
  if (receipt.status !== "success") throw new Error("Scheduled payment failed.");
  return hash;
});
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }));
if (results.some(result => result.error)) process.exitCode = 1;
