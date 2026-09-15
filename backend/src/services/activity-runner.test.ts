import { describe, expect, it, vi } from "vitest";
import { runActivities } from "./activity-runner.js";
import type { ActivityRecord } from "./activity-store.js";

const activity = (overrides: Partial<ActivityRecord> = {}): ActivityRecord => ({
  id: "activity-1", shareCode: "share", organizerUserId: "user", organizerName: "Alice",
  organizerAddress: "0x1", title: "Dinner", location: "Paris", startsAt: "2030-01-02T00:00:00.000Z",
  fundingDeadline: "2030-01-01T00:00:00.000Z", replacementCutoff: "2030-01-01T12:00:00.000Z",
  capacity: 2, contribution: "20", currency: "EUR", recipientName: "Restaurant", recipientAddress: "0x2",
  confirmedCount: 0, status: "collecting", termsHash: "0x3", escrowAddress: "0x4", createdAt: "2029-01-01T00:00:00.000Z",
  ...overrides,
});

describe("runActivities", () => {
  it("settles a ready activity and persists the funded state", async () => {
    const store = { all: vi.fn(() => [activity({ status: "ready" })]), syncChainState: vi.fn() };
    const chain = {
      summary: vi.fn().mockResolvedValueOnce({ state: "ready", placeCount: 2, fundingDeadline: 100 }).mockResolvedValueOnce({ state: "funded", placeCount: 2, fundingDeadline: 100 }),
      settle: vi.fn(() => ({ contractAddress: "0x4", callData: "0xsettle" })), expire: vi.fn(), simulate: vi.fn(),
    };
    const send = vi.fn().mockResolvedValue("0xhash");
    const results = await runActivities(store, chain as never, "0xrunner", send, 50);
    expect(chain.settle).toHaveBeenCalledWith("0x4");
    expect(send).toHaveBeenCalledOnce();
    expect(store.syncChainState).toHaveBeenLastCalledWith("activity-1", 2, "funded");
    expect(results[0]).toMatchObject({ action: "settle", hash: "0xhash", state: "funded" });
  });

  it("expires an underfunded activity after its deadline", async () => {
    const store = { all: vi.fn(() => [activity()]), syncChainState: vi.fn() };
    const chain = {
      summary: vi.fn().mockResolvedValueOnce({ state: "collecting", placeCount: 1, fundingDeadline: 100 }).mockResolvedValueOnce({ state: "failed", placeCount: 1, fundingDeadline: 100 }),
      settle: vi.fn(), expire: vi.fn(() => ({ contractAddress: "0x4", callData: "0xexpire" })), simulate: vi.fn(),
    };
    const results = await runActivities(store, chain as never, "0xrunner", vi.fn().mockResolvedValue("0xhash"), 100);
    expect(chain.expire).toHaveBeenCalledWith("0x4");
    expect(results[0]).toMatchObject({ action: "expire", state: "failed" });
  });

  it("only synchronizes collecting activities before their deadline", async () => {
    const store = { all: vi.fn(() => [activity()]), syncChainState: vi.fn() };
    const chain = { summary: vi.fn().mockResolvedValue({ state: "collecting", placeCount: 1, fundingDeadline: 100 }), settle: vi.fn(), expire: vi.fn(), simulate: vi.fn() };
    const send = vi.fn();
    const results = await runActivities(store, chain as never, "0xrunner", send, 99);
    expect(send).not.toHaveBeenCalled();
    expect(store.syncChainState).toHaveBeenCalledWith("activity-1", 1, "collecting");
    expect(results[0]).toMatchObject({ state: "collecting" });
  });
});
