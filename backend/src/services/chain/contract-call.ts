import type { Address, Hex } from "viem";

/** A pre-validated contract call that a user-owned smart account may sign. */
export type ContractCall = { contractAddress: Address; callData: Hex };
