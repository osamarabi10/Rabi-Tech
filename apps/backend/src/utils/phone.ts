/** Normalize user-entered phone to WhatsApp format (972XXXXXXXXX). */
export function normalizePhoneInput(raw: string): string | null {
  let phone = raw.replace(/\D/g, '');
  if (!phone) return null;

  if (phone.startsWith('00')) phone = phone.slice(2);
  if (phone.startsWith('0')) phone = `972${phone.slice(1)}`;
  if (phone.length === 9 && phone.startsWith('5')) phone = `972${phone}`;
  if (phone.length === 10 && phone.startsWith('05')) phone = `972${phone.slice(1)}`;

  if (!/^9725\d{8}$/.test(phone)) return null;
  return phone;
}
