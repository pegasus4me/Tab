import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActivityStore } from "./activity-store.js";

describe("ActivityStore", () => {
  it("creates a private organizer record with a public opaque share code", () => {
    const store = new ActivityStore(join(mkdtempSync(join(tmpdir(), "count-me-in-")), "activities.json"));
    const activity = store.create({
      id: "9d3b7830-f723-4eb6-a672-2986b34c9a40", organizerUserId: "user-1", organizerName: "Kamel", organizerAddress: "0x0000000000000000000000000000000000000010", title: "Foot à 5",
      location: "UrbanSoccer", startsAt: "2026-09-20T18:00:00.000Z",
      fundingDeadline: "2026-09-19T18:00:00.000Z", replacementCutoff: "2026-09-20T18:00:00.000Z", capacity: 10,
      contribution: "12.00", currency: "EUR", recipientName: "UrbanSoccer", recipientAddress: "0x0000000000000000000000000000000000000020", termsHash: "0xabc",
    });
    expect(activity.shareCode).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(store.byShareCode(activity.shareCode)?.title).toBe("Foot à 5");
    expect(store.listForOrganizer("user-1")).toHaveLength(1);
    expect(store.listForOrganizer("other")).toHaveLength(0);
    expect(activity.status).toBe("deployment_pending");
    expect(store.confirmDeployment(activity.id, "0x0000000000000000000000000000000000000030", "0xhash").status).toBe("collecting");
  });
});
