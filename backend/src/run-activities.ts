import "dotenv/config";
import { join } from "node:path";
import { createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { infrastructure } from "./config/infrastructure.js";
import { ActivityStore } from "./services/activity-store.js";
import { SupabaseActivityStore } from "./services/supabase-activity-store.js";
import { PostgresActivityStore } from "./services/postgres-activity-store.js";
import { runActivities } from "./services/activity-runner.js";
import { ActivityEscrowClient } from "./services/chain/activity-escrow-client.js";

const key = process.env.COUNT_ME_IN_RELAYER_PRIVATE_KEY ?? process.env.OURS_RELAYER_PRIVATE_KEY;
if (!key || !/^0x[a-fA-F0-9]{64}$/.test(key)) {
  throw new Error("Set COUNT_ME_IN_RELAYER_PRIVATE_KEY for the activity runner.");
}

const account = privateKeyToAccount(key as `0x${string}`);
const wallet = createWalletClient({ account, chain: infrastructure.chain, transport: http(infrastructure.rpcUrl) });
const chain = new ActivityEscrowClient();
const dataDir = process.env.OURS_DATA_DIR || new URL("../.data/", import.meta.url).pathname;
const activities = process.env.SUPABASE_DATABASE_URL
  ? new PostgresActivityStore(process.env.SUPABASE_DATABASE_URL)
  : process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseActivityStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : new ActivityStore(join(dataDir, `${infrastructure.networkName}-activities.json`));

const results = await runActivities(activities, chain, account.address, async call => {
  const hash = await wallet.sendTransaction({ to: getAddress(call.contractAddress), data: call.callData });
  const receipt = await chain.waitReceipt(hash);
  if (receipt.status !== "success") throw new Error("Activity lifecycle transaction failed.");
  return hash;
});

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }));
if (results.some(result => result.error)) process.exitCode = 1;
