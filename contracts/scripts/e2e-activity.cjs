require("dotenv").config();

const { randomUUID } = require("node:crypto");
const { Contract, JsonRpcProvider, Wallet, formatUnits, id, parseUnits, zeroAddress } = require("ethers");

const rpcUrl = process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz";
const factoryAddress = process.env.COUNT_ME_IN_FACTORY_ADDRESS || "0x5fF998765AC633C40AD904085Df5903244f70789";
const usdcAddress = process.env.USDC_ADDRESS_TESTNET || "0x534b2f3A21130d7a60830c2Df862319e593943A3";
const participantKey = process.env.E2E_PARTICIPANT_PRIVATE_KEY;
const envioUrl = process.env.ENVIO_GRAPHQL_URL;
const contribution = parseUnits("0.01", 6);

const factoryAbi = [
  "function createActivity(bytes32,address,uint256,uint256,uint64,uint64,uint64,bytes32) returns (address)",
  "function escrowForActivity(bytes32) view returns (address)",
];
const usdcAbi = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];
const escrowAbi = ["function join() returns (uint256)", "function settle()", "function state() view returns (uint8)", "function placeCount() view returns (uint256)"];

function fail(message) { throw new Error(`E2E preflight failed: ${message}`); }
async function receipt(transaction) {
  const result = await transaction.wait();
  if (result.status !== 1) throw new Error(`Transaction reverted: ${transaction.hash}`);
  return result;
}
async function queryEnvio(escrow) {
  if (!envioUrl) return { skipped: "ENVIO_GRAPHQL_URL is not configured." };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(envioUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query ($id: String!) { IndexedActivity_by_pk(id: $id) { id status participantCount totalAmount } }", variables: { id: escrow.toLowerCase() } }) });
    const payload = await response.json();
    if (payload.data?.IndexedActivity_by_pk?.status === "funded") return payload.data.IndexedActivity_by_pk;
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  throw new Error("Envio did not index the funded activity within 60 seconds.");
}

async function main() {
  if (!participantKey || !/^0x[0-9a-fA-F]{64}$/.test(participantKey)) fail("set E2E_PARTICIPANT_PRIVATE_KEY to a dedicated test wallet.");
  const provider = new JsonRpcProvider(rpcUrl);
  const participant = new Wallet(participantKey, provider);
  const usdc = new Contract(usdcAddress, usdcAbi, participant);
  const [mon, balance] = await Promise.all([provider.getBalance(participant.address), usdc.balanceOf(participant.address)]);
  if (mon === 0n) fail("the dedicated wallet needs MON for gas.");
  if (balance < contribution) fail(`the dedicated wallet needs at least ${formatUnits(contribution, 6)} test USDC from the Circle Faucet.`);

  const factory = new Contract(factoryAddress, factoryAbi, participant);
  const now = Math.floor(Date.now() / 1000);
  const activityId = randomUUID();
  const activityKey = id(`count-me-in:activity:${activityId}`);
  const termsHash = id(`count-me-in:e2e:${activityId}`);
  const creationReceipt = await receipt(await factory.createActivity(activityKey, participant.address, contribution, 1, now + 3_600, now + 7_200, now + 7_200, termsHash));
  const escrowAddress = await factory.escrowForActivity(activityKey);
  if (escrowAddress === zeroAddress) throw new Error("Factory did not register the escrow.");

  await receipt(await usdc.approve(escrowAddress, contribution));
  const escrow = new Contract(escrowAddress, escrowAbi, participant);
  await receipt(await escrow.join());
  if (await escrow.state() !== 1n || await escrow.placeCount() !== 1n) throw new Error("Escrow did not enter Ready after the direct USDC contribution.");
  await receipt(await escrow.settle());
  if (await escrow.state() !== 2n) throw new Error("Escrow did not settle.");
  const indexed = await queryEnvio(escrowAddress);
  console.log(JSON.stringify({ ok: true, activityId, escrowAddress, creationTransaction: creationReceipt.hash, indexed }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
