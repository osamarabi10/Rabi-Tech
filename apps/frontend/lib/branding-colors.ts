/** Default primary as hex — must track --primary in globals.css. */
const DEFAULT_PRIMARY_HEX = '#0066ff';

export function hslTripletToHex(value: string): string {
  // An unset triplet must fall back to the brand default, not to black:
  // ''.split() yields h=0 s=0 l=0 → #000000, and <input type="color"> then
  // shows a black swatch that one save turns into the tenant's real primary.
  if (!value || !value.trim()) return DEFAULT_PRIMARY_HEX;

  const parts = value.trim().split(/\s+/);
  const h = Number(parts[0] || 0) / 360;
  const s = Number((parts[1] || '0').replace('%', '')) / 100;
  const l = Number((parts[2] || '0').replace('%', '')) / 100;

  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return DEFAULT_PRIMARY_HEX;

  const hueToRgb = (p: number, q: number, t: number) => {
    let next = t;
    if (next < 0) next += 1;
    if (next > 1) next -= 1;
    if (next < 1 / 6) return p + (q - p) * 6 * next;
    if (next < 1 / 2) return q;
    if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const rgb =
    s === 0
      ? [l, l, l]
      : [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];

  return `#${rgb
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function hexToHslTriplet(hex: string): string {
  const clean = hex.replace('#', '').trim();
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}
