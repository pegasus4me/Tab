import { getAddress, parseUnits } from "viem";
import type { CfoPlan } from "./action-schema.js";
import type { FamilyContext } from "./family-context-service.js";

export class PolicyValidator {
  validate(plan: CfoPlan, context: FamilyContext) {
    const issues: string[] = [];
    let approvals = 1;
    if (plan.actions.length !== 1) issues.push("Confirm one operation at a time.");
    for (const action of plan.actions) {
      if ("recipient" in action && action.recipient && context.contacts && !context.contacts.some(contact => contact.address.toLowerCase() === action.recipient!.toLowerCase())) issues.push("Invite this recipient to Ours before preparing a payment.");
    }
    const vaultFor = (id: number) => context.treasury.vaults.find((vault) => vault.id === id);
    const committed = (vaultId: number) => {
      const withdrawals = context.treasury.withdrawals.filter(item => item.vaultId === vaultId && !item.executed).reduce((sum, item) => sum + parseUnits(item.amount, 6), 0n);
      const recurring = context.treasury.scheduledTransfers.filter(item => item.sourceVaultId === vaultId && item.active).reduce((sum, item) => sum + parseUnits(item.amount, 6), 0n);
      return withdrawals + recurring;
    };
    for (const action of plan.actions) {
      if (action.type === "allocate") {
        const total = action.allocations.reduce((sum, item) => sum + parseUnits(item.amount, 6), 0n);
        if (total > parseUnits(context.treasury.unallocatedBalance, 6)) issues.push("The allocation exceeds the unallocated USDC balance.");
        for (const allocation of action.allocations) if (!vaultFor(allocation.vaultId)) issues.push(`Vault ${allocation.vaultId} does not exist.`);
      }
      if (action.type === "propose_withdrawal") {
        const vault = vaultFor(action.vaultId);
        if (!vault) { issues.push(`Vault ${action.vaultId} does not exist.`); continue; }
        try { getAddress(action.recipient); } catch { issues.push("The withdrawal recipient is not a valid EVM address."); }
        if (parseUnits(action.amount, 6) > parseUnits(vault.balance, 6) - parseUnits(vault.floor, 6)) issues.push(`This withdrawal would breach the ${vault.name} vault floor.`);
        if (parseUnits(action.amount, 6) + committed(vault.id) > parseUnits(vault.balance, 6) - parseUnits(vault.floor, 6)) issues.push(`This payment leaves insufficient funds for protected reserves and existing commitments in ${vault.name}.`);
        approvals = Math.max(approvals, vault.withdrawalApprovalsRequired);
      }
      if (action.type === "propose_scheduled_transfer") {
        const source = vaultFor(action.sourceVaultId);
        if (!source) { issues.push(`Vault ${action.sourceVaultId} does not exist.`); continue; }
        if (action.destinationVaultId !== undefined && (!vaultFor(action.destinationVaultId) || action.destinationVaultId === action.sourceVaultId)) issues.push("The scheduled transfer must use a different existing destination vault.");
        if (action.recipient) try { getAddress(action.recipient); } catch { issues.push("The scheduled-transfer recipient is not a valid EVM address."); }
        if (action.firstExecutionAt < Math.floor(Date.now() / 1000)) issues.push("The first scheduled execution must be in the future.");
        if (parseUnits(action.amount, 6) > parseUnits(source.balance, 6) - parseUnits(source.floor, 6)) issues.push(`The first transfer would breach the ${source.name} vault floor.`);
        if (parseUnits(action.amount, 6) + committed(source.id) > parseUnits(source.balance, 6) - parseUnits(source.floor, 6)) issues.push(`This schedule leaves insufficient funds for protected reserves and existing commitments in ${source.name}.`);
        approvals = Math.max(approvals, source.withdrawalApprovalsRequired);
      }
    }
    if (plan.requiredApprovals !== approvals) issues.push(`The plan must require ${approvals} approval${approvals === 1 ? "" : "s"}.`);
    return { ok: issues.length === 0, issues, requiredApprovals: approvals };
  }
}
