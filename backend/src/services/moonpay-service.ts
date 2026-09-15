import { createHmac, timingSafeEqual } from "node:crypto";

type MoonPayConfig = {
  enabled: boolean;
  apiKey?: string;
  publishableKey?: string;
  webhookApiKey?: string;
  baseUrl: string;
};

export type MoonPaySession = {
  sessionToken: string;
  expiresAt?: string;
};

/**
 * Server-only MoonPay boundary. The PWA receives only a short-lived session
 * token, never a MoonPay secret or webhook credential.
 */
export class MoonPayService {
  constructor(private readonly config: MoonPayConfig, private readonly request = fetch) {}

  async createSession(input: { externalCustomerId: string; deviceIp: string }): Promise<MoonPaySession> {
    if (!this.config.enabled || !this.config.apiKey) {
      throw new Error("MoonPay funding is not enabled for this environment.");
    }

    const response = await this.request(`${this.config.baseUrl}/platform/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": this.config.apiKey },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("MoonPay could not start funding. Please try again.");

    const payload = await response.json() as { sessionToken?: string; token?: string; expiresAt?: string };
    const sessionToken = payload.sessionToken ?? payload.token;
    if (!sessionToken) throw new Error("MoonPay returned an invalid funding session.");
    return { sessionToken, expiresAt: payload.expiresAt };
  }

  async settlementAssetSupport(chainId: number, contractAddress: string) {
    if (!this.config.publishableKey) return { onRamp: false, offRamp: false, reason: "MoonPay publishable key is not configured." };
    const url = new URL("/v3/currencies", this.config.baseUrl);
    url.searchParams.set("apiKey", this.config.publishableKey);
    const response = await this.request(url);
    if (!response.ok) throw new Error("MoonPay asset availability could not be checked.");
    const payload = await response.json() as unknown;
    const currencies = Array.isArray(payload) ? payload : (payload as { currencies?: unknown[] }).currencies ?? [];
    const expected = contractAddress.toLowerCase();
    const asset = currencies.find((value) => {
      const currency = value as { metadata?: { chainId?: string; contractAddress?: string } };
      return String(currency.metadata?.chainId) === String(chainId) && String(currency.metadata?.contractAddress).toLowerCase() === expected;
    }) as { code?: string; isBuySupported?: boolean; isSellSupported?: boolean } | undefined;
    if (!asset?.code) return { onRamp: false, offRamp: false, reason: "MoonPay does not currently list the configured settlement asset on this network." };
    return { assetCode: asset.code, onRamp: asset.isBuySupported !== false, offRamp: asset.isSellSupported === true };
  }

  verifyWebhook(signatureHeader: string | undefined, body: Buffer, now = Date.now()) {
    if (!this.config.webhookApiKey) throw new Error("MoonPay webhook verification is not configured.");
    if (!signatureHeader) return false;

    const fields = Object.fromEntries(signatureHeader.split(",").map((part) => part.trim().split("=", 2)));
    const timestamp = fields.t;
    const signature = fields.s;
    if (!timestamp || !signature || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;

    const expected = createHmac("sha256", this.config.webhookApiKey)
      .update(`${timestamp}.${body.toString("utf8")}`)
      .digest("hex");
    const supplied = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return supplied.length === expectedBuffer.length && timingSafeEqual(supplied, expectedBuffer);
  }
}
