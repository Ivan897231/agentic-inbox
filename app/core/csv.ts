import { normalizeEmail, normalizePhone } from "./normalize";

/** RFC 4180-ish: quoted fields, escaped quotes (""), commas and newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export interface ContactRow { sourceId: string; name: string; phones: string[]; emails: string[]; building: string; unit: string; role: "tenant" | "owner" | "vendor" }

const ALIASES: Record<string, string[]> = {
  sourceId: ["id", "sourceid", "customer_id", "tenant_id", "legacy_id"],
  name: ["name", "full_name", "tenant", "contact"],
  phone: ["phone", "mobile", "tel", "telephone"],
  email: ["email", "e-mail", "mail"],
  building: ["building", "property", "address"],
  unit: ["unit", "apartment", "apt", "flat"],
  role: ["role", "type"],
};

/**
 * Map an arbitrary legacy export onto our contact shape. Bad rows don't abort the file:
 * they come back as `errors` with the original line number so the customer can fix them.
 */
export function mapContacts(rows: string[][]): { contacts: ContactRow[]; errors: { line: number; error: string }[] } {
  const [head = [], ...body] = rows;
  const col = (key: string) => head.findIndex((h) => ALIASES[key].includes(h.trim().toLowerCase().replace(/\s+/g, "_")));
  const idx = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, col(k)]));
  const contacts: ContactRow[] = [], errors: { line: number; error: string }[] = [];
  if (idx.name < 0) return { contacts, errors: [{ line: 1, error: "No name column found (expected one of: name, full_name, tenant, contact)" }] };

  body.forEach((r, i) => {
    const line = i + 2, get = (k: string) => (idx[k] >= 0 ? (r[idx[k]] ?? "").trim() : "");
    const name = get("name");
    if (!name) return errors.push({ line, error: "Missing name" });
    // Multiple values in one cell (e.g. "a@x.com; b@x.com") are common in exports.
    const split = (v: string) => v.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
    const emails = split(get("email")).map(normalizeEmail);
    const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad) return errors.push({ line, error: `Invalid email "${bad}"` });
    const phones = split(get("phone")).map(normalizePhone).filter((p) => p.replace(/\D/g, "").length >= 7);
    const role = (["owner", "vendor"] as const).find((x) => get("role").toLowerCase().includes(x)) ?? "tenant";
    contacts.push({ sourceId: get("sourceId") || `row-${line}`, name, phones, emails, building: get("building") || "Unassigned", unit: get("unit"), role });
  });
  return { contacts, errors };
}

/** Deterministic synthetic legacy export for demos: duplicates, bad rows, mixed formats. */
export function sampleCsv(n = 2000): string {
  const first = ["Maria", "Tom", "Aiko", "Lukas", "Sofia", "Omar", "Anna", "Jonas", "Elena", "Piotr"];
  const last = ["Keller", "Becker", "Sato", "Meyer", "Rossi", "Haddad", "Novak", "Fischer", "Silva", "Kowalski"];
  const lines = ["id,full_name,phone,email,property,apartment,type"];
  for (let i = 0; i < n; i++) {
    const nm = `${first[i % 10]} ${last[(i * 7) % 10]}`;
    if (i % 400 === 399) lines.push(`${i},,+4915100${i},nobody@example.com,Linden Court ${1 + (i % 9)},${i % 40},tenant`); // no name
    else if (i % 333 === 332) lines.push(`${i},"${nm}",+4915100${i},not-an-email,Linden Court ${1 + (i % 9)},${i % 40},tenant`); // bad email
    else lines.push(`${i},"${nm}","+49 151 00${String(i).padStart(5, "0")}",${nm.toLowerCase().replace(" ", ".")}${i}@example.com,Linden Court ${1 + (i % 9)},${i % 40},${i % 50 === 0 ? "owner" : "tenant"}`);
  }
  return lines.join("\r\n");
}
