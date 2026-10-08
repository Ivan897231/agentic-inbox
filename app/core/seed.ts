import { MemoryStore } from "./store";

export function seedStore(): MemoryStore {
  const s = new MemoryStore();
  s.units = [
    { id: "u1", building: "Linden Court 12", label: "Apt 3B" },
    { id: "u2", building: "Linden Court 12", label: "Apt 5A" },
    { id: "u3", building: "Harbor Lofts", label: "Unit 204" },
  ];
  s.contacts = [
    { id: "c1", name: "Maria Keller", phones: ["+4915112345678"], emails: ["maria.keller@example.com"], unitId: "u1", role: "tenant" },
    { id: "c2", name: "Tom Becker", phones: ["+447700900123"], emails: ["tom@example.com"], unitId: "u2", role: "tenant" },
    { id: "c3", name: "Aiko Sato", phones: ["+14155550100"], emails: ["aiko.sato@example.com"], unitId: "u3", role: "tenant" },
  ];
  s.tickets = [{ id: "T-1001", unitId: "u1", contactId: "c1", category: "maintenance", urgency: "normal", summary: "Radiator in living room not heating", status: "open" }];
  s.kb = [
    { id: "k1", title: "Quiet hours", body: "Quiet hours are 22:00-07:00 on weekdays and 22:00-09:00 on weekends." },
    { id: "k2", title: "Lost keys and lockouts", body: "Spare keys are available from the caretaker Mon-Fri 9-17. Out-of-hours lockouts cost a flat 80 EUR callout fee." },
    { id: "k3", title: "Heating and radiators", body: "If a radiator stays cold, bleed it first with the radiator key from the caretaker; if that fails a technician visits within 3 working days." },
    { id: "k4", title: "Waste and recycling", body: "Bins are collected Tuesday; glass containers are in the courtyard." },
  ];
  return s;
}

export const DEMO_MESSAGES = [
  { label: "WhatsApp: heating (duplicate of open ticket)", channel: "whatsapp", from: "+4915112345678", body: "Hallo, die Heizung im Wohnzimmer ist kaputt, kalt seit gestern." },
  { label: "SMS: smell of gas", channel: "sms", from: "+447700900123", body: "I can smell gas in the hallway!! please help" },
  { label: "Email: leak in bathroom", channel: "email", from: "aiko.sato@example.com", subject: "Bathroom tap", body: "The bathroom tap has a slow leak and drips all night." },
  { label: "WhatsApp: locked out", channel: "whatsapp", from: "+447700900123", body: "I'm locked out, lost my key" },
  { label: "SMS: unknown number", channel: "sms", from: "+4915199999999", body: "Is the apartment still for rent?" },
  { label: "Email: deposit question", channel: "email", from: "maria.keller@example.com", subject: "Deposit", body: "When do I get my deposit back?" },
] as const;
