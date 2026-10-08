import { backoffMs } from "./importer";
import type { Channel } from "./types";

export interface Providers {
  twilio?: { accountSid: string; authToken: string; smsFrom: string; whatsappFrom: string };
  resend?: { apiKey: string; from: string };
}

export type SendResult = { ok: true; providerId: string } | { ok: false; error: string; retryable: boolean } | { ok: "skipped"; reason: string };

/** Pick the provider for a channel and send. Never throws: failures are data. */
export async function sendOutbound(
  p: Providers,
  m: { channel: Channel; to: string; body: string; subject?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    if (m.channel === "email") {
      if (!p.resend) return { ok: "skipped", reason: "No email provider configured (set RESEND_API_KEY)" };
      const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${p.resend.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: p.resend.from, to: [m.to], subject: m.subject ?? "Re: your message", text: m.body }),
      });
      return await result(res);
    }
    if (!p.twilio) return { ok: "skipped", reason: "No Twilio credentials configured" };
    const t = p.twilio;
    const wa = m.channel === "whatsapp";
    const form = new URLSearchParams({ To: wa ? `whatsapp:${m.to}` : m.to, From: wa ? t.whatsappFrom : t.smsFrom, Body: m.body });
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${t.accountSid}:${t.authToken}`)}`, "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    return await result(res);
  } catch (e) {
    return { ok: false, error: (e as Error).message, retryable: true }; // network error
  }
}

async function result(res: Response): Promise<SendResult> {
  if (res.ok) {
    const j: any = await res.json().catch(() => ({}));
    return { ok: true, providerId: String(j.sid ?? j.id ?? "") };
  }
  // 4xx (except 429) means the request itself is bad: retrying won't help.
  return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, retryable: res.status === 429 || res.status >= 500 };
}

export const MAX_DELIVERY_ATTEMPTS = 5;

/** What to do after a failed attempt: schedule another try, or give up. */
export function nextDelivery(attempts: number, r: Extract<SendResult, { ok: false }>): { retryInMs: number } | { giveUp: true } {
  return r.retryable && attempts < MAX_DELIVERY_ATTEMPTS ? { retryInMs: backoffMs(attempts) } : { giveUp: true };
}
