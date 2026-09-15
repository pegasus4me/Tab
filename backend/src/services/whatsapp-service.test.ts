import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppService } from "./whatsapp-service.js";

describe("WhatsAppService", () => {
  it("verifies Meta webhook challenges and signed callbacks", () => {
    const service = new WhatsAppService({ verifyToken: "verify", appSecret: "secret" });
    const body = Buffer.from('{"entry":[]}');
    expect(service.verifyWebhook("subscribe", "verify", "challenge")).toBe("challenge");
    expect(service.verifySignature(`sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`, body)).toBe(true);
    expect(service.verifySignature("sha256=bad", body)).toBe(false);
  });
  it("does not send before Meta credentials are configured", async () => {
    const service = new WhatsAppService({}, vi.fn() as unknown as typeof fetch);
    await expect(service.sendInvitation("33600000000", { title: "Foot", startsAt: "2026-09-16T18:00:00.000Z", contribution: "12.00", shareUrl: "https://tab.test/a" })).resolves.toEqual({ sent: false, reason: "not_configured" });
  });
});
