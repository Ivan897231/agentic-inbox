import { httpActionGeneric, httpRouter } from "convex/server";
import { fromEmail, fromTwilio, fromVonage, verifyTwilio } from "../core/normalize";
import type { InboundMessage } from "../core/types";

const http = httpRouter();
const ok = (body = "") => new Response(body, { status: 200 });

/**
 * A 5xx makes providers retry for hours, so a payload we can never process must be a 4xx:
 * parse inside try/catch and answer 400 instead of crashing.
 */
async function ingest(ctx: any, parse: () => InboundMessage | Promise<InboundMessage>) {
  let m: InboundMessage;
  try { m = await parse(); } catch { return new Response("malformed payload", { status: 400 }); }
  return store(ctx, m);
}

async function store(ctx: any, m: InboundMessage) {
  if (!m.externalId || !m.body || !m.from) return new Response("bad payload", { status: 400 });
  await ctx.runMutation("ingest:receive" as any, { channel: m.channel, externalId: m.externalId, from: m.from, body: m.body });
  return ok("<Response/>"); // empty TwiML
}

http.route({
  path: "/webhooks/twilio",
  method: "POST",
  handler: httpActionGeneric(async (ctx, req) => {
    const form = Object.fromEntries(new URLSearchParams(await req.text())) as Record<string, string>;
    const valid = await verifyTwilio(process.env.TWILIO_AUTH_TOKEN!, req.url, form, req.headers.get("x-twilio-signature"));
    if (!valid) return new Response("invalid signature", { status: 403 });
    return ingest(ctx, () => fromTwilio(form));
  }),
});

http.route({
  path: "/webhooks/vonage",
  method: "POST",
  handler: httpActionGeneric(async (ctx, req) => {
    // Vonage signs with a JWT bearer; verify it here in production (omitted: see README).
    if (req.headers.get("authorization") !== `Bearer ${process.env.VONAGE_WEBHOOK_TOKEN}`) return new Response("unauthorized", { status: 401 });
    return ingest(ctx, async () => fromVonage(await req.json()));
  }),
});

http.route({
  path: "/webhooks/email",
  method: "POST",
  handler: httpActionGeneric(async (ctx, req) => {
    if (new URL(req.url).searchParams.get("token") !== process.env.EMAIL_WEBHOOK_TOKEN) return new Response("unauthorized", { status: 401 });
    return ingest(ctx, async () => fromEmail(await req.json()));
  }),
});

export default http;
