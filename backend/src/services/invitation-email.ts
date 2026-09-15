type FetchLike = typeof fetch;

export class InvitationEmailService {
  constructor(private readonly apiKey = process.env.RESEND_API_KEY, private readonly from = process.env.RESEND_FROM_EMAIL, private readonly fetcher: FetchLike = fetch) {}
  get configured() { return Boolean(this.apiKey && this.from); }
  async send(input: { to: string; username: string; invitationUrl: string }) {
    if (!this.apiKey || !this.from) return { sent: false as const, reason: "not_configured" as const };
    const response = await this.fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "User-Agent": "Ours/1.0" },
      body: JSON.stringify({
        from: this.from, to: [input.to], subject: "You’re invited to join your family on Ours",
        text: `Hi ${input.username},\n\nYou’ve been invited to join your family on Ours.\n\nAccept your invitation: ${input.invitationUrl}\n\nThis link expires in 7 days.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#17181c"><h1 style="color:#2B2E97">Ours</h1><p>Hi ${escapeHtml(input.username)},</p><p>You’ve been invited to join your family on Ours.</p><p><a href="${escapeHtml(input.invitationUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#2B2E97;color:white;text-decoration:none">Join your family</a></p><p style="color:#666873;font-size:13px">This link expires in 7 days.</p></div>`,
      }),
    });
    if (!response.ok) throw new Error("The invitation was created, but the email could not be delivered.");
    const data = await response.json() as { id?: string };
    return { sent: true as const, id: data.id };
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}
