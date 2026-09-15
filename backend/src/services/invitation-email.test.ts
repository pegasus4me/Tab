import { describe, expect, it, vi } from "vitest";
import { InvitationEmailService } from "./invitation-email.js";

describe("InvitationEmailService", () => {
  it("does not claim delivery when Resend is not configured", async () => {
    expect(await new InvitationEmailService(undefined, undefined).send({ to: "sam@example.com", username: "sam", invitationUrl: "https://ours.test/#invite=token" })).toEqual({ sent: false, reason: "not_configured" });
  });
  it("sends the invitation through Resend without exposing the key in the body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    const result = await new InvitationEmailService("secret", "Ours <invites@ours.test>", fetchMock as unknown as typeof fetch).send({ to: "sam@example.com", username: "sam", invitationUrl: "https://ours.test/#invite=token" });
    expect(result).toEqual({ sent: true, id: "email-1" });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(request?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(request?.body).toContain("https://ours.test/#invite=token");
    expect(request?.body).not.toContain("secret");
  });
});
