/**
 * Data-protection helpers (GDPR/DSGVO). Agent traces are stored for debugging, so contact details in
 * them are masked at write time: a leaked trace shouldn't be a leaked address book.
 */
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;
const EMAIL = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi;

export function maskText(s: string): string {
  return s
    .replace(EMAIL, (m, domain) => `${m[0]}***@${domain}`)
    .replace(PHONE, (m) => {
      const d = m.replace(/\D/g, "");
      return d.length < 7 ? m : `${m.startsWith("+") ? "+" + d.slice(0, 2) : d.slice(0, 2)}•••••${d.slice(-2)}`;
    });
}

/** Deep-masks every string in a JSON-like value (steps, tool results, args). */
export function maskDeep<T>(v: T): T {
  if (typeof v === "string") return maskText(v) as T;
  if (Array.isArray(v)) return v.map(maskDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x)])) as T;
  return v;
}
