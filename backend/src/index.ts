import "dotenv/config";
import { ManagedMembers } from "./services/managed-members.js";
import cors from "cors";
import express, { type Request } from "express";
import { randomUUID } from "node:crypto";
import { getAddress, keccak256, toBytes } from "viem";
import { z } from "zod";
import { infrastructure } from "./config/infrastructure.js";
import { FamilyTreasuryClient } from "./services/chain/family-treasury-client.js";
import type { ContractCall } from "./services/chain/contract-call.js";
import { DynamicAuthService } from "./services/dynamic-auth-service.js";
import { FamilyStore } from "./services/family-store.js";
import { ActivationSponsor } from "./services/activation-sponsor.js";
import { DecisionService } from "./services/cfo/decision-service.js";
import { join } from "node:path";
import { FamilyContextService } from "./services/cfo/family-context-service.js";
import { PlanStore } from "./services/cfo/plan-store.js";
import { PinStore, PostgresPinStore, SupabasePinStore, type PinPersistence } from "./services/pin-store.js";
import { PolicyValidator } from "./services/cfo/policy-validator.js";
import { SimulationService } from "./services/cfo/simulation-service.js";
import { planSchema, type CfoAction } from "./services/cfo/action-schema.js";
import { InvitationEmailService } from "./services/invitation-email.js";
import { MoonPayService } from "./services/moonpay-service.js";
import { FundingStore } from "./services/funding-store.js";
import { ActivityStore } from "./services/activity-store.js";
import { SupabaseActivityStore } from "./services/supabase-activity-store.js";
import { PostgresActivityStore } from "./services/postgres-activity-store.js";
import { ActivityEscrowClient } from "./services/chain/activity-escrow-client.js";

const app = express();
const managedMembers = new ManagedMembers(new URL("../.data/members.json", import.meta.url).pathname);
const auth = new DynamicAuthService(infrastructure.dynamicEnvironmentId);
const chain = new FamilyTreasuryClient();
const dataDir = process.env.OURS_DATA_DIR || new URL("../.data/", import.meta.url).pathname;
const families = new FamilyStore(join(dataDir, `${infrastructure.networkName}-families.json`));
const activationSponsor = new ActivationSponsor(join(dataDir, "testnet-activation-credits.json"));
const invitationEmails = new InvitationEmailService();
const cfo = new DecisionService();
const contexts = new FamilyContextService(chain);
const policies = new PolicyValidator();
const simulations = new SimulationService(chain);
const plans = new PlanStore(join(dataDir, `${infrastructure.networkName}-plans.json`));
const funding = new FundingStore(join(dataDir, `${infrastructure.networkName}-funding.json`));
const activities = process.env.SUPABASE_DATABASE_URL
  ? new PostgresActivityStore(process.env.SUPABASE_DATABASE_URL)
  : process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseActivityStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : new ActivityStore(join(dataDir, `${infrastructure.networkName}-activities.json`));
const activityChain = new ActivityEscrowClient();
const moonPay = new MoonPayService(infrastructure.moonPay);
if (process.env.NODE_ENV === "production" && !process.env.SUPABASE_DATABASE_URL && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for persistent PINs in production.");
}
const pins: PinPersistence = process.env.SUPABASE_DATABASE_URL
  ? new PostgresPinStore(process.env.SUPABASE_DATABASE_URL)
  : process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabasePinStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : new PinStore();
app.use(cors({ origin: process.env.PWA_ORIGIN?.split(",") ?? true, allowedHeaders: ["Authorization", "Content-Type"] }));
app.post("/webhooks/moonpay", express.raw({ type: "application/json", limit: "256kb" }), (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!moonPay.verifyWebhook(req.header("Moonpay-Signature-V2"), body)) return res.status(401).json({ error: "Invalid webhook signature." });
  let payload: Record<string, any>;
  try { payload = JSON.parse(body.toString("utf8")); } catch { return res.status(400).json({ error: "Invalid webhook payload." }); }
  const transaction = payload.data?.transaction ?? payload.data ?? payload.transaction ?? payload;
  const transactionId = transaction.id;
  const intent = typeof transactionId === "string" ? funding.byTransaction(transactionId) : undefined;
  if (!intent) return res.status(202).json({ received: true });
  if (transaction.externalTransactionId !== intent.id) return res.status(400).json({ error: "Funding reference does not match." });
  if (intent.status === "completed") return res.json({ received: true });
  const wallet = transaction.wallet?.address ?? transaction.walletAddress;
  const destinationAmount = transaction.destination?.amount ?? transaction.quoteCurrencyAmount;
  const destinationAsset = transaction.destination?.asset ?? transaction.currency ?? {};
  const destinationCode = destinationAsset.code;
  const destinationContract = destinationAsset.contractAddress;
  const destinationCaip19 = destinationAsset.caip19;
  const sourceAmount = transaction.source?.amount ?? transaction.baseCurrencyAmount;
  const sourceCode = transaction.source?.asset?.code ?? transaction.baseCurrency?.code;
  const expectedChain = `eip155:${infrastructure.chain.id}/`;
  const assetMatches = destinationContract
    ? String(destinationContract).toLowerCase() === infrastructure.usdcAddress.toLowerCase()
    : destinationCaip19
      ? String(destinationCaip19).toLowerCase().startsWith(expectedChain) && String(destinationCaip19).toLowerCase().includes(infrastructure.usdcAddress.toLowerCase())
      : String(destinationCode ?? "").toUpperCase().startsWith("USDC");
  const sourceMatches = (!sourceCode || String(sourceCode).toUpperCase() === intent.sourceCurrency) && (!sourceAmount || Number(sourceAmount) === Number(intent.sourceAmount));
  if (wallet?.toLowerCase() !== intent.treasuryAddress.toLowerCase() || !assetMatches || !sourceMatches) return res.status(400).json({ error: "Funding destination does not match." });
  const status = String(transaction.status ?? "").toLowerCase();
  if (status === "completed" && destinationAmount) funding.update(intent.id, { receivedAmount: String(destinationAmount), status: intent.vaultId === undefined ? "completed" : "allocation_pending" });
  else if (status === "failed") funding.update(intent.id, { status: "failed" });
  else funding.update(intent.id, { status: "payment_pending" });
  return res.json({ received: true });
});
app.use(express.json());

app.get("/payments/moonpay/readiness", async (_req, res, next) => { try {
  const support = await moonPay.settlementAssetSupport(infrastructure.chain.id, infrastructure.usdcAddress);
  res.set("Cache-Control", "no-store").json({ provider: "moonpay", network: infrastructure.networkName, support });
} catch (error) { next(error); } });

const amount = z.string().regex(/^\d+(\.\d{1,6})?$/);
const positiveAmount = amount.refine(value => /[1-9]/.test(value), "Amount must be greater than zero.");
const verifiedWallet = z.object({ walletAddress: z.string() });
const vaultSetup = z.object({ name: z.string().trim().min(1).max(48), floor: amount, withdrawalApprovalsRequired: z.number().int().min(1).max(10) });
const createFamily = verifiedWallet.extend({
  id: z.string().uuid().optional(), name: z.string().trim().min(1).max(64),
  parentAddresses: z.array(z.string()).min(1).max(10), vaults: z.array(vaultSetup).min(1).max(12),
});
const pinInput = z.object({ pin: z.string().regex(/^\d{6}$/, "Your PIN must contain six digits.") });
const cfoChatInput = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2_000) })).min(1).max(20),
  profile: z.object({ familyName: z.string().trim().min(1).max(64), focus: z.string().trim().min(1).max(120) }).optional(),
});
const action = z.union([
  z.object({ type: z.literal("deposit"), amount: positiveAmount }),
  z.object({ type: z.literal("create_vault"), config: vaultSetup }),
  z.object({ type: z.literal("allocate"), allocations: z.array(z.object({ vaultId: z.number().int().nonnegative(), amount })).min(1).max(12) }),
  z.object({ type: z.literal("propose_withdrawal"), vaultId: z.number().int().nonnegative(), recipient: z.string(), amount }),
  z.object({ type: z.literal("approve_withdrawal"), proposalId: z.number().int().nonnegative() }),
  z.object({ type: z.literal("propose_scheduled_transfer"), sourceVaultId: z.number().int().nonnegative(), destinationVaultId: z.number().int().nonnegative().optional(), recipient: z.string().optional(), amount, intervalSeconds: z.number().int().positive(), firstExecutionAt: z.number().int().positive() }).superRefine((value, ctx) => {
    if ((value.destinationVaultId === undefined) === (value.recipient === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choose exactly one destination: a vault or an external recipient." });
  }),
  z.object({ type: z.literal("approve_scheduled_transfer"), scheduleId: z.number().int().nonnegative() }),
  z.object({ type: z.literal("execute_scheduled_transfer"), scheduleId: z.number().int().nonnegative() }),
]);

app.get("/health", (_req, res) => res.json({ ok: true, product: "ours" }));
app.get("/members", async (req, res, next) => { try {
  const identity = await authenticate(req);
  res.set("Cache-Control", "no-store").json({ members: managedMembers.list(identity.userId), access: managedMembers.access(identity.userId) });
} catch (error) { next(error); } });
app.post("/members", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const { username, role } = z.object({ username: z.string().trim().regex(/^[A-Za-z0-9_-]{3,32}$/), role: z.enum(["member", "owner"]).default("member") }).parse(req.body);
  res.status(201).json({ member: managedMembers.create(identity.userId, username, role) });
} catch (error) { next(error); } });
app.post("/members/:id/role", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const { role } = z.object({ role: z.enum(["member", "owner"]) }).parse(req.body);
  res.json({ member: managedMembers.setRole(identity.userId, z.string().uuid().parse(req.params.id), role) });
} catch (error) { next(error); } });
app.post("/members/:id/invitations", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const { email } = z.object({ email: z.string().trim().email() }).parse(req.body);
  const memberId = z.string().uuid().parse(req.params.id);
  const member = managedMembers.get(identity.userId, memberId);
  const token = managedMembers.invite(identity.userId, memberId, email);
  const origin = process.env.OURS_APP_URL ?? process.env.PWA_ORIGIN?.split(",")[0] ?? req.header("Origin");
  let sent = false; let deliveryError: string | undefined;
  if (origin) {
    const invitationUrl = new URL(`/\#invite=${token}`, origin).toString();
    try { sent = (await invitationEmails.send({ to: email, username: member.username, invitationUrl })).sent; }
    catch (error) { deliveryError = error instanceof Error ? error.message : "The email could not be delivered."; }
  }
  res.set("Cache-Control", "no-store").json({ token, sent, deliveryError });
} catch (error) { next(error); } });
app.post("/member-invitations/accept", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const { token } = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.body);
  res.set("Cache-Control", "no-store").json({ member: managedMembers.accept(identity.userId, identity.email, token, identity.evmWallets[0]) });
} catch (error) { next(error); } });

app.post("/families/:familyId/members/:id/owner/prepare", async (req, res, next) => { try {
  const { family, identity } = await familyAccess(req);
  const signer = auth.requireWallet(identity, z.object({ walletAddress: z.string() }).parse(req.body).walletAddress);
  const member = managedMembers.ownerCandidate(identity.userId, z.string().uuid().parse(req.params.id));
  const treasuryAddress = await resolveTreasury(family.id);
  if (!treasuryAddress) return res.status(409).json({ error: "Activate the family treasury first." });
  const summary = await chain.summary(treasuryAddress);
  if (!summary.parents.some(parent => parent.toLowerCase() === signer.toLowerCase())) return res.status(403).json({ error: "Only an Owner can grant Owner access." });
  if (summary.parents.some(parent => parent.toLowerCase() === member.paymentAddress!.toLowerCase())) {
    families.addOwner(family.id, getAddress(member.paymentAddress!));
    return res.json({ member: managedMembers.grantOwner(identity.userId, member.id), transactions: [] });
  }
  const call = chain.addOwner(treasuryAddress, member.paymentAddress!);
  try { await chain.simulate(call, signer); }
  catch { throw new Error("This treasury needs the Owner permissions upgrade before access can be granted."); }
  res.json({ transactions: preparedTransactions([call]) });
} catch (error) { next(error); } });

app.post("/families/:familyId/members/:id/owner/confirm", async (req, res, next) => { try {
  const { family, identity } = await familyAccess(req);
  const member = managedMembers.ownerCandidate(identity.userId, z.string().uuid().parse(req.params.id));
  const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/).parse(req.body.hash) as `0x${string}`;
  const treasuryAddress = await resolveTreasury(family.id);
  if (!treasuryAddress) return res.status(409).json({ error: "Activate the family treasury first." });
  const expected = chain.addOwner(treasuryAddress, member.paymentAddress!);
  const transaction = await chain.transaction(hash);
  auth.requireWallet(identity, transaction.from);
  if (transaction.to?.toLowerCase() !== expected.contractAddress.toLowerCase() || transaction.input !== expected.callData || transaction.value !== 0n) return res.status(400).json({ error: "This approval does not match the selected family member." });
  const receipt = await chain.waitReceipt(hash);
  if (receipt.status !== "success") return res.status(409).json({ error: "Owner access was not granted." });
  families.addOwner(family.id, getAddress(member.paymentAddress!));
  await activationSponsor.ensure(member.paymentAddress!);
  res.json({ member: managedMembers.grantOwner(identity.userId, member.id) });
} catch (error) { next(error); } });
app.get("/infrastructure", (_req, res) => res.json({
  network: infrastructure.networkName, chainId: infrastructure.chain.id,
  usdcAddress: infrastructure.usdcAddress, factoryAddress: infrastructure.factoryAddress ?? null,
  activityFactoryAddress: infrastructure.activityFactoryAddress ?? null,
  envioIndexerConfigured: Boolean(infrastructure.envioIndexerEndpoint),
  dynamicConfigured: Boolean(infrastructure.dynamicEnvironmentId),
}));
app.get("/activities/indexer/health", async (_req, res, next) => { try {
  if (!infrastructure.envioIndexerEndpoint) return res.status(503).json({ error: "Envio indexer is not configured." });
  const response = await fetch(infrastructure.envioIndexerEndpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ __typename }" }), signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return res.status(503).json({ error: "Envio indexer is unavailable." });
  const payload = await response.json() as { data?: { __typename?: string } };
  if (payload.data?.__typename !== "query_root") return res.status(503).json({ error: "Envio indexer returned an invalid GraphQL response." });
  res.set("Cache-Control", "no-store").json({ ok: true, endpoint: infrastructure.envioIndexerEndpoint });
} catch (error) { next(error); } });
app.get("/wallet/config", (_req, res) => {
  if (!infrastructure.dynamicEnvironmentId) return res.status(503).json({ error: "Dynamic is not configured." });
  res.json({ environmentId: infrastructure.dynamicEnvironmentId, chainId: infrastructure.chain.id, network: infrastructure.networkName, evmNetwork: infrastructure.walletNetwork });
});
app.get("/auth/me", async (req, res, next) => { try {
  const identity = await authenticate(req);
  res.json(identity);
} catch (error) { next(error); } });
app.get("/security/pin", async (req, res, next) => { try {
  const identity = await authenticate(req);
  res.json({ configured: await pins.has(identity.userId) });
} catch (error) { next(error); } });
app.put("/security/pin", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const { pin } = pinInput.parse(req.body);
  if (!await pins.set(identity.userId, pin)) return res.status(409).json({ error: "A PIN is already configured." });
  res.status(201).json({ configured: true });
} catch (error) { next(error); } });
app.post("/security/pin/verify", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const { pin } = pinInput.parse(req.body);
  const result = await pins.verify(identity.userId, pin);
  if (!result.ok) return res.status(result.lockedUntil ? 429 : 401).json(result);
  res.json(result);
} catch (error) { next(error); } });

const fundingAmount = z.string().regex(/^\d+(\.\d{1,2})?$/).refine(value => Number(value) >= 20 && Number(value) <= 10_000, "Choose an amount between $20 and $10,000.");

const createActivityInput = z.object({
  walletAddress: z.string(),
  title: z.string().trim().min(2).max(80),
  location: z.string().trim().min(2).max(120),
  startsAt: z.string().datetime(),
  fundingDeadline: z.string().datetime(),
  capacity: z.number().int().min(2).max(100),
  contribution: z.string().regex(/^\d+(\.\d{1,2})?$/).refine(value => Number(value) > 0 && Number(value) <= 10_000),
  recipientName: z.string().trim().min(2).max(120),
  recipientAddress: z.string(),
  replacementCutoff: z.string().datetime().optional(),
  description: z.string().trim().max(280).optional(),
}).superRefine((value, ctx) => {
  if (new Date(value.fundingDeadline) >= new Date(value.startsAt)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The payment deadline must be before the activity starts." });
  if (new Date(value.fundingDeadline) <= new Date()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The payment deadline must be in the future." });
  if (value.replacementCutoff && new Date(value.replacementCutoff) > new Date(value.startsAt)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "The replacement cutoff cannot be after the activity starts." });
});

app.get("/activities/shared/:shareCode", async (req, res, next) => { try {
  const shareCode = z.string().regex(/^[A-Za-z0-9_-]{16}$/).parse(req.params.shareCode);
  const activity = await activities.byShareCode(shareCode);
  if (!activity) return res.status(404).json({ error: "Activity not found." });
  const {
    organizerUserId: _privateOrganizerId, organizerAddress: _privateOrganizerAddress,
    recipientAddress: _privateRecipientAddress, termsHash: _privateTermsHash,
    escrowAddress: _privateEscrowAddress, deploymentTransactionHash: _privateDeploymentHash,
    ...publicActivity
  } = activity;
  const onchain = activity.escrowAddress ? await activityChain.summary(activity.escrowAddress) : null;
  res.set("Cache-Control", "no-store").json({ activity: onchain ? { ...publicActivity, confirmedCount: onchain.placeCount, status: onchain.state } : publicActivity, onchain });
} catch (error) { next(error); } });

app.get("/activities", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const records = await activities.listForOrganizer(identity.userId);
  const hydrated = await Promise.all(records.map(async activity => { if (!activity.escrowAddress) return activity; const onchain = await activityChain.summary(activity.escrowAddress); return { ...activity, confirmedCount: onchain.placeCount, status: onchain.state }; }));
  res.set("Cache-Control", "no-store").json({ activities: hydrated });
} catch (error) { next(error); } });

app.post("/activities", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const input = createActivityInput.parse(req.body);
  if (!infrastructure.activityFactoryAddress) return res.status(503).json({ error: "ActivityEscrowFactory is not deployed for this network." });
  const organizerAddress = auth.requireWallet(identity, input.walletAddress);
  const recipientAddress = getAddress(input.recipientAddress);
  const id = randomUUID();
  const contribution = Number(input.contribution).toFixed(2);
  const replacementCutoff = input.replacementCutoff ?? input.startsAt;
  const canonicalTerms = { recipientAddress, contribution, capacity: input.capacity, fundingDeadline: input.fundingDeadline, startsAt: input.startsAt, replacementCutoff };
  const termsHash = keccak256(toBytes(JSON.stringify(canonicalTerms)));
  const contractTerms = {
    recipient: recipientAddress, contribution, capacity: input.capacity,
    fundingDeadline: Math.floor(new Date(input.fundingDeadline).getTime() / 1000),
    activityStart: Math.floor(new Date(input.startsAt).getTime() / 1000),
    replacementCutoff: Math.floor(new Date(replacementCutoff).getTime() / 1000), termsHash,
  };
  const call = activityChain.createActivity(infrastructure.activityFactoryAddress, id, contractTerms);
  await activityChain.simulate(call, organizerAddress);
  const activity = await activities.create({
    id, title: input.title, location: input.location, startsAt: input.startsAt, fundingDeadline: input.fundingDeadline,
    capacity: input.capacity, contribution, recipientName: input.recipientName, recipientAddress, replacementCutoff,
    description: input.description, termsHash,
    organizerUserId: identity.userId,
    organizerName: identity.email?.split("@")[0] || "L’organisateur",
    organizerAddress,
    currency: "EUR",
  });
  res.status(201).json({ activity, signer: organizerAddress, transactions: preparedTransactions([call]) });
} catch (error) { next(error); } });

app.post("/activities/:activityId/deployment", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity || activity.organizerUserId !== identity.userId) return res.status(404).json({ error: "Activity not found." });
  if (activity.escrowAddress) return res.json({ activity, onchain: await activityChain.summary(activity.escrowAddress) });
  if (!infrastructure.activityFactoryAddress) return res.status(503).json({ error: "ActivityEscrowFactory is not deployed for this network." });
  const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/).parse(req.body.hash) as `0x${string}`;
  const terms = {
    recipient: activity.recipientAddress, contribution: activity.contribution, capacity: activity.capacity,
    fundingDeadline: Math.floor(new Date(activity.fundingDeadline).getTime() / 1000),
    activityStart: Math.floor(new Date(activity.startsAt).getTime() / 1000),
    replacementCutoff: Math.floor(new Date(activity.replacementCutoff).getTime() / 1000), termsHash: activity.termsHash as `0x${string}`,
  };
  const expected = activityChain.createActivity(infrastructure.activityFactoryAddress, activity.id, terms);
  const transaction = await activityChain.transaction(hash);
  auth.requireWallet(identity, transaction.from);
  if (transaction.from.toLowerCase() !== activity.organizerAddress.toLowerCase() || transaction.to?.toLowerCase() !== expected.contractAddress.toLowerCase() || transaction.input !== expected.callData || transaction.value !== 0n) return res.status(400).json({ error: "This transaction does not match the activity deployment." });
  const receipt = await activityChain.waitReceipt(hash);
  if (receipt.status !== "success") return res.status(409).json({ error: "The activity contract deployment failed." });
  const escrowAddress = await activityChain.escrowForActivity(infrastructure.activityFactoryAddress, activity.id);
  if (!escrowAddress) return res.status(409).json({ error: "The activity contract was not found after confirmation." });
  const confirmed = await activities.confirmDeployment(activity.id, escrowAddress, hash);
  res.json({ activity: confirmed, onchain: await activityChain.summary(escrowAddress) });
} catch (error) { next(error); } });

app.post("/activities/:activityId/join/prepare", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity?.escrowAddress) return res.status(409).json({ error: "This activity is not ready for reservations." });
  const participant = auth.requireWallet(identity, verifiedWallet.parse(req.body).walletAddress);
  const onchain = await activityChain.summary(activity.escrowAddress);
  if (onchain.state !== "collecting") return res.status(409).json({ error: "This activity is no longer accepting reservations." });
  if (await activityChain.hasActivePlace(activity.escrowAddress, participant)) return res.status(409).json({ error: "You already have a place in this activity." });
  const calls = [activityChain.approveContribution(activity.escrowAddress, activity.contribution), activityChain.join(activity.escrowAddress)];
  await activityChain.simulate(calls[0], participant);
  res.json({ signer: participant, transactions: preparedTransactions(calls) });
} catch (error) { next(error); } });

app.post("/activities/:activityId/join/confirm", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity?.escrowAddress) return res.status(409).json({ error: "This activity is not ready for reservations." });
  const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/).parse(req.body.hash) as `0x${string}`;
  const expected = activityChain.join(activity.escrowAddress);
  const transaction = await activityChain.transaction(hash);
  auth.requireWallet(identity, transaction.from);
  if (transaction.to?.toLowerCase() !== expected.contractAddress.toLowerCase() || transaction.input !== expected.callData || transaction.value !== 0n) return res.status(400).json({ error: "This transaction does not reserve a place in the selected activity." });
  const receipt = await activityChain.waitReceipt(hash);
  if (receipt.status !== "success") return res.status(409).json({ error: "The place payment failed." });
  const place = await activityChain.placeForOwner(activity.escrowAddress, transaction.from);
  if (!place) return res.status(409).json({ error: "The confirmed place could not be found onchain." });
  res.json({ place, onchain: await activityChain.summary(activity.escrowAddress), transactionHash: hash });
} catch (error) { next(error); } });

const replacementOffer = z.object({
  walletAddress: z.string(),
  placeId: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
  designatedBuyer: z.string().optional(),
});
const signedReplacement = z.object({
  walletAddress: z.string(),
  placeId: z.number().int().nonnegative(),
  expiry: z.number().int().positive(),
  nonce: z.number().int().nonnegative(),
  designatedBuyer: z.string().optional(),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
});

app.post("/activities/:activityId/replacements/offer/prepare", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity?.escrowAddress) return res.status(409).json({ error: "This activity is not active onchain." });
  const input = replacementOffer.parse(req.body);
  const owner = auth.requireWallet(identity, input.walletAddress);
  const place = await activityChain.place(activity.escrowAddress, input.placeId);
  if (place.refunded || place.owner.toLowerCase() !== owner.toLowerCase()) return res.status(403).json({ error: "Only the current place owner can offer it." });
  const expiry = Math.floor(new Date(input.expiresAt).getTime() / 1000);
  const cutoff = Math.floor(new Date(activity.replacementCutoff).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now || expiry > cutoff) return res.status(400).json({ error: "The offer must expire before the replacement cutoff." });
  const designatedBuyer = input.designatedBuyer ? getAddress(input.designatedBuyer) : undefined;
  res.json({ place, expiry, nonce: place.offerNonce, typedData: activityChain.replacementTypedData(activity.escrowAddress, place.placeId, owner, activity.contribution, expiry, place.offerNonce, designatedBuyer) });
} catch (error) { next(error); } });

app.post("/activities/:activityId/replacements/accept/prepare", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity?.escrowAddress) return res.status(409).json({ error: "This activity is not active onchain." });
  const input = signedReplacement.parse(req.body);
  const buyer = auth.requireWallet(identity, input.walletAddress);
  const designatedBuyer = input.designatedBuyer ? getAddress(input.designatedBuyer) : undefined;
  if (designatedBuyer && designatedBuyer.toLowerCase() !== buyer.toLowerCase()) return res.status(403).json({ error: "This replacement offer is reserved for another person." });
  const place = await activityChain.place(activity.escrowAddress, input.placeId);
  if (place.refunded || place.offerNonce !== input.nonce) return res.status(409).json({ error: "This replacement offer is no longer valid." });
  if (await activityChain.hasActivePlace(activity.escrowAddress, buyer)) return res.status(409).json({ error: "You already have a place in this activity." });
  const calls = [
    activityChain.approveContribution(activity.escrowAddress, activity.contribution),
    activityChain.replace(activity.escrowAddress, input.placeId, input.expiry, input.nonce, designatedBuyer, input.signature as `0x${string}`),
  ];
  await activityChain.simulate(calls[0], buyer);
  res.json({ signer: buyer, seller: place.owner, transactions: preparedTransactions(calls) });
} catch (error) { next(error); } });

app.post("/activities/:activityId/replacements/accept/confirm", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity?.escrowAddress) return res.status(409).json({ error: "This activity is not active onchain." });
  const input = signedReplacement.extend({ hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }).parse(req.body);
  const expected = activityChain.replace(activity.escrowAddress, input.placeId, input.expiry, input.nonce, input.designatedBuyer, input.signature as `0x${string}`);
  const hash = input.hash as `0x${string}`;
  const transaction = await activityChain.transaction(hash);
  const buyer = auth.requireWallet(identity, transaction.from);
  if (buyer.toLowerCase() !== getAddress(input.walletAddress).toLowerCase() || transaction.to?.toLowerCase() !== expected.contractAddress.toLowerCase() || transaction.input !== expected.callData || transaction.value !== 0n) return res.status(400).json({ error: "This transaction does not match the replacement offer." });
  const receipt = await activityChain.waitReceipt(hash);
  if (receipt.status !== "success") return res.status(409).json({ error: "The replacement failed." });
  const place = await activityChain.place(activity.escrowAddress, input.placeId);
  if (place.owner.toLowerCase() !== buyer.toLowerCase()) return res.status(409).json({ error: "The replacement was not recorded onchain." });
  res.json({ place, transactionHash: hash, onchain: await activityChain.summary(activity.escrowAddress) });
} catch (error) { next(error); } });

app.post("/activities/:activityId/replacements/invalidate/prepare", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity?.escrowAddress) return res.status(409).json({ error: "This activity is not active onchain." });
  const input = verifiedWallet.extend({ placeId: z.number().int().nonnegative() }).parse(req.body);
  const owner = auth.requireWallet(identity, input.walletAddress);
  const place = await activityChain.place(activity.escrowAddress, input.placeId);
  if (place.refunded || place.owner.toLowerCase() !== owner.toLowerCase()) return res.status(403).json({ error: "Only the current place owner can invalidate its offers." });
  const call = activityChain.invalidateOffer(activity.escrowAddress, input.placeId);
  await activityChain.simulate(call, owner);
  res.json({ signer: owner, transactions: preparedTransactions([call]) });
} catch (error) { next(error); } });

app.post("/activities/:activityId/replacements/invalidate/confirm", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity?.escrowAddress) return res.status(409).json({ error: "This activity is not active onchain." });
  const input = verifiedWallet.extend({ placeId: z.number().int().nonnegative(), hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }).parse(req.body);
  const hash = input.hash as `0x${string}`;
  const expected = activityChain.invalidateOffer(activity.escrowAddress, input.placeId);
  const transaction = await activityChain.transaction(hash);
  const owner = auth.requireWallet(identity, transaction.from);
  if (owner.toLowerCase() !== getAddress(input.walletAddress).toLowerCase() || transaction.to?.toLowerCase() !== expected.contractAddress.toLowerCase() || transaction.input !== expected.callData || transaction.value !== 0n) return res.status(400).json({ error: "This transaction does not invalidate the selected replacement offers." });
  const receipt = await activityChain.waitReceipt(hash);
  if (receipt.status !== "success") return res.status(409).json({ error: "The replacement offers were not invalidated." });
  const place = await activityChain.place(activity.escrowAddress, input.placeId);
  if (place.owner.toLowerCase() !== owner.toLowerCase()) return res.status(409).json({ error: "You no longer own this place." });
  res.json({ place, transactionHash: hash });
} catch (error) { next(error); } });

const activityAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("settle") }), z.object({ type: z.literal("expire") }),
  z.object({ type: z.literal("cancel") }), z.object({ type: z.literal("refund"), placeId: z.number().int().nonnegative() }),
]);
function activityActionCall(escrowAddress: string, action: z.infer<typeof activityAction>) {
  if (action.type === "settle") return activityChain.settle(escrowAddress);
  if (action.type === "expire") return activityChain.expire(escrowAddress);
  if (action.type === "cancel") return activityChain.cancel(escrowAddress);
  return activityChain.refund(escrowAddress, action.placeId);
}
app.post("/activities/:activityId/actions/prepare", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity?.escrowAddress) return res.status(409).json({ error: "This activity is not active onchain." });
  const input = verifiedWallet.extend({ action: activityAction }).parse(req.body);
  const signer = auth.requireWallet(identity, input.walletAddress);
  if (input.action.type === "cancel" && signer.toLowerCase() !== activity.organizerAddress.toLowerCase()) return res.status(403).json({ error: "Only the organizer can cancel this activity." });
  const call = activityActionCall(activity.escrowAddress, input.action);
  await activityChain.simulate(call, signer);
  res.json({ action: input.action, signer, transactions: preparedTransactions([call]) });
} catch (error) { next(error); } });

app.post("/activities/:activityId/actions/confirm", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const activity = await activities.get(z.string().uuid().parse(req.params.activityId));
  if (!activity?.escrowAddress) return res.status(409).json({ error: "This activity is not active onchain." });
  const input = z.object({ action: activityAction, hash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) }).parse(req.body);
  const hash = input.hash as `0x${string}`;
  const expected = activityActionCall(activity.escrowAddress, input.action);
  const transaction = await activityChain.transaction(hash);
  auth.requireWallet(identity, transaction.from);
  if (input.action.type === "cancel" && transaction.from.toLowerCase() !== activity.organizerAddress.toLowerCase()) return res.status(403).json({ error: "Only the organizer can cancel this activity." });
  if (transaction.to?.toLowerCase() !== expected.contractAddress.toLowerCase() || transaction.input !== expected.callData || transaction.value !== 0n) return res.status(400).json({ error: "This transaction does not match the requested activity action." });
  const receipt = await activityChain.waitReceipt(hash);
  if (receipt.status !== "success") return res.status(409).json({ error: "The activity action failed." });
  res.json({ action: input.action, transactionHash: hash, onchain: await activityChain.summary(activity.escrowAddress) });
} catch (error) { next(error); } });
app.post("/families/:familyId/funding/session", async (req, res, next) => { try {
  const { family, identity } = await familyAccess(req);
  if (!await resolveTreasury(family.id)) return res.status(409).json({ error: "Activate the family treasury first." });
  const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const session = await moonPay.createSession({ externalCustomerId: identity.userId, deviceIp: forwarded || req.ip || "127.0.0.1" });
  res.set("Cache-Control", "no-store").json(session);
} catch (error) { next(error); } });
app.post("/families/:familyId/funding/intents", async (req, res, next) => { try {
  const { family, identity } = await familyAccess(req);
  const input = z.object({ amount: fundingAmount, currency: z.enum(["USD", "EUR", "GBP"]).default("USD"), vaultId: z.number().int().nonnegative().optional() }).parse(req.body);
  const treasuryAddress = await resolveTreasury(family.id); if (!treasuryAddress) return res.status(409).json({ error: "Activate the family treasury first." });
  const summary = await chain.summary(treasuryAddress);
  if (input.vaultId !== undefined && !summary.vaults.some(vault => vault.id === input.vaultId)) return res.status(404).json({ error: "Vault not found." });
  res.status(201).json({ intent: funding.create({ familyId: family.id, requestedBy: identity.userId, treasuryAddress, vaultId: input.vaultId, sourceAmount: input.amount, sourceCurrency: input.currency }) });
} catch (error) { next(error); } });
app.post("/funding/intents/:intentId/transaction", async (req, res, next) => { try {
  const identity = await authenticate(req); const intent = fundingIntentAccess(identity.userId, req.params.intentId);
  const input = z.object({ transactionId: z.string().trim().min(1).max(255), paymentMethod: z.string().trim().min(1).max(64) }).parse(req.body);
  if (intent.moonPayTransactionId && intent.moonPayTransactionId !== input.transactionId) return res.status(409).json({ error: "This funding request already has a payment." });
  res.json({ intent: funding.update(intent.id, { moonPayTransactionId: input.transactionId, paymentMethod: input.paymentMethod, status: "payment_pending" }) });
} catch (error) { next(error); } });
app.post("/funding/intents/:intentId/quote", async (req, res, next) => { try {
  const identity = await authenticate(req); const intent = fundingIntentAccess(identity.userId, req.params.intentId);
  if (intent.moonPayTransactionId) return res.status(409).json({ error: "This funding request already has a payment." });
  const quote = z.object({
    sourceAmount: fundingAmount, destinationAmount: positiveAmount, feeAmount: amount,
    exchangeRate: positiveAmount, expiresAt: z.string().datetime().optional(), paymentMethod: z.string().trim().min(1).max(64),
  }).parse(req.body);
  if (Number(quote.sourceAmount) !== Number(intent.sourceAmount)) return res.status(400).json({ error: "The quote amount does not match this funding request." });
  res.json({ intent: funding.update(intent.id, { quote, paymentMethod: quote.paymentMethod, status: "quoted" }) });
} catch (error) { next(error); } });
app.get("/funding/intents/:intentId", async (req, res, next) => { try {
  const identity = await authenticate(req); res.set("Cache-Control", "no-store").json({ intent: fundingIntentAccess(identity.userId, req.params.intentId) });
} catch (error) { next(error); } });
app.post("/funding/intents/:intentId/allocation/prepare", async (req, res, next) => { try {
  const identity = await authenticate(req); const intent = fundingIntentAccess(identity.userId, req.params.intentId);
  if (intent.status !== "allocation_pending" || intent.vaultId === undefined || !intent.receivedAmount) return res.status(409).json({ error: "The received funds are not ready to allocate." });
  const signer = auth.requireWallet(identity, verifiedWallet.parse(req.body).walletAddress);
  const family = families.get(intent.familyId); if (!family?.parentAddresses.some(parent => parent.toLowerCase() === signer.toLowerCase())) return res.status(403).json({ error: "Only an Owner can approve this allocation." });
  const call = chain.allocate(intent.treasuryAddress, [{ vaultId: intent.vaultId, amount: intent.receivedAmount }]); await chain.simulate(call, signer);
  res.json({ transactions: preparedTransactions([call]) });
} catch (error) { next(error); } });
app.post("/funding/intents/:intentId/allocation/confirm", async (req, res, next) => { try {
  const identity = await authenticate(req); const intent = fundingIntentAccess(identity.userId, req.params.intentId);
  if (intent.vaultId === undefined || !intent.receivedAmount) return res.status(409).json({ error: "This funding request does not need allocation." });
  const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/).parse(req.body.hash) as `0x${string}`;
  const expected = chain.allocate(intent.treasuryAddress, [{ vaultId: intent.vaultId, amount: intent.receivedAmount }]); const transaction = await chain.transaction(hash); auth.requireWallet(identity, transaction.from);
  if (transaction.to?.toLowerCase() !== expected.contractAddress.toLowerCase() || transaction.input !== expected.callData || transaction.value !== 0n) return res.status(400).json({ error: "This approval does not match the funding request." });
  const receipt = await chain.waitReceipt(hash); if (receipt.status !== "success") return res.status(409).json({ error: "The allocation was not completed." });
  res.json({ intent: funding.update(intent.id, { allocationTransactionHash: hash, status: "completed" }) });
} catch (error) { next(error); } });

app.post("/families", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const input = createFamily.parse(req.body);
  const creator = auth.requireWallet(identity, input.walletAddress);
  const parents = input.parentAddresses.map(getAddress);
  if (!parents.some((parent) => parent.toLowerCase() === creator.toLowerCase())) return res.status(403).json({ error: "The Dynamic embedded wallet must be one of the family parents." });
  if (new Set(parents.map((parent) => parent.toLowerCase())).size !== parents.length) return res.status(400).json({ error: "A parent cannot appear twice." });
  if (input.vaults.some((vault) => vault.withdrawalApprovalsRequired > parents.length)) return res.status(400).json({ error: "A vault quorum cannot exceed the number of parents." });
  if (!infrastructure.factoryAddress) return res.status(503).json({ error: "FamilyTreasuryFactory is not deployed for this network." });
  const familyId = input.id ?? randomUUID();
  const existing = families.get(familyId);
  if (existing && (JSON.stringify(existing.parentAddresses) !== JSON.stringify(parents) || JSON.stringify(existing.initialVaults) !== JSON.stringify(input.vaults))) return res.status(409).json({ error: "Family setup differs from its original request." });
  if (!existing) families.create({ id: familyId, name: input.name, parentAddresses: parents, initialVaults: input.vaults, createdAt: new Date().toISOString() });
  const deployed = await chain.treasuryForFamily(infrastructure.factoryAddress, familyId);
  if (deployed) {
    families.setTreasury(familyId, deployed);
    return res.json({ familyId, transactions: [], signer: creator });
  }
  const call = chain.createFamily(infrastructure.factoryAddress, familyId, parents, input.vaults);
  await chain.simulate(call, creator);
  await activationSponsor.ensure(creator);
  res.status(201).json({ familyId, transactions: preparedTransactions([call]), signer: creator });
} catch (error) { next(error); } });

app.get("/families/:familyId", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const familyId = z.string().uuid().parse(req.params.familyId);
  const record = families.get(familyId);
  if (!record) return res.status(404).json({ error: "Family not found." });
  if (!identity.evmWallets.some((wallet) => record.parentAddresses.some((parent) => parent.toLowerCase() === wallet.toLowerCase()))) return res.status(403).json({ error: "This Dynamic user is not a member of the family." });
  const treasuryAddress = await resolveTreasury(familyId);
  const contacts = managedMembers.contacts(identity.userId);
  const recipientName = (address: string) => contacts.find(contact => contact.address.toLowerCase() === address.toLowerCase())?.name;
  const treasury = treasuryAddress ? await chain.summary(treasuryAddress) : null;
  res.json({ family: { ...record, treasuryAddress }, treasury: treasury ? { ...treasury, withdrawals: treasury.withdrawals.map(item => ({ ...item, recipientName: recipientName(item.recipient) })) } : null,
    plans: plans.list(familyId).map(stored => ({ ...stored, plan: stored.plan ? { ...stored.plan, actions: stored.plan.actions.map(item => ({ ...item, ...("recipient" in item && item.recipient ? { recipientName: recipientName(item.recipient) } : {}) })) } : undefined })) });
} catch (error) { next(error); } });

app.post("/families/:familyId/actions", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const familyId = z.string().uuid().parse(req.params.familyId);
  if (!families.get(familyId)) return res.status(404).json({ error: "Family not found." });
  const input = verifiedWallet.extend({ action }).parse(req.body);
  const signer = auth.requireWallet(identity, input.walletAddress);
  const treasuryAddress = await resolveTreasury(familyId);
  if (!treasuryAddress) return res.status(409).json({ error: "The family treasury is still confirming on Monad." });
  const summary = await chain.summary(treasuryAddress);
  if (!summary.parents.some((parent) => parent.toLowerCase() === signer.toLowerCase())) return res.status(403).json({ error: "Only a verified family parent may prepare this action." });
  const calls = actionCalls(treasuryAddress, input.action);
  res.status(201).json({ action: input.action, transactions: preparedTransactions(calls), signer });
} catch (error) { next(error); } });

app.post("/families/:familyId/cfo/messages", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const familyId = z.string().uuid().parse(req.params.familyId);
  const input = verifiedWallet.extend({ messages: cfoChatInput.shape.messages }).parse(req.body);
  const signer = auth.requireWallet(identity, input.walletAddress);
  const family = families.get(familyId);
  if (!family) return res.status(404).json({ error: "Family not found." });
  if (!family.parentAddresses.some((parent) => parent.toLowerCase() === signer.toLowerCase())) return res.status(403).json({ error: "Only a verified family parent may ask the CFO agent." });
  const treasuryAddress = await resolveTreasury(familyId);
  if (!treasuryAddress) return res.status(409).json({ error: "The family treasury is still confirming on Monad." });

  const context = { ...await contexts.load(family, treasuryAddress), contacts: managedMembers.contacts(identity.userId) };
  // The agent boundary is always parsed again here, so future LLM adapters
  // cannot introduce a new action or arbitrary calldata into the workflow.
  const decision = await cfo.decide(input.messages, context);
  if (!decision.plan) return res.json({ reply: decision.reply });
  const plan = planSchema.parse(decision.plan);
  const message = input.messages.at(-1)!.content;
  const policy = policies.validate(plan, context);
  const planId = randomUUID();
  if (!policy.ok) {
    const stored = plans.create({ id: planId, familyId, requestedBy: signer, message, plan, explanation: "This plan conflicts with your family treasury rules.", status: "rejected", createdAt: new Date().toISOString(), policyIssues: policy.issues });
    return res.status(422).json({ reply: decision.reply, plan: stored });
  }
  const calls = plan.actions.flatMap((item) => actionCalls(treasuryAddress, item));
  const simulation = await simulations.simulate(calls, signer);
  const stored = plans.create({
    id: planId, familyId, requestedBy: signer, message, plan,
    explanation: simulation.ok ? `${plan.summary} It respects the current treasury rules and is ready for ${plan.requiredApprovals} approval${plan.requiredApprovals === 1 ? "" : "s"}.` : "The plan is valid by policy, but Monad rejected its dry-run.",
    status: simulation.ok ? "ready_for_confirmation" : "rejected", createdAt: new Date().toISOString(), policyIssues: simulation.ok ? [] : ["Monad simulation failed."], simulation,
  });
  res.status(simulation.ok ? 201 : 422).json({ reply: decision.reply, plan: stored });
} catch (error) { next(error); } });

app.post("/families/:familyId/plans/:planId/confirm", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const familyId = z.string().uuid().parse(req.params.familyId);
  const planId = z.string().uuid().parse(req.params.planId);
  const input = verifiedWallet.parse(req.body);
  const signer = auth.requireWallet(identity, input.walletAddress);
  const family = families.get(familyId);
  if (!family) return res.status(404).json({ error: "Family not found." });
  if (!family.parentAddresses.some((parent) => parent.toLowerCase() === signer.toLowerCase())) return res.status(403).json({ error: "Only a verified family parent may confirm a plan." });
  const plan = plans.get(familyId, planId);
  if (!plan) return res.status(404).json({ error: "Plan not found." });
  if (!["ready_for_confirmation", "confirmed"].includes(plan.status) || !plan.plan) return res.status(409).json({ error: "This plan is not ready for confirmation." });
  const treasuryAddress = await resolveTreasury(familyId);
  if (!treasuryAddress) return res.status(409).json({ error: "The family treasury is still confirming on Monad." });
  // Re-load the chain state: a draft must not bypass a balance or floor change.
  const context = { ...await contexts.load(family, treasuryAddress), contacts: managedMembers.contacts(identity.userId) };
  const policy = policies.validate(plan.plan, context);
  if (!policy.ok) return res.status(409).json({ error: "The treasury state changed; this plan no longer satisfies policy.", issues: policy.issues });
  const calls = plan.plan.actions.flatMap((item) => actionCalls(treasuryAddress, item));
  const simulation = await simulations.simulate(calls, signer);
  if (!simulation.ok) return res.status(409).json({ error: "The Monad simulation failed; the plan was not prepared for signing.", simulation });
  if (calls.length !== 1) return res.status(400).json({ error: "Confirm one operation at a time." });
  const confirmed = plans.update({ ...plan, status: "confirmed", preparedCall: calls[0] });
  res.json({ plan: confirmed, signer, transactions: preparedTransactions(calls) });
} catch (error) { next(error); } });

app.get("/families", async (req, res, next) => { try {
  const identity = await authenticate(req);
  res.set("Cache-Control", "no-store").json({ families: families.list(identity.evmWallets) });
} catch (error) { next(error); } });

app.post("/families/:familyId/profile", async (req, res, next) => { try {
  const { family } = await familyAccess(req);
  const input = z.object({ name: z.string().trim().min(1).max(64), focus: z.string().trim().min(1).max(120) }).parse(req.body);
  res.json({ family: families.updateProfile(family.id, input.name, input.focus) });
} catch (error) { next(error); } });

app.get("/wallet/balance", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const address = auth.requireWallet(identity, z.string().parse(req.query.address));
  res.json({ balance: await chain.walletBalance(address), currency: "USDC" });
} catch (error) { next(error); } });

app.post("/transactions/:hash/receipt", async (req, res, next) => { try {
  const identity = await authenticate(req);
  const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/).parse(req.params.hash) as `0x${string}`;
  const transaction = await chain.transaction(hash);
  auth.requireWallet(identity, transaction.from);
  const receipt = await chain.waitReceipt(hash);
  res.json({ hash, status: receipt.status });
} catch (error) { next(error); } });

app.post("/families/:familyId/plans/:planId/submission", async (req, res, next) => { try {
  const { family, identity } = await familyAccess(req);
  const planId = z.string().uuid().parse(req.params.planId);
  const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/).parse(req.body.hash) as `0x${string}`;
  const plan = plans.get(family.id, planId);
  if (!plan?.preparedCall || !["confirmed", "submitted", "executed", "reverted"].includes(plan.status)) return res.status(409).json({ error: "Prepare this plan before submitting it." });
  if (plan.transactionHash && plan.transactionHash !== hash) return res.status(409).json({ error: "This plan already has a transaction." });
  const transaction = await chain.transaction(hash);
  auth.requireWallet(identity, transaction.from);
  if (!family.parentAddresses.some(address => address.toLowerCase() === transaction.from.toLowerCase()) || transaction.to?.toLowerCase() !== plan.preparedCall.contractAddress.toLowerCase() || transaction.input !== plan.preparedCall.callData || transaction.value !== 0n) return res.status(400).json({ error: "This transaction does not match the approved plan." });
  const submitted = plans.update({ ...plan, status: "submitted", transactionHash: hash });
  const receipt = await chain.waitReceipt(hash);
  res.json({ plan: plans.update({ ...submitted, status: receipt.status === "success" ? "executed" : "reverted", executedAt: new Date().toISOString() }) });
} catch (error) { next(error); } });

async function familyAccess(req: Request) {
  const identity = await authenticate(req);
  const family = families.get(z.string().uuid().parse(req.params.familyId));
  if (!family) throw new Error("Family not found.");
  if (!identity.evmWallets.some(wallet => family.parentAddresses.some(parent => parent.toLowerCase() === wallet.toLowerCase()))) throw new Error("Only a verified family parent may access this treasury.");
  return { family, identity };
}

async function authenticate(req: Request) { return auth.authenticate(req.header("Authorization")); }
function fundingIntentAccess(userId: string, rawId: string) {
  const id = z.string().uuid().parse(rawId); const intent = funding.get(id);
  if (!intent || intent.requestedBy !== userId) throw new Error("Funding request not found.");
  return intent;
}
async function resolveTreasury(familyId: string) {
  const record = families.get(familyId);
  if (record?.treasuryAddress) return record.treasuryAddress;
  if (!infrastructure.factoryAddress) return undefined;
  const address = await chain.treasuryForFamily(infrastructure.factoryAddress, familyId);
  if (address && record) families.setTreasury(familyId, address);
  return address;
}
function preparedTransactions(calls: ContractCall[]) {
  return calls.map((call) => ({ to: call.contractAddress, data: call.callData, value: "0", chainId: infrastructure.chain.id }));
}
function actionCalls(treasuryAddress: string, input: z.infer<typeof action> | CfoAction): ContractCall[] {
  switch (input.type) {
    case "create_vault": return [chain.createVault(treasuryAddress, input.config)];
    case "deposit": return [chain.approveDeposit(treasuryAddress, input.amount), chain.deposit(treasuryAddress, input.amount)];
    case "allocate": return [chain.allocate(treasuryAddress, input.allocations)];
    case "propose_withdrawal": return [chain.proposeWithdrawal(treasuryAddress, input.vaultId, input.recipient, input.amount)];
    case "approve_withdrawal": return [chain.approveWithdrawal(treasuryAddress, input.proposalId)];
    case "propose_scheduled_transfer": return [chain.proposeScheduledTransfer(treasuryAddress, input)];
    case "approve_scheduled_transfer": return [chain.approveScheduledTransfer(treasuryAddress, input.scheduleId)];
    case "execute_scheduled_transfer": return [chain.executeScheduledTransfer(treasuryAddress, input.scheduleId)];
  }
  throw new Error("Unsupported treasury action.");
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof z.ZodError ? error.issues[0]?.message ?? "Invalid request body." : error instanceof Error ? error.message : "Unexpected error.";
  const unauthorized = /Dynamic|Bearer token|verified/i.test(message);
  res.status(unauthorized ? 401 : 400).json({ error: message });
});
const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`Ours API listening on http://localhost:${port}`));
