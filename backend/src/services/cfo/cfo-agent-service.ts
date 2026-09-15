import { getAddress } from "viem";
import type { CfoPlan } from "./action-schema.js";
import type { FamilyContext } from "./family-context-service.js";

/**
 * Safe first implementation of the agent boundary. It deliberately emits only
 * typed actions; swap this parser for an LLM adapter without changing policies.
 */
export class CfoAgentService {
  interpret(message: string, context: FamilyContext): CfoPlan {
    const text = message.trim();
    const amount = text.match(/(?:€|\$)?\s*(\d+(?:[.,]\d{1,6})?)\s*(?:usdc|usd|€|\$)/i)?.[1]?.replace(",", ".");
    const address = text.match(/0x[a-fA-F0-9]{40}/)?.[0];
    const namedVault = context.treasury.vaults.find((vault) => text.toLowerCase().includes(vault.name.toLowerCase()));
    if (!amount) throw new Error("I need a USDC amount to prepare a plan.");

    if (/(chaque|weekly|hebdo|récurr|semaine|month|mois)/i.test(text)) {
      if (!namedVault || !address) throw new Error("For a recurring payment, specify a source vault name and a recipient wallet address.");
      const intervalSeconds = /(month|mois)/i.test(text) ? 2_592_000 : 604_800;
      const firstExecutionAt = Math.floor(Date.now() / 1000) + 60;
      return { summary: `Send ${amount} USDC every ${intervalSeconds === 604_800 ? "week" : "month"}.`, actions: [{ type: "propose_scheduled_transfer", sourceVaultId: namedVault.id, recipient: getAddress(address), amount, intervalSeconds, firstExecutionAt }], requiredApprovals: namedVault.withdrawalApprovalsRequired };
    }
    if (/(envoyer|send|payer|withdraw|retirer)/i.test(text)) {
      if (!namedVault || !address) throw new Error("For a withdrawal, specify a source vault name and a recipient wallet address.");
      return { summary: `Send ${amount} USDC from ${namedVault.name}.`, actions: [{ type: "propose_withdrawal", vaultId: namedVault.id, recipient: getAddress(address), amount }], requiredApprovals: namedVault.withdrawalApprovalsRequired };
    }
    if (/(allouer|allocate|répartir)/i.test(text)) {
      if (!namedVault) throw new Error("For an allocation, name the destination vault.");
      return { summary: `Allocate ${amount} USDC to ${namedVault.name}.`, actions: [{ type: "allocate", allocations: [{ vaultId: namedVault.id, amount }] }], requiredApprovals: 1 };
    }
    throw new Error("I can prepare an allocation, a one-time payment, or a weekly/monthly payment. Please state which one you want.");
  }
}
