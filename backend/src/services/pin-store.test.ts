import { describe, expect, it } from "vitest";
import { PinStore } from "./pin-store.js";

describe("PinStore", () => {
  it("does not store a PIN and verifies the correct value", async () => {
    const pins = new PinStore();
    expect(await pins.set("user", "123456")).toBe(true);
    expect(await pins.verify("user", "123456")).toEqual({ ok: true });
  });

  it("locks after five invalid attempts", async () => {
    const pins = new PinStore();
    expect(await pins.set("user", "123456")).toBe(true);
    for (let attempt = 0; attempt < 4; attempt += 1) await pins.verify("user", "000000", 1_000);
    const result = await pins.verify("user", "000000", 1_000);
    expect(result.ok).toBe(false);
    expect(result.lockedUntil).toBeDefined();
  });
});
