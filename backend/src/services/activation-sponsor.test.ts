import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { activationCredit } from "./activation-sponsor.js";

describe("activation fee coverage", () => {
  it("covers a new account and only tops up the missing amount", () => {
    expect(activationCredit(0n, 50_000_000_000n)).toBe(parseEther("0.25"));
    expect(activationCredit(parseEther("0.1"), 50_000_000_000n)).toBe(parseEther("0.15"));
    expect(activationCredit(parseEther("0.3"), 50_000_000_000n)).toBe(0n);
  });
  it("rejects an unexpectedly expensive activation", () => {
    expect(() => activationCredit(0n, 300_000_000_000n)).toThrow(/busy/);
  });
});
