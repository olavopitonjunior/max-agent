/** Optional live WhatsApp pilot boundary, read on every operation. */
export function whatsappPilotConfigured(): boolean {
  return process.env.MAX_WHATSAPP_PILOT_ALLOWLIST !== undefined;
}

/**
 * Absent preserves normal operation. Present but empty/malformed denies all,
 * including a list with any invalid entry. Only the optional E.164 + prefix
 * is normalized: no suffix matching or guessing missing country/area codes.
 * Inbound callers supply the Meta parser's existing canonical sender.
 */
export function whatsappPilotAllows(phone: string): boolean {
  const config = process.env.MAX_WHATSAPP_PILOT_ALLOWLIST;
  if (config === undefined) return true;
  try {
    const phones: unknown = JSON.parse(config);
    const valid = (value: unknown): value is string =>
      typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value);
    if (!Array.isArray(phones) || phones.length === 0 || !phones.every(valid) || !valid(phone)) return false;
    const digits = phone.replace(/^\+/, "");
    return phones.some((allowed) => allowed.replace(/^\+/, "") === digits);
  } catch {
    return false;
  }
}

export function assertWhatsAppPilotRecipient(phone: string): void {
  // Never include the recipient or configuration in errors/logs.
  if (!whatsappPilotAllows(phone)) throw new Error("whatsapp_pilot_recipient_denied");
}
