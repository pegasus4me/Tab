import { indexer } from "envio";

const activityId = (address: string) => address.toLowerCase();
const placeId = (address: string, id: bigint) => `${activityId(address)}:${id}`;

indexer.contractRegister(
  { contract: "ActivityEscrowFactory", event: "ActivityCreated" },
  async ({ event, context }) => { context.chain.ActivityEscrow.add(event.params.escrow); },
);

indexer.onEvent(
  { contract: "ActivityEscrowFactory", event: "ActivityCreated" },
  async ({ event, context }) => {
    context.IndexedActivity.set({ id: activityId(event.params.escrow), activityKey: event.params.activityId,
      organizer: event.params.organizer, status: "collecting", participantCount: 0n, recipient: undefined, totalAmount: 0n,
      createdAt: BigInt(event.block.timestamp), updatedAt: BigInt(event.block.timestamp) });
  },
);

indexer.onEvent({ contract: "ActivityEscrow", event: "Joined" }, async ({ event, context }) => {
  const id = activityId(event.srcAddress); const activity = await context.IndexedActivity.get(id); if (!activity) return;
  context.IndexedActivity.set({ ...activity, participantCount: event.params.placeId + 1n, totalAmount: activity.totalAmount + event.params.amount, updatedAt: BigInt(event.block.timestamp) });
  context.IndexedPlace.set({ id: placeId(event.srcAddress, event.params.placeId), activity_id: id, placeId: event.params.placeId,
    owner: event.params.participant, amount: event.params.amount, offerNonce: 0n, refunded: false, updatedAt: BigInt(event.block.timestamp) });
});

indexer.onEvent({ contract: "ActivityEscrow", event: "Ready" }, async ({ event, context }) => {
  const id = activityId(event.srcAddress); const activity = await context.IndexedActivity.get(id); if (activity) context.IndexedActivity.set({ ...activity, status: "ready", participantCount: event.params.participantCount, totalAmount: event.params.totalAmount, updatedAt: BigInt(event.block.timestamp) });
});
indexer.onEvent({ contract: "ActivityEscrow", event: "Settled" }, async ({ event, context }) => {
  const id = activityId(event.srcAddress); const activity = await context.IndexedActivity.get(id); if (activity) context.IndexedActivity.set({ ...activity, status: "funded", recipient: event.params.recipient, totalAmount: event.params.amount, updatedAt: BigInt(event.block.timestamp) });
});
indexer.onEvent({ contract: "ActivityEscrow", event: "Expired" }, async ({ event, context }) => {
  const id = activityId(event.srcAddress); const activity = await context.IndexedActivity.get(id); if (activity) context.IndexedActivity.set({ ...activity, status: "failed", updatedAt: BigInt(event.block.timestamp) });
});
indexer.onEvent({ contract: "ActivityEscrow", event: "Cancelled" }, async ({ event, context }) => {
  const id = activityId(event.srcAddress); const activity = await context.IndexedActivity.get(id); if (activity) context.IndexedActivity.set({ ...activity, status: "cancelled", updatedAt: BigInt(event.block.timestamp) });
});
indexer.onEvent({ contract: "ActivityEscrow", event: "Refunded" }, async ({ event, context }) => {
  const id = placeId(event.srcAddress, event.params.placeId); const place = await context.IndexedPlace.get(id); if (place) context.IndexedPlace.set({ ...place, refunded: true, updatedAt: BigInt(event.block.timestamp) });
});
indexer.onEvent({ contract: "ActivityEscrow", event: "Replaced" }, async ({ event, context }) => {
  const id = placeId(event.srcAddress, event.params.placeId); const place = await context.IndexedPlace.get(id); if (place) context.IndexedPlace.set({ ...place, owner: event.params.newOwner, offerNonce: place.offerNonce + 1n, updatedAt: BigInt(event.block.timestamp) });
});
indexer.onEvent({ contract: "ActivityEscrow", event: "OfferInvalidated" }, async ({ event, context }) => {
  const id = placeId(event.srcAddress, event.params.placeId); const place = await context.IndexedPlace.get(id); if (place) context.IndexedPlace.set({ ...place, offerNonce: event.params.newNonce, updatedAt: BigInt(event.block.timestamp) });
});
