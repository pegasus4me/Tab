/** Infrastructure identifiers never belong in the consumer-facing experience. */
export function customerText(value: string) {
  return value
    .replace(/\b0x[a-fA-F0-9]{40,}\b/g, "linked account")
    .replace(/\bUSDC\b/gi, "dollars")
    .replace(/\b(?:Monad(?: Testnet)?|blockchain|onchain|on-chain|testnet|mainnet|EVM)\b/gi, "payment system")
    .replace(/\bwallets?\b/gi, "account")
    .replace(/\bcalldata\b/gi, "payment details");
}
export function customerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/could not find network mapping|network switching is not supported|chain.*not configured/i.test(message)) return "Your account connection needs an update. Refresh Ours and try again.";
  if (/insufficient funds|exceeds (the )?balance|not enough.*gas/i.test(message)) return "Ours couldn't cover the setup fees yet. Please try again shortly.";
  if (/user rejected|user denied|request rejected/i.test(message)) return "Setup was cancelled. You can try again when you're ready.";
  if (/0x[a-fA-F0-9]{8,}|rpc|gas|nonce|ABI|contract|OPENAI_|Dynamic|JSON|fetch|chainId|signature|network|transaction|simulation/i.test(message)) return "We couldn't complete this operation. Check its status before trying again.";
  return customerText(message);
}
export function money(value: string | number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(Number(value));
}
