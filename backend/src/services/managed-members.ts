import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const AVATARS = ["mint-bear", "lilac-rabbit", "peach-cat"] as const;
export type MemberRole = "member" | "owner";
type Member = { id: string; ownerId: string; username: string; role?: MemberRole; ownerGrantedAt?: string; avatar?: string; createdAt: string; allocatedBalance: string; userId?: string; paymentAddress?: string; invitation?: { hash: string; email: string; expiresAt: number } };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const legacyAvatar = (username: string) => AVATARS[createHash("sha256").update(username).digest()[0] % AVATARS.length];

// Single-process development persistence. No wallet or spending authority is created here.
export class ManagedMembers {
  constructor(private readonly path: string) {}
  private read(): Member[] { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : []; }
  private write(members: Member[]) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(members), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
  private view(member: Member) {
    return { id: member.id, username: member.username, avatar: member.avatar ?? legacyAvatar(member.username), createdAt: member.createdAt, allocatedBalance: member.allocatedBalance, role: member.role ?? "member", ownerAccess: Boolean(member.ownerGrantedAt),
      status: member.userId ? "joined" : member.invitation && member.invitation.expiresAt > Date.now() ? "invited" : "managed" };
  }
  list(userId: string) { return this.read().filter(m => m.ownerId === userId).map(m => this.view(m)); }
  access(userId: string) { return this.read().filter(m => m.userId === userId).map(m => this.view(m)); }
  create(ownerId: string, username: string, role: MemberRole = "member") {
    const members = this.read();
    if (members.some(m => m.ownerId === ownerId && m.username.toLowerCase() === username.toLowerCase())) throw new Error("This username is already in your family.");
    const member: Member = { id: randomUUID(), ownerId, username, role, avatar: AVATARS[randomBytes(1)[0] % AVATARS.length], createdAt: new Date().toISOString(), allocatedBalance: "0" };
    members.push(member); this.write(members); return this.view(member);
  }
  setRole(ownerId: string, id: string, role: MemberRole) {
    const members = this.read(); const member = members.find(m => m.id === id && m.ownerId === ownerId);
    if (!member) throw new Error("Family member not found.");
    if (member.ownerGrantedAt && role !== "owner") throw new Error("Owner access cannot be removed from this profile yet.");
    member.role = role; this.write(members); return this.view(member);
  }
  ownerCandidate(ownerId: string, id: string) {
    const member = this.read().find(m => m.id === id && m.ownerId === ownerId);
    if (!member) throw new Error("Family member not found.");
    if (member.role !== "owner") throw new Error("Choose Owner on this profile first.");
    if (!member.userId || !member.paymentAddress) throw new Error("This member must join Ours before receiving Owner access.");
    return member;
  }
  grantOwner(ownerId: string, id: string) {
    const members = this.read(); const member = members.find(m => m.id === id && m.ownerId === ownerId);
    if (!member) throw new Error("Family member not found.");
    member.role = "owner"; member.ownerGrantedAt = new Date().toISOString(); this.write(members); return this.view(member);
  }
  invite(ownerId: string, id: string, email: string) {
    const members = this.read();
    const member = members.find(m => m.id === id && m.ownerId === ownerId);
    if (!member || member.userId) throw new Error("This profile cannot be invited.");
    const token = randomBytes(32).toString("hex");
    member.invitation = { hash: hash(token), email: email.toLowerCase(), expiresAt: Date.now() + 7 * 86400000 };
    this.write(members); return token;
  }
  get(ownerId: string, id: string) {
    const member = this.read().find(item => item.id === id && item.ownerId === ownerId);
    if (!member) throw new Error("Family member not found.");
    return this.view(member);
  }
  contacts(ownerId: string) { return this.read().filter(member => member.ownerId === ownerId && member.userId && member.paymentAddress).map(member => ({ name: member.username, address: member.paymentAddress! })); }
  accept(userId: string, email: string | undefined, token: string, paymentAddress?: string) {
    const members = this.read();
    const member = members.find(m => m.invitation?.hash === hash(token));
    if (!member?.invitation || member.invitation.expiresAt <= Date.now()) throw new Error("This invitation has expired or has already been used.");
    if (!email || member.invitation.email !== email.toLowerCase()) throw new Error("Sign in with the email this invitation was sent to.");
    if (member.ownerId === userId) throw new Error("Open this invitation with the member’s account.");
    member.userId = userId; member.paymentAddress = paymentAddress; delete member.invitation; this.write(members); return this.view(member);
  }
}
