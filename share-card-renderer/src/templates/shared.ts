// Shared pieces for the three card layouts (T5.4 / T5.5), as HTML/CSS.
// A card builder returns a complete, self-contained HTML document sized to
// the format; render.ts loads it into a headless Chromium page and
// screenshots it. Chromium does real text shaping, so Arabic joins and RTL
// work without the Satori font-parsing limitation.

import { cardStrings, formatCardDate } from "../strings.js";

export type CardData = {
  beforeDataUri: string;
  afterDataUri: string;
  title: string | null;
  commune: string | null;
  wilaya: string | null;
  dateIso: string | null;
  participants: number;
  bags: number;
  cleanedCount: number;
  /** National running total of cleaned points (T5.9). 0 hides the line. */
  nationalCleaned: number;
  organizerName: string | null;
  locale: string;
};

export const GREEN = "#2e7d32";
export const INK = "#12261a";

/** The bottom line of a card: the national total if known, else the tagline. */
export function bottomLine(data: CardData): string {
  const s = cardStrings(data.locale);
  return data.nationalCleaned > 0 ? s.national(data.nationalCleaned) : s.tagline;
}

/** The stat strings for a card, in locale, bags dropped when zero. */
export function statLines(data: CardData): string[] {
  const s = cardStrings(data.locale);
  return [
    s.cleaned(data.cleanedCount),
    s.participants(data.participants),
    ...(data.bags > 0 ? [s.bags(data.bags)] : []),
  ];
}

export function placeAndDate(data: CardData): string {
  const place = [data.commune, data.wilaya].filter(Boolean).join(" · ");
  return [place, formatCardDate(data.dateIso, data.locale)]
    .filter(Boolean)
    .join("  —  ");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A photo filling its box, with the AVANT / APRÈS badge in the reading corner. */
export function photoHtml(
  dataUri: string,
  label: string,
  rtl: boolean,
  fontSize: number,
): string {
  const side = rtl ? "right" : "left";
  return `<div class="photo">
  <img src="${escapeHtml(dataUri)}" alt="" />
  <div class="badge" style="${side}:24px;font-size:${fontSize}px">${escapeHtml(label)}</div>
</div>`;
}

export function pillHtml(value: string, fontSize: number): string {
  return `<div class="pill" style="font-size:${fontSize}px">${escapeHtml(value)}</div>`;
}

export function brandChipHtml(fontSize: number): string {
  return `<div class="brand" style="font-size:${fontSize}px">TWIZA</div>`;
}

const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%}
body{font-family:'Noto Sans','Noto Naskh Arabic',sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
.card{display:flex;position:relative;overflow:hidden}
.photo{position:relative;width:100%;height:100%;overflow:hidden;display:flex}
.photo img{width:100%;height:100%;object-fit:cover}
.badge{position:absolute;top:24px;background:${GREEN};color:#fff;font-weight:700;
  padding:8px 22px;border-radius:10px;letter-spacing:2px;line-height:1}
.pill{background:rgba(255,255,255,0.16);color:#fff;font-weight:600;
  padding:10px 22px;border-radius:999px;line-height:1.1;white-space:nowrap}
.brand{background:#fff;color:${INK};font-weight:800;padding:8px 20px;
  border-radius:10px;letter-spacing:1px;line-height:1}
.clamp1,.clamp2,.clamp3{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.clamp1{-webkit-line-clamp:1}
.clamp2{-webkit-line-clamp:2}
.clamp3{-webkit-line-clamp:3}
`;

/**
 * Wraps a card body in a full HTML document sized exactly to the format.
 * `fontFaceCss` carries the embedded @font-face blocks (render.ts injects the
 * real ones; template tests leave it empty).
 */
export function htmlDoc(opts: {
  width: number;
  height: number;
  rtl: boolean;
  bodyHtml: string;
  extraCss?: string;
  fontFaceCss?: string;
}): string {
  return `<!doctype html>
<html dir="${opts.rtl ? "rtl" : "ltr"}" lang="${opts.rtl ? "ar" : "fr"}">
<head><meta charset="utf-8"><style>
${opts.fontFaceCss ?? ""}
${BASE_CSS}
.card{width:${opts.width}px;height:${opts.height}px}
${opts.extraCss ?? ""}
</style></head>
<body>${opts.bodyHtml}</body>
</html>`;
}
