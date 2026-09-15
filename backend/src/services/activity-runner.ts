import type { ActivityRecord, ActivityStore } from "./activity-store.js";
import type { ActivityEscrowClient } from "./chain/activity-escrow-client.js";
import type { ContractCall } from "./chain/contract-call.js";

type ChainState = Exclude<ActivityRecord["status"], "deployment_pending">;
type ActivityChain = Pick<ActivityEscrowClient, "summary" | "settle" | "expire" | "simulate">;

export type ActivityRunResult = {
  activityId: string;
  action?: "settle" | "expire";
  hash?: string;
  state?: ChainState;
  error?: string;
};

/** Reconciles every deployed activity and executes permissionless lifecycle transitions. */
export async function runActivities(
  store: { all(): ActivityRecord[] | Promise<ActivityRecord[]>; syncChainState(id: string, confirmedCount: number, status: ChainState): unknown | Promise<unknown> },
  chain: ActivityChain,
  account: string,
  send: (call: ContractCall) => Promise<string>,
  now = Math.floor(Date.now() / 1000),
) {
  const results: ActivityRunResult[] = [];
  for (const activity of await store.all()) {
    if (!activity.escrowAddress || activity.status === "deployment_pending") continue;
    try {
      let summary = await chain.summary(activity.escrowAddress);
      await store.syncChainState(activity.id, summary.placeCount, summary.state);

      const action = summary.state === "ready"
        ? "settle"
        : summary.state === "collecting" && summary.fundingDeadline <= now
          ? "expire"
          : undefined;
      if (!action) {
        results.push({ activityId: activity.id, state: summary.state });
        continue;
      }

      const call = action === "settle" ? chain.settle(activity.escrowAddress) : chain.expire(activity.escrowAddress);
      await chain.simulate(call, account);
      const hash = await send(call);
      summary = await chain.summary(activity.escrowAddress);
      await store.syncChainState(activity.id, summary.placeCount, summary.state);
      results.push({ activityId: activity.id, action, hash, state: summary.state });
    } catch {
      results.push({ activityId: activity.id, error: "Unable to reconcile or advance activity." });
    }
  }
  return results;
}
