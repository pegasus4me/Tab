import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./styles.css";

const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:8787";
async function start() {
  const response = await fetch(`${apiUrl}/wallet/config`);
  if (!response.ok) throw new Error("Ours sign-in is not configured yet.");
  const config = await response.json() as {
    environmentId: string;
    chainId: number;
    evmNetwork: {
      chainId: number; networkId: number; name: string; isTestnet: boolean;
      nativeCurrency: { name: string; symbol: string; decimals: number };
      rpcUrls: string[]; blockExplorerUrls: string[]; iconUrls: string[];
    };
  };
  if (!config.evmNetwork || config.evmNetwork.chainId !== config.chainId) throw new Error("Account connection needs an update. Please refresh shortly.");
  createRoot(document.getElementById("root")!).render(<StrictMode><DynamicContextProvider settings={{ environmentId: config.environmentId, walletConnectors: [EthereumWalletConnectors], walletsFilter: () => [], overrides: { evmNetworks: [config.evmNetwork] } }}><App apiUrl={apiUrl} /></DynamicContextProvider></StrictMode>);
}
start().catch((error: Error) => createRoot(document.getElementById("root")!).render(<main className="center-state"><p>Count Me In</p><h1>Connexion indisponible</h1><span>{error.message}</span></main>));
registerSW({ immediate: true });
