import { createHmac, timingSafeEqual } from "node:crypto";

export type WhatsAppConfig = { accessToken?: string; phoneNumberId?: string; verifyToken?: string; appSecret?: string; apiVersion?: string };

/** Meta WhatsApp Cloud API adapter. It is inert until all outbound credentials exist. */
export class WhatsAppService {
  constructor(private readonly config: WhatsAppConfig, private readonly fetcher: typeof fetch = fetch) {}
  get configured() { return Boolean(this.config.accessToken && this.config.phoneNumberId); }
  verifyWebhook(mode: string | undefined, token: string | undefined, challenge: string | undefined) {
    return mode === "subscribe" && Boolean(challenge) && Boolean(this.config.verifyToken) && token === this.config.verifyToken ? challenge : undefined;
  }
  verifySignature(signature: string | undefined, body: Buffer) {
    if (!this.config.appSecret || !signature?.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", this.config.appSecret).update(body).digest("hex");
    const received = signature.slice("sha256=".length);
    return received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  }
  async sendInvitation(to: string, activity: { title: string; startsAt: string; contribution: string; shareUrl: string }) {
    if (!this.configured) return { sent: false as const, reason: "not_configured" };
    const response = await this.fetcher(`https://graph.facebook.com/${this.config.apiVersion ?? "v24.0"}/${this.config.phoneNumberId}/messages`, {
      method: "POST", headers: { Authorization: `Bearer ${this.config.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: "count_me_in_activity_invite", language: { code: "fr" }, components: [{ type: "body", parameters: [
        { type: "text", text: activity.title }, { type: "text", text: new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(activity.startsAt)) },
        { type: "text", text: `${activity.contribution} €` }, { type: "text", text: activity.shareUrl },
      ] }] } }),
    });
    if (!response.ok) throw new Error("WhatsApp could not deliver the invitation.");
    return { sent: true as const, providerId: (await response.json() as { messages?: Array<{ id?: string }> }).messages?.[0]?.id };
  }
}
