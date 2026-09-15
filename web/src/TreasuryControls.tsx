import { customerError, customerText, money } from "./financial-display";
import { useState } from "react";
import { useTreasury } from "./treasury";

export function TreasuryControls() {
  const treasury = useTreasury();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(operation: () => Promise<unknown>) { setBusy(true); setError(""); try { await operation(); } catch (reason) { setError(customerError(reason)); } finally { setBusy(false); } }
  const disabled = busy || treasury.busy;
  if (treasury.loading) return <p role="status">Loading your treasury…</p>;
  if (treasury.error) return <section className="treasury-controls"><p role="alert">{treasury.error}</p><button onClick={() => void run(treasury.reload)}>Retry</button></section>;
  if (!treasury.snapshot?.treasury) return null;
  const { snapshot } = treasury;
  const pending = snapshot.treasury!.withdrawals.filter(item => !item.executed);
  const schedules = snapshot.treasury!.scheduledTransfers;
  if (pending.length === 0 && schedules.length === 0 && !error) return null;
  return <section className="treasury-controls">{pending.map(item => <article key={`withdrawal-${item.id}`}><strong>Payment of {money(item.amount)}</strong><p>To {item.recipientName ?? "Recipient not identified"}</p><p>{item.approvals} approval(s) received</p><button className="cfo-action" disabled={disabled || !item.recipientName} onClick={() => void run(() => treasury.perform({ type: "approve_withdrawal", proposalId: item.id }))}>Approve payment</button></article>)}{schedules.map(item => <article key={`schedule-${item.id}`}><strong>{money(item.amount)} every {Math.round(item.intervalSeconds / 86400)} days</strong><p>{item.active ? `Next payment: ${new Date(item.nextExecutionAt * 1000).toLocaleString()}` : `${item.approvals} approval(s), awaiting activation`}</p>{!item.active ? <button className="cfo-action" disabled={disabled} onClick={() => void run(() => treasury.perform({ type: "approve_scheduled_transfer", scheduleId: item.id }))}>Approve schedule</button> : item.nextExecutionAt * 1000 <= Date.now() && <button className="cfo-action" disabled={disabled} onClick={() => void run(() => treasury.perform({ type: "execute_scheduled_transfer", scheduleId: item.id }))}>Execute due payment</button>}</article>)}{error && <p role="alert">{error}</p>}</section>;
}

export function PlanCards() {
  const treasury = useTreasury();
  const [error, setError] = useState("");
  const labels: Record<string, string> = { ready_for_confirmation: "Ready for your review", confirmed: "Awaiting your confirmation", submitted: "Checking confirmation", executed: "Operation recorded — check any remaining family approvals", reverted: "Operation failed", rejected: "Blocked by family rules" };
  return <div className="cfo-plans">{treasury.snapshot?.plans.slice().reverse().map(plan => <article className="cfo-plan-card" key={plan.id}><small>{labels[plan.status] ?? plan.status}</small><h3>{customerText(plan.plan?.summary ?? "")}</h3><p>{customerText(plan.explanation)}</p><PlanDetails actions={plan.plan?.actions ?? []} />{plan.policyIssues.map(issue => <p key={issue} role="alert">{customerText(issue)}</p>)}{["ready_for_confirmation", "confirmed", "submitted"].includes(plan.status) && <button className="cfo-action" disabled={treasury.busy} onClick={() => { setError(""); void treasury.confirm(plan).catch(reason => setError(customerError(reason))); }}>{treasury.busy ? "Processing…" : plan.status === "submitted" ? "Check confirmation" : "Confirm proposal"}</button>}</article>)}{error && <p role="alert">{error}</p>}</div>;
}

function PlanDetails({ actions }: { actions: NonNullable<import("./treasury").Plan["plan"]>["actions"] }) {
  const { snapshot } = useTreasury();
  const vaultName = (id?: number) => snapshot?.treasury?.vaults.find(vault => vault.id === id)?.name ?? "Family funds";
  return <div>{actions.map((action, index) => <div key={index}>{action.type === "allocate" ? <ul>{action.allocations?.map((item, i) => <li key={i}>{money(item.amount)} → {vaultName(item.vaultId)}</li>)}</ul> : <><p>{money(action.amount ?? "0")} from {vaultName(action.vaultId ?? action.sourceVaultId)}</p><p>To {action.recipientName ?? (action.destinationVaultId !== undefined ? vaultName(action.destinationVaultId) : "a linked family member")}</p>{action.type === "propose_scheduled_transfer" && <p>Every {Math.round((action.intervalSeconds ?? 0) / 86400)} days, starting {new Date((action.firstExecutionAt ?? 0) * 1000).toLocaleString()}</p>}</>}</div>)}</div>;
}
