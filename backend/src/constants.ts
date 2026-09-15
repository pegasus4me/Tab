import type { Address } from "viem";

export const CONSTANTS = {
  networks: {
    "monad-testnet": {
      chainId: 10_143,
      rpcUrl: "https://testnet-rpc.monad.xyz",
      usdcAddress: "0x534b2f3A21130d7a60830c2Df862319e593943A3" as Address,
      activityFactoryAddress: "0x5fF998765AC633C40AD904085Df5903244f70789" as Address,
      activityFactoryDeployer: "0x54D946760093fd5756c3EA4b9CCAE047c0ad4411" as Address,
    },
    "monad-mainnet": {
      chainId: 143,
      rpcUrl: "https://rpc.monad.xyz",
      usdcAddress: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as Address,
      activityFactoryAddress: undefined,
      activityFactoryDeployer: undefined,
    },
  },
  nativeCurrency: {
    name: "Monad",
    symbol: "MON",
    decimals: 18,
  },
} as const;

export type NetworkName = keyof typeof CONSTANTS.networks;
