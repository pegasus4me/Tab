import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MoonPayService } from "./moonpay-service.js";

describe("MoonPayService", () => {
  const config = { enabled: true, apiKey: "secret", publishableKey: "pk_test", webhookApiKey: "webhook-secret", baseUrl: "https://moonpay.test" };

  it("creates a server-side session without exposing the API key to callers", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionToken: "short-lived", expiresAt: "soon" }), { status: 200 }));
    const result = await new MoonPayService(config, request).createSession({ externalCustomerId: "dynamic-user", deviceIp: "127.0.0.1" });
    expect(result.sessionToken).toBe("short-lived");
    expect(request.mock.calls[0][1].headers["X-Api-Key"]).toBe("secret");
  });
  it("detects exact settlement asset support without substituting another network", async () => {
    const currencies = JSON.stringify([
      { code: "usdc_eth", isSellSupported: true, metadata: { chainId: "1", contractAddress: "0xabc" } },
      { code: "usdc_monad", isSellSupported: true, metadata: { chainId: "143", contractAddress: "0xdef" } },
    ]);
    const request = vi.fn().mockImplementation(async () => new Response(currencies, { status: 200 }));
    const service = new MoonPayService(config, request);
    await expect(service.settlementAssetSupport(143, "0xdef")).resolves.toMatchObject({ assetCode: "usdc_monad", onRamp: true, offRamp: true });
    await expect(service.settlementAssetSupport(10143, "0xdef")).resolves.toMatchObject({ onRamp: false, offRamp: false });
  });

  it("accepts only a correctly signed webhook payload", () => {
    const body = Buffer.from('{"id":"tx_1"}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", "webhook-secret").update(`${timestamp}.${body}`).digest("hex");
    const service = new MoonPayService(config);
    expect(service.verifyWebhook(`t=${timestamp},s=${signature}`, body)).toBe(true);
    expect(service.verifyWebhook(`t=${timestamp},s=deadbeef`, body)).toBe(false);
    expect(service.verifyWebhook(`t=${timestamp},s=${signature}`, body, (Number(timestamp) + 301) * 1000)).toBe(false);
  });
});
