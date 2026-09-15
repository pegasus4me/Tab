import { defineChain, getAddress } from "viem";
import { CONSTANTS, type NetworkName } from "../constants.js";

export type { NetworkName } from "../constants.js";

export function createInfrastructure(env: NodeJS.ProcessEnv) {
  const networkName = (env.OURS_NETWORK ?? env.TAB_NETWORK ?? "monad-testnet") as NetworkName;
  if (networkName !== "monad-testnet" && networkName !== "monad-mainnet") {
    throw new Error("OURS_NETWORK must be monad-testnet or monad-mainnet.");
  }

  const selected = CONSTANTS.networks[networkName];
  const rpcUrl = env.MONAD_RPC_URL ?? selected.rpcUrl;
  const activityFactoryAddress = env.COUNT_ME_IN_FACTORY_ADDRESS ?? selected.activityFactoryAddress;
  const envioIndexerEndpoint = env.ENVIO_INDEXER_ENDPOINT;
  if (envioIndexerEndpoint) new URL(envioIndexerEndpoint);
  return {
    networkName,
    usdcAddress: getAddress(selected.usdcAddress),
    dynamicEnvironmentId: env.DYNAMIC_ENVIRONMENT_ID,
    // Browser-safe configuration: never expose a private server RPC URL/key.
    walletNetwork: {
      chainId: selected.chainId,
      networkId: selected.chainId,
      name: networkName === "monad-mainnet" ? "Monad" : "Monad Testnet",
      isTestnet: networkName === "monad-testnet",
      nativeCurrency: CONSTANTS.nativeCurrency,
      rpcUrls: [selected.rpcUrl],
      blockExplorerUrls: [] as string[],
      iconUrls: [] as string[],
    },
    moonPay: {
      enabled: Boolean(env.MOONPAY_SECRET_KEY ?? env.MOONPAY_API_KEY),
      apiKey: env.MOONPAY_SECRET_KEY ?? env.MOONPAY_API_KEY,
      publishableKey: env.MOONPAY_PUBLISHABLE_KEY,
      webhookApiKey: env.MOONPAY_WEBHOOK_API_KEY,
      baseUrl: env.MOONPAY_API_BASE_URL ?? "https://api.moonpay.com",
    },
    factoryAddress: (env.OURS_FACTORY_ADDRESS ?? env.TAB_FACTORY_ADDRESS)
      ? getAddress(env.OURS_FACTORY_ADDRESS ?? env.TAB_FACTORY_ADDRESS!)
      : undefined,
    activityFactoryAddress: activityFactoryAddress ? getAddress(activityFactoryAddress) : undefined,
    envioIndexerEndpoint,
    chain: defineChain({
      id: selected.chainId,
      name: networkName === "monad-mainnet" ? "Monad" : "Monad Testnet",
      nativeCurrency: CONSTANTS.nativeCurrency,
      rpcUrls: { default: { http: [rpcUrl] } },
    }),
    rpcUrl,
  };
}

export type Infrastructure = ReturnType<typeof createInfrastructure>;
export const infrastructure = createInfrastructure(process.env);
