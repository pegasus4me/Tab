import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createWalletClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseEther, parseUnits, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { infrastructure } from "./config/infrastructure.js";
import { ActivityEscrowClient } from "./services/chain/activity-escrow-client.js";
import { PostgresActivityStore } from "./services/postgres-activity-store.js";
import { runActivities } from "./services/activity-runner.js";

const participantKey = process.env.COUNT_ME_IN_RELAYER_PRIVATE_KEY ?? process.env.OURS_RELAYER_PRIVATE_KEY;
const databaseUrl = process.env.SUPABASE_DATABASE_URL;
const indexerUrl = process.env.ENVIO_INDEXER_ENDPOINT;
if (!participantKey || !/^0x[a-fA-F0-9]{64}$/.test(participantKey)) throw new Error("Set COUNT_ME_IN_RELAYER_PRIVATE_KEY for the E2E test.");
if (!databaseUrl) throw new Error("Set SUPABASE_DATABASE_URL for the E2E test.");
if (!infrastructure.activityFactoryAddress) throw new Error("The activity factory is not configured.");

const organizer = privateKeyToAccount(participantKey as `0x${string}`);
const guestKey = process.env.E2E_GUEST_PRIVATE_KEY;
const guest = guestKey && /^0x[a-fA-F0-9]{64}$/.test(guestKey)
  ? privateKeyToAccount(guestKey as `0x${string}`)
  : privateKeyToAccount(generatePrivateKey());
const organizerWallet = createWalletClient({ account: organizer, chain: infrastructure.chain, transport: http(infrastructure.rpcUrl) });
const guestWallet = createWalletClient({ account: guest, chain: infrastructure.chain, transport: http(infrastructure.rpcUrl) });
const store = new PostgresActivityStore(databaseUrl);
const chain = new ActivityEscrowClient();
const contribution = "0.01";
const erc20 = parseAbi(["function transfer(address to,uint256 value) returns (bool)"]);

async function send(wallet: typeof organizerWallet, to: string, data: `0x${string}`, value = 0n, gas = 300_000n) {
  // Monad Testnet occasionally underestimates the intrinsic cost of a transfer
  // to a freshly generated EOA; use a conservative cap for this test-only flow.
  const hash = await wallet.sendTransaction({ to: getAddress(to), data, value, gas });
  const receipt = await chain.waitReceipt(hash);
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return hash;
}
async function indexed(escrowAddress: string) {
  if (!indexerUrl) throw new Error("Set ENVIO_INDEXER_ENDPOINT for the E2E test.");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(indexerUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "query ($id: String!) { IndexedActivity_by_pk(id: $id) { id status participantCount totalAmount } }", variables: { id: escrowAddress.toLowerCase() } }) });
    const payload = await response.json() as { data?: { IndexedActivity_by_pk?: { status?: string } } };
    if (payload.data?.IndexedActivity_by_pk?.status === "funded") return payload.data.IndexedActivity_by_pk;
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new Error("Envio did not index the funded activity within 60 seconds.");
}

const now = Date.now();
const fundingDeadline = new Date(now + 60 * 60 * 1_000).toISOString();
const startsAt = new Date(now + 2 * 60 * 60 * 1_000).toISOString();
const id = randomUUID();
const canonicalTerms = { recipientAddress: organizer.address, contribution, capacity: 2, fundingDeadline, startsAt, replacementCutoff: startsAt };
const termsHash = keccak256(toBytes(JSON.stringify(canonicalTerms)));
const activity = await store.create({
  id, organizerUserId: "e2e-test", organizerName: "E2E Organizer", organizerAddress: organizer.address,
  title: "E2E Tennis Tuesday", location: "Court 1, Paris", description: "Direct USDC testnet activity.",
  startsAt, fundingDeadline, replacementCutoff: startsAt, capacity: 2, contribution, currency: "EUR",
  recipientName: "E2E Organizer", recipientAddress: organizer.address, termsHash,
});

const deployment = chain.createActivity(infrastructure.activityFactoryAddress, id, {
  recipient: organizer.address, contribution, capacity: 2,
  fundingDeadline: Math.floor(new Date(fundingDeadline).getTime() / 1_000), activityStart: Math.floor(new Date(startsAt).getTime() / 1_000), replacementCutoff: Math.floor(new Date(startsAt).getTime() / 1_000), termsHash,
});
const deploymentHash = await send(organizerWallet, deployment.contractAddress, deployment.callData, 0n, 1_500_000n);
const escrowAddress = await chain.escrowForActivity(infrastructure.activityFactoryAddress, id);
if (!escrowAddress) throw new Error("Factory did not register the E2E escrow.");
await store.confirmDeployment(activity.id, escrowAddress, deploymentHash);

if (!guestKey) {
  await send(organizerWallet, guest.address, "0x", parseEther("0.02"), 1_500_000n);
}
await send(organizerWallet, infrastructure.usdcAddress, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [guest.address, parseUnits(contribution, 6)] }));
for (const wallet of [organizerWallet, guestWallet]) {
  const approve = chain.approveContribution(escrowAddress, contribution);
  await send(wallet, approve.contractAddress, approve.callData);
  const join = chain.join(escrowAddress);
  await send(wallet, join.contractAddress, join.callData);
}

// Keep this E2E isolated from earlier test records in the shared Supabase
// project; production still reconciles every activity through activities:run.
const e2eStore = {
  all: async () => {
    const record = await store.get(activity.id);
    return record ? [record] : [];
  },
  syncChainState: store.syncChainState.bind(store),
};
const results = await runActivities(e2eStore, chain, organizer.address, call => send(organizerWallet, call.contractAddress, call.callData));
const persisted = await store.get(activity.id);
if (persisted?.status !== "funded" || persisted.confirmedCount !== 2) throw new Error("Supabase did not persist the funded activity state.");
const envio = await indexed(escrowAddress);
console.log(JSON.stringify({ ok: true, activity: { id: persisted.id, title: persisted.title, location: persisted.location, fundingDeadline: persisted.fundingDeadline, startsAt: persisted.startsAt, status: persisted.status, confirmedCount: persisted.confirmedCount, escrowAddress }, runner: results, envio }, null, 2));
