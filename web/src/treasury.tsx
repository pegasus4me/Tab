import { customerError, money } from "./financial-display";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getAuthToken, useDynamicContext, useIsLoggedIn } from "@dynamic-labs/sdk-react-core";
import { isEthereumWallet } from "@dynamic-labs/ethereum";

type Transaction = { to: `0x${string}`; data: `0x${string}`; value: string; chainId: number };
export type Vault = { id: number; name: string; balance: string; floor: string; withdrawalApprovalsRequired: number };
export type Plan = { id: string; explanation: string; status: string; transactionHash?: string; plan?: { summary: string; requiredApprovals: number; actions: { type: string; allocations?: { vaultId: number; amount: string }[]; amount?: string; vaultId?: number; sourceVaultId?: number; destinationVaultId?: number; recipientName?: string; intervalSeconds?: number; firstExecutionAt?: number }[] }; policyIssues: string[] };
type Family = { id: string; name: string; focus?: string; parentAddresses: string[]; initialVaults?: { name: string; floor: string; withdrawalApprovalsRequired: number }[] };
export type TreasurySnapshot = { family: Family; plans: Plan[]; treasury: null | { address: string; currency: string; unallocatedBalance: string; vaults: Vault[]; withdrawals: { id: number; vaultId: number; recipient: string; recipientName?: string; amount: string; approvals: number; executed: boolean }[]; scheduledTransfers: { id: number; sourceVaultId: number; amount: string; approvals: number; active: boolean; nextExecutionAt: number; intervalSeconds: number; recipient: string }[] } };
export async function apiRequest(apiUrl: string, path: string, body?: unknown) {
  const response = await fetch(`${apiUrl}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${getAuthToken()}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(customerError(data.error ?? data.plan?.policyIssues?.join(" ") ?? "Unable to complete this request."));
  return data;
}
function useTreasuryState(apiUrl: string) {
  const { primaryWallet } = useDynamicContext();
  const loggedIn = useIsLoggedIn();
  const [snapshot, setSnapshot] = useState<TreasurySnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const address = primaryWallet?.address;
  const epoch = useRef(0);
  async function reload() {
    const current = epoch.current;
    if (!loggedIn || !address) return;
    const data = await apiRequest(apiUrl, "/families");
    const selected = data.families.find((family: Family) => family.id === snapshot?.family.id) ?? data.families[0];
    const next = selected ? await apiRequest(apiUrl, `/families/${selected.id}`) : null;
    if (current === epoch.current) { setSnapshot(next); setError(""); }
    return next as TreasurySnapshot | null;
  }
  useEffect(() => {
    epoch.current += 1; setSnapshot(null); setError(""); setLoading(true);
    if (!loggedIn || !address) { setLoading(false); return; }
    let active = true;
    void reload().catch(reason => { if (active) setError(customerError(reason)); }).finally(() => { if (active) setLoading(false); });
    const timer = window.setInterval(() => { if (!document.hidden) void reload().catch(reason => { if (active) setError(customerError(reason)); }); }, 15000);
    return () => { active = false; epoch.current += 1; window.clearInterval(timer); };
  }, [loggedIn, address, apiUrl]);
  async function locked<T>(operation: () => Promise<T>) {
    if (inFlight.current) throw new Error("Wait for the current operation to finish.");
    inFlight.current = true; setBusy(true); setError("");
    try { return await operation(); } finally { inFlight.current = false; setBusy(false); }
  }
  async function send(transactions: Transaction[], onHash?: (hash: string) => Promise<void>) {
    if (!primaryWallet || !isEthereumWallet(primaryWallet)) throw new Error("Your payment account is not ready.");
    for (const transaction of transactions) {
      await primaryWallet.switchNetwork(transaction.chainId);
      const wallet = await primaryWallet.getWalletClient(String(transaction.chainId));
      const recoveryKey = `ours-payment:${address}:${transaction.chainId}:${transaction.to}:${transaction.data}:${transaction.value}`;
      const pending = localStorage.getItem(recoveryKey);
      const hash = pending ?? await wallet.sendTransaction({ to: transaction.to, data: transaction.data, value: BigInt(transaction.value), account: wallet.account, chain: wallet.chain });
      localStorage.setItem(recoveryKey, hash);
      if (onHash) { await onHash(hash); localStorage.removeItem(recoveryKey); }
      else {
        const result = await apiRequest(apiUrl, `/transactions/${hash}/receipt`, {});
        localStorage.removeItem(recoveryKey);
        if (result.status !== "success") throw new Error("The operation failed. No further step was sent.");
      }
    }
  }
  async function setup(name: string, parents: string[], initialVaults: { name: string; floor: string; withdrawalApprovalsRequired: number }[]) {
    return locked(async () => {
      if (!address) throw new Error("Your payment account is not ready.");
      const current = snapshot?.family;
      const result = await apiRequest(apiUrl, "/families", { id: current?.id, name, parentAddresses: current?.parentAddresses ?? parents, vaults: current?.initialVaults ?? initialVaults, walletAddress: address });
      try { await send(result.transactions); }
      finally { await reload(); }
      return await reload();
    });
  }
  async function action(value: object) {
    if (!snapshot?.treasury) throw new Error("Activate your family treasury first.");
    const result = await apiRequest(apiUrl, `/families/${snapshot.family.id}/actions`, { walletAddress: address, action: value });
    await send(result.transactions);
  }
  async function perform(value: object) { return locked(async () => { await action(value); await reload(); }); }
  async function deposit(amount: string, vaultId?: number) {
    return locked(async () => {
      await action({ type: "deposit", amount });
      await reload();
      if (vaultId !== undefined) {
        try { await action({ type: "allocate", allocations: [{ vaultId, amount }] }); }
        catch { throw new Error("Your deposit arrived in the treasury, but the vault allocation did not finish. Ask your CFO to allocate the available funds; do not repeat the deposit."); }
        await reload();
      }
    });
  }
  async function confirm(plan: Plan) {
    if (!snapshot) return;
    return locked(async () => {
      const path = `/families/${snapshot.family.id}/plans/${plan.id}`;
      const key = `ours-submission:${address}:${snapshot.family.id}:${plan.id}`;
      const submit = async (hash: string) => {
        localStorage.setItem(key, hash);
        const result = await apiRequest(apiUrl, `${path}/submission`, { hash });
        localStorage.removeItem(key);
        if (result.plan.status === "reverted") throw new Error("This operation was reverted. Ask the CFO for a new proposal.");
      };
      const pending = plan.transactionHash ?? localStorage.getItem(key);
      try {
        if (pending) await submit(pending);
        else {
          const result = await apiRequest(apiUrl, `${path}/confirm`, { walletAddress: address });
          await send(result.transactions, submit);
        }
      } finally { await reload(); }
    });
  }
  async function chat(messages: { role: "user" | "assistant"; content: string }[]) {
    if (!snapshot?.treasury) throw new Error("Activate your family treasury so your CFO can read its real balances.");
    const result = await apiRequest(apiUrl, `/families/${snapshot.family.id}/cfo/messages`, { walletAddress: address, messages: messages.slice(-20) });
    await reload(); return result as { reply: string; plan?: Plan };
  }
  async function profile(name: string, focus: string, familyId?: string) {
    const id = familyId ?? snapshot?.family.id;
    if (!id) throw new Error("Activate your family treasury first.");
    await apiRequest(apiUrl, `/families/${id}/profile`, { name, focus }); await reload();
  }
  async function allocateFunding(intentId: string) {
    if (!address) throw new Error("Your payment account is not ready.");
    return locked(async () => {
      const path = `/funding/intents/${intentId}/allocation`;
      const result = await apiRequest(apiUrl, `${path}/prepare`, { walletAddress: address });
      await send(result.transactions, hash => apiRequest(apiUrl, `${path}/confirm`, { hash }));
      await reload();
    });
  }
  async function grantOwner(memberId: string) {
    if (!snapshot?.family.id || !address) throw new Error("Activate your family treasury first.");
    return locked(async () => {
      const path = `/families/${snapshot.family.id}/members/${memberId}/owner`;
      const result = await apiRequest(apiUrl, `${path}/prepare`, { walletAddress: address });
      if (result.transactions.length) await send(result.transactions, hash => apiRequest(apiUrl, `${path}/confirm`, { hash }));
      await reload();
    });
  }
  return { snapshot, error, loading, busy, address, reload, setup, perform, deposit, confirm, chat, profile, grantOwner, allocateFunding, apiUrl };
}
export const TreasuryContext = createContext<ReturnType<typeof useTreasuryState> | null>(null);
export function TreasuryProvider({ apiUrl, children }: { apiUrl: string; children: ReactNode }) { return <TreasuryContext.Provider value={useTreasuryState(apiUrl)}>{children}</TreasuryContext.Provider>; }
export function useTreasury() { const value = useContext(TreasuryContext); if (!value) throw new Error("TreasuryProvider is missing."); return value; }
export function TreasuryTotal() {
  const { snapshot, loading, error } = useTreasury();
  if (loading || error) return <>{loading ? "Loading…" : "Unavailable"}</>;
  if (!snapshot?.treasury) return <>—</>;
  const toUnits = (value: string) => { const [whole, fraction = ""] = value.split("."); return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0")); };
  const total = snapshot.treasury.vaults.reduce((sum, vault) => sum + toUnits(vault.balance), toUnits(snapshot.treasury.unallocatedBalance));
  return <>{money(Number(total) / 1e6)}</>;
}

export function AvailableToAllocate() {
  const { snapshot, loading, error } = useTreasury();
  if (loading || error || !snapshot?.treasury) return null;
  return <span className="available-to-allocate">Available to allocate: <strong>{money(snapshot.treasury.unallocatedBalance)}</strong></span>;
}
