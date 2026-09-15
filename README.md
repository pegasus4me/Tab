# Tab

Ours is a family CFO and treasury asset manager. Families describe their goals; Ours reads their actual treasury, proposes a plan and executes approved operations within family rules. The consumer interface uses dollars, member names and ordinary payment language. Monad and USDC are internal infrastructure, never concepts the user needs to understand.

## Architecture

```text
React PWA → TypeScript API → Dynamic embedded or connected wallet
                          ↘ Monad FamilyTreasury → native USDC
```

- `web/`: installable PWA with the Ours landing page and family treasury experience.
- `backend/`: Dynamic-authenticated API and Monad reads.
- `contracts/`: USDC treasury, programmable vaults and enforceable family rules.

## Run the backend

```sh
cd backend
npm install
npm run dev
```

It listens on `http://localhost:8787`. Set `PWA_ORIGIN` to the deployed PWA origin (or a comma-separated allowlist) before production.

### Configure Dynamic and Monad

```sh
cd backend
cp .env.example .env
```

Set `DYNAMIC_ENVIRONMENT_ID` from the Dynamic dashboard. Leave `OURS_NETWORK=monad-testnet` until the complete flow has been tested. No private user key belongs in this file.

### Persist PINs with Supabase

The `user_pins` migration has been applied to the Tab Supabase project. Set `SUPABASE_URL` and the project's server-only `SUPABASE_SERVICE_ROLE_KEY` in the backend environment. The browser never receives this key; PINs are stored only as salted scrypt hashes, and the table's RLS policy blocks direct client access. Production startup fails if these values are missing.

Useful routes:

- `GET /infrastructure`: selected chain, USDC and readiness.
- `GET /wallet/config`: public Dynamic configuration required by the PWA.
- `GET /auth/me`: validates the current Dynamic session.
- `POST /families`: prepares an onchain family treasury creation transaction.
- `GET /families/:familyId`: returns an authorised family's onchain summary.
- `POST /families/:familyId/actions`: prepares a guarded onchain treasury action.

All authorised endpoints require a Dynamic bearer token. Transactions are prepared by the API and signed by the user's connected or embedded wallet.

## Test the contracts

```sh
cd contracts
npm install
npm test
```

`FamilyTreasury` is the new Ours primitive: it holds real USDC, accounts for named family vaults, enforces vault floors, requires a configured approval quorum for withdrawals and releases weekly child allowances. `TabVault` remains for backwards compatibility while the API is migrated.

Use Node 22 LTS for Hardhat; Node 25 currently prints an unsupported-version warning.

Do not deploy to mainnet until the contracts have had an external security review and the full lifecycle has been exercised with capped test funds.

## Run the PWA

```sh
cd web
cp .env.example .env
npm install
npm run dev
```

Start the backend first. The PWA obtains its public Dynamic environment configuration from `GET /wallet/config`, then sends the Dynamic bearer token to the API. It includes a web manifest and service worker, so it can be installed from a supported browser.

## Current end-to-end path

1. Sign in through Dynamic, unlock Ours and activate a family treasury.
2. Configure the CFO's family name and goal; these persist on the API server.
3. Create real vaults and deposit an existing payment-account USDC balance into the treasury. A selected vault receives a separate allocation after the deposit receipt succeeds.
4. Ask the CFO to allocate money or prepare a payment. The Responses API receives live balances, vault floors, pending withdrawals, schedules, linked recipients and up to the last 100 blocks of payment activity. A history-provider failure does not block the CFO. It emits a validated structured decision, not arbitrary calldata.
5. Review the proposal's amounts, destinations and timing. Policy validation and a simulation run again before confirmation. One operation is allowed per plan; an allocation may cover multiple vaults atomically.
6. The embedded account signs, the app records the submitted hash, and the server verifies sender, destination, calldata, value and receipt. Confirmed execution of a proposal does not imply that a multi-parent payment has received every approval. Pending approvals appear separately.
7. Balances refresh after completion and every 15 seconds while the app is visible. Failed/uncertain sends retain recovery hashes in the browser so a retry checks their status first.

Families, profiles and plans use atomic JSON files under `OURS_DATA_DIR` (default `backend/.data`), partitioned by network. This supports restart recovery with **one API process and a persistent disk**, not multiple concurrent API writers or ephemeral hosting. Member identities remain separate from treasury-parent permissions. New linked recipients obtain their payment address server-side when they accept an invitation; the interface never requests or displays it.

## Scheduled payments

Local testnet activation now includes a one-time fee credit after the creation call passes simulation. Configure `OURS_TESTNET_SPONSOR_PRIVATE_KEY` or, for local development only, `OURS_TESTNET_SPONSOR_ENV_FILE` pointing to the existing deployment env file. Credit is capped at 1 MON per account and 5 MON in total, recorded in `testnet-activation-credits.json`, and is never enabled on mainnet. Do not remove this ledger to reset the budget. Production still needs fee sponsorship appropriate to its account infrastructure.

`cd backend && npm run schedules:run` runs one sweep of active, due schedules. Configure a dedicated `OURS_RELAYER_PRIVATE_KEY`, fund only its network fees, and invoke the command periodically in the deployment environment. The relayer cannot choose payment values or override family rules. Each sweep simulates payments, waits for receipts, and reports failures independently. The runner is implemented but is not activated by starting the API. The app also offers execution of a due payment.

## Deployment and remaining scope

- The contract now supports vault creation and rechecks a vault floor at the last withdrawal approval. Existing immutable deployments do not acquire these changes: deploy the updated factory on testnet and use a newly created treasury for validation.
- The consumer setup currently creates a single-parent treasury. The contract/API support multiple initial parents, but a fully abstracted co-parent enrollment and permission-management flow is still required.
- The UI hides blockchain details, but complete payment abstraction also requires deployed fee sponsorship and verification of the Dynamic confirmation experience. These are not provisioned by this change.
- Add Funds uses the MoonPay Platform Web SDK behind an Ours-designed amount, payment-method, quote, status and vault-allocation flow. Secure onboarding, card, payment-button and challenge frames appear only when required. Configure a Platform test key and webhook key, register the web origin, and confirm that MoonPay enables the exact Monad USDC asset before sandbox testing.
- Multi-asset investing, source-backed investment theses, market tools, investment execution, portfolio rebalancing and performance accounting remain to be implemented. The CFO explicitly treats unsupported investment requests as discussion, never executable plans or invented holdings.
- Live RPC/identity/payment-provider configuration and a complete authenticated testnet walkthrough are required before claiming a working deployed product. No mainnet funds were moved by this development work.

## Verification

Run `npm test` and `npm run typecheck` in `backend`, `npm test` in `contracts`, and `npm run build` in `web`. Regression tests cover stale withdrawal approvals, real vault creation, structured-model rejection, commitment-aware policies, restart persistence and scheduled-payment selection/failure isolation.
