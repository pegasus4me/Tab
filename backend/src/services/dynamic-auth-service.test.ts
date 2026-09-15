import { describe, expect, it } from "vitest";
import { DynamicAuthService } from "./dynamic-auth-service.js";

const wallet = "0x4fc5efd55b1c845e2e88b8431C0d018a6E5331FC";
describe("DynamicAuthService", () => {
  it("extracts verified EVM wallets from a valid Dynamic session", async () => {
    const service = new DynamicAuthService("environment", async () => ({ sub: "dynamic-user", email: "alice@example.com", verified_credentials: [{ chain: "eip155", address: wallet }] }));
    const identity = await service.authenticate("Bearer signed-token");
    expect(identity.userId).toBe("dynamic-user");
    expect(service.requireWallet(identity, wallet)).toBe(wallet);
  });
  it("rejects wallets not proven by the session", async () => {
    const service = new DynamicAuthService("environment", async () => ({ sub: "dynamic-user", verified_credentials: [{ chain: "eip155", address: wallet }] }));
    const identity = await service.authenticate("Bearer token");
    expect(() => service.requireWallet(identity, "0x0000000000000000000000000000000000000020")).toThrow("not verified");
  });
  it("rejects sessions that still require MFA", async () => {
    const service = new DynamicAuthService("environment", async () => ({ sub: "dynamic-user", scopes: ["requiresAdditionalAuth"], verified_credentials: [{ chain: "eip155", address: wallet }] }));
    await expect(service.authenticate("Bearer token")).rejects.toThrow("additional authentication");
  });
  it("does not require a particular issuer when the environment JWKS verified the signature", async () => {
    const service = new DynamicAuthService("environment", async () => ({ sub: "dynamic-user", iss: "https://app.dynamic.xyz", verified_credentials: [{ chain: "eip155", address: wallet }] }));
    await expect(service.authenticate("Bearer token")).resolves.toMatchObject({ userId: "dynamic-user" });
  });
});
