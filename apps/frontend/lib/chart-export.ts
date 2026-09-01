/**
 * Export a rendered chart as SVG or PNG.
 *
 * ## Why this is not three lines of XMLSerializer
 *
 * The charts here are hand-drawn SVG on the design tokens — gridlines are
 * `hsl(var(--border))`, axis text is `hsl(var(--muted-foreground))`, point
 * halos are `hsl(var(--card))`. Those custom properties are defined on the
 * document root, so the moment the markup leaves the document they resolve to
 * nothing.
 *
 * A naive serialize therefore produces a file that opens without error and is
 * *wrong*: gridlines, axis labels and halos are invisible, and only the series
 * lines survive, because those carry literal colours. That is the worst kind of
 * export bug — the file exists, it has plausible size, and nobody notices until
 * it is in front of the person it was exported for.
 *
 * So every `var()` is resolved against the live computed style before
 * serialising, and the theme's own surface colour is painted behind the PNG.
 *
 * ## Why not a library
 *
 * Same reason `line-chart.tsx` draws its own SVG: the whole need is a
 * serialise, a substitution and a canvas draw. Every candidate costs more in
 * bundle than this file costs in code, and would arrive with its own opinion
 * about colour that does not flip with the theme.
 */

/** `var(--x)` and `var(--x, fallback)`. */
const VAR_PATTERN = /var\(\s*(--[a-zA-Z0-9-_]+)\s*(?:,\s*([^)]*))?\)/g;

/** Attributes that can carry a colour on the elements this chart draws. */
const PAINT_ATTRIBUTES = ['fill', 'stroke', 'stop-color', 'color'] as const;

function resolveVars(value: string, root: CSSStyleDeclaration): string {
  return value.replace(VAR_PATTERN, (_match, name: string, fallback?: string) => {
    const resolved = root.getPropertyValue(name).trim();
    // A missing token falls back to whatever the author wrote, then to
    // transparent — never to the literal text `var(--x)`, which would make the
    // file invalid rather than merely wrong.
    return resolved || (fallback ?? '').trim() || 'transparent';
  });
}

/**
 * A standalone copy of `svg`, with tokens resolved and dimensions made explicit.
 *
 * The live element is sized by CSS (`className="w-full"`), so its width and
 * height attributes are absent or relative. A file with no intrinsic size opens
 * at whatever the viewer guesses, so both are stamped from the measured box.
 */
function standaloneSvg(svg: SVGSVGElement): { markup: string; width: number; height: number } {
  const root = getComputedStyle(document.documentElement);
  const box = svg.getBoundingClientRect();
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  for (const element of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const attribute of PAINT_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value && value.includes('var(')) element.setAttribute(attribute, resolveVars(value, root));
    }
    const style = element.getAttribute('style');
    if (style && style.includes('var(')) element.setAttribute('style', resolveVars(style, root));
  }

  return { markup: new XMLSerializer().serializeToString(clone), width, height };
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next frame rather than immediately: Safari cancels an
  // in-flight download when the object URL disappears in the same tick.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

export function exportChartSvg(svg: SVGSVGElement, filename: string): void {
  const { markup } = standaloneSvg(svg);
  download(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }), `${filename}.svg`);
}

/**
 * PNG at 2x, on the theme's own surface rather than on transparency.
 *
 * A transparent export of a dark-theme chart pasted into a white document is
 * light text on white — technically faithful and unreadable. Painting the
 * resolved surface colour keeps the file looking like what was on screen.
 */
export async function exportChartPng(svg: SVGSVGElement, filename: string, scale = 2): Promise<void> {
  const { markup, width, height } = standaloneSvg(svg);
  const root = getComputedStyle(document.documentElement);
  const surface = resolveVars('hsl(var(--card))', root);

  const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The chart could not be rasterised'));
    image.src = source;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser did not provide a 2D canvas');
  context.fillStyle = surface;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The chart could not be encoded as PNG');
  download(blob, `${filename}.png`);
}
