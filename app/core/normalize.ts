import type { InboundMessage } from "./types";

const digits = (s: string) => s.replace(/[^\d+]/g, "");

/** "whatsapp:+4915112345678" -> "+4915112345678" */
export function normalizePhone(raw: string): string {
  const cleaned = digits(raw.replace(/^whatsapp:/i, ""));
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

export function normalizeEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

/** Twilio sends application/x-www-form-urlencoded for both SMS and WhatsApp. */
export function fromTwilio(form: Record<string, string>, now = Date.now()): InboundMessage {
  const isWa = form.From?.startsWith("whatsapp:");
  return {
    channel: isWa ? "whatsapp" : "sms",
    externalId: form.MessageSid ?? form.SmsSid,
    from: normalizePhone(form.From),
    to: normalizePhone(form.To),
    body: form.Body ?? "",
    receivedAt: now,
  };
}

/** Vonage Messages/SMS inbound webhook (JSON). */
export function fromVonage(j: Record<string, any>, now = Date.now()): InboundMessage {
  const text = typeof j.text === "string" ? j.text : j.message?.content?.text ?? "";
  return {
    channel: j.channel === "whatsapp" ? "whatsapp" : "sms",
    externalId: j.messageId ?? j.message_uuid,
    from: normalizePhone(String(j.msisdn ?? j.from?.number ?? j.from)),
    to: normalizePhone(String(j.to?.number ?? j.to)),
    body: text,
    receivedAt: now,
  };
}

/** Generic inbound-email JSON (Postmark/SendGrid style). Strips quoted replies. */
export function fromEmail(j: Record<string, any>, now = Date.now()): InboundMessage {
  return {
    channel: "email",
    externalId: j.MessageID ?? j.messageId,
    from: normalizeEmail(j.From ?? j.from),
    to: normalizeEmail(j.To ?? j.to),
    subject: j.Subject ?? j.subject,
    body: stripQuoted(j.TextBody ?? j.text ?? ""),
    receivedAt: now,
  };
}

export function stripQuoted(body: string): string {
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex((l) => /^>/.test(l) || /^On .+ wrote:$/.test(l) || /^-{2,}\s*Original Message/i.test(l));
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
}

/**
 * Twilio request validation: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)).
 * WebCrypto only, so it runs in Convex's default runtime.
 */
export async function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  let bin = "";
  sig.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export async function verifyTwilio(authToken: string, url: string, params: Record<string, string>, header: string | null) {
  if (!header) return false;
  const expected = await twilioSignature(authToken, url, params);
  if (expected.length !== header.length) return false;
  let diff = 0; // constant-time compare
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}
