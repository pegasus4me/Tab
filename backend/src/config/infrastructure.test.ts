import { describe, expect, it } from "vitest";
import { createInfrastructure } from "./infrastructure.js";

describe("createInfrastructure", () => {
  it("selects Monad testnet, Dynamic and official test USDC", () => {
    const config = createInfrastructure({
      OURS_NETWORK: "monad-testnet",
      DYNAMIC_ENVIRONMENT_ID: "dynamic-environment",
    });

    expect(config.networkName).toBe("monad-testnet");
    expect(config.chain.id).toBe(10_143);
    expect(config.dynamicEnvironmentId).toBe("dynamic-environment");
    expect(config.usdcAddress).toBe("0x534b2f3A21130d7a60830c2Df862319e593943A3");
    expect(config.activityFactoryAddress).toBe("0x5fF998765AC633C40AD904085Df5903244f70789");
  });

  it("selects Monad mainnet, live credentials and official mainnet USDC", () => {
    const config = createInfrastructure({
      OURS_NETWORK: "monad-mainnet",
      MOONPAY_API_KEY: "moonpay-live-key",
    });

    expect(config.chain.id).toBe(143);
    expect(config.usdcAddress).toBe("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
    expect(config.moonPay.enabled).toBe(true);
  });

  it("enables MoonPay sandbox funding on testnet when a Platform key is present", () => {
    const config = createInfrastructure({ OURS_NETWORK: "monad-testnet", MOONPAY_API_KEY: "moonpay-key" });
    expect(config.moonPay.enabled).toBe(true);
  });

  it("rejects an unknown network before any transaction can be built", () => {
    expect(() => createInfrastructure({ OURS_NETWORK: "wrong-chain" }))
      .toThrow("OURS_NETWORK must be monad-testnet or monad-mainnet.");
  });

  it("keeps Dynamic optional for contract-only tooling", () => {
    const config = createInfrastructure({ OURS_NETWORK: "monad-testnet" });
    expect(config.dynamicEnvironmentId).toBeUndefined();
  });

  it("configures the Count Me In activity factory independently", () => {
    const config = createInfrastructure({ COUNT_ME_IN_FACTORY_ADDRESS: "0x0000000000000000000000000000000000000010" });
    expect(config.activityFactoryAddress).toBe("0x0000000000000000000000000000000000000010");
  });

  it("gives the embedded account the execution network without exposing server credentials", () => {
    for (const network of ["monad-testnet", "monad-mainnet"]) {
      const config = createInfrastructure({ OURS_NETWORK: network, MONAD_RPC_URL: "https://private.example/secret-key" });
      expect(config.walletNetwork.chainId).toBe(config.chain.id);
      expect(config.walletNetwork.networkId).toBe(config.chain.id);
      expect(config.walletNetwork.nativeCurrency.decimals).toBe(18);
      expect(JSON.stringify(config.walletNetwork)).not.toContain("secret-key");
    }
  });
});
