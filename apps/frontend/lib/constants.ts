/**
 * Deterministic avatar colour from a contact's name or phone.
 * Replaces the ISP-era zone colours, which hardcoded five town names.
 */
/**
 * Avatar hues. Used as both a tinted fill and the initial's text colour, so each
 * value has to stay legible as text on its own pale tint — the mid shades these
 * replace were chosen for a dark background and washed out on white.
 */
const AVATAR_COLORS = ['#0052CC', '#6D28D9', '#BE185D', '#B45309', '#047857', '#0E7490', '#C2410C'];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/**
 * Status badge colours, tuned for the light canvas.
 *
 * Two corrections from the dark-theme original: OPEN was red, which read as an
 * error when it is simply the normal working state; and every text colour has
 * been darkened, because the mid shades that worked on a near-black background
 * fall under AA contrast once they sit on a pale tint.
 */
export const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  OPEN:        { label: 'مفتوح',  color: '#0052CC', bg: 'rgba(0,102,255,0.10)' },
  RESOLVED:    { label: 'محلول',  color: '#047857', bg: 'rgba(16,185,129,0.12)' },
  CLOSED:      { label: 'مغلق',   color: '#475569', bg: 'rgba(100,116,139,0.12)' },
  DRAFT:       { label: 'مسودة',  color: '#475569', bg: 'rgba(100,116,139,0.12)' },
  SENDING:     { label: 'يُرسَل', color: '#B45309', bg: 'rgba(245,158,11,0.14)' },
  SENT:        { label: 'مرسل',   color: '#0052CC', bg: 'rgba(0,102,255,0.10)' },
  PENDING:         { label: 'معلق',          color: '#B45309', bg: 'rgba(245,158,11,0.14)' },
  AWAITING_CLIENT: { label: 'انتظار العميل', color: '#4338CA', bg: 'rgba(99,102,241,0.12)' },
};

/** Darkened for legibility on the light canvas; hue order is unchanged. */
export const PRIORITY_CONFIG: Record<string, { label: string; color: string }> = {
  CRITICAL: { label: 'عاجل',   color: '#DC2626' },
  HIGH:     { label: 'عالي',   color: '#C2410C' },
  MEDIUM:   { label: 'متوسط',  color: '#B45309' },
  LOW:      { label: 'منخفض',  color: '#047857' },
};

