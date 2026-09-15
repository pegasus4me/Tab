import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedMembers } from "./managed-members.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
function setup() { const dir = mkdtempSync(join(tmpdir(), "ours-members-")); dirs.push(dir); return join(dir, "members.json"); }
describe("managed family profiles", () => {
  it("persists zero allocations, isolates parents and rejects duplicate usernames", () => {
    const file = setup(); const store = new ManagedMembers(file);
    const member = store.create("parent", "alex");
    expect(member.allocatedBalance).toBe("0");
    expect(["mint-bear", "lilac-rabbit", "peach-cat"]).toContain(member.avatar);
    expect(member).not.toHaveProperty("address");
    expect(new ManagedMembers(file).list("parent")).toEqual([member]);
    expect(store.list("other")).toEqual([]);
    expect(() => store.create("parent", "Alex")).toThrow();
    expect(() => store.invite("other", member.id, "alex@example.com")).toThrow();
  });
  it("binds invitations to email, consumes them once and preserves the profile", () => {
    const store = new ManagedMembers(setup()); const member = store.create("parent", "alex");
    const old = store.invite("parent", member.id, "alex@example.com");
    const token = store.invite("parent", member.id, "alex@example.com");
    expect(() => store.accept("child", "alex@example.com", old)).toThrow();
    expect(() => store.accept("child", "wrong@example.com", token)).toThrow();
    expect(store.accept("child", "alex@example.com", token)).toMatchObject({ id: member.id, status: "joined", allocatedBalance: "0" });
    expect(() => store.accept("child", "alex@example.com", token)).toThrow();
    expect(store.access("child")).toHaveLength(1);
    expect(store.list("child")).toEqual([]);
    expect(JSON.stringify(store.list("parent"))).not.toContain("hash");
  });
  it("grants Owner access only after the selected member joins", () => {
    const store = new ManagedMembers(setup()); const member = store.create("parent", "sam", "owner");
    expect(member).toMatchObject({ role: "owner", ownerAccess: false });
    expect(() => store.ownerCandidate("parent", member.id)).toThrow();
    const token = store.invite("parent", member.id, "sam@example.com");
    store.accept("sam-user", "sam@example.com", token, "0x0000000000000000000000000000000000000001");
    expect(store.ownerCandidate("parent", member.id).paymentAddress).toBe("0x0000000000000000000000000000000000000001");
    expect(store.grantOwner("parent", member.id)).toMatchObject({ role: "owner", ownerAccess: true });
    expect(() => store.setRole("parent", member.id, "member")).toThrow();
  });
});
