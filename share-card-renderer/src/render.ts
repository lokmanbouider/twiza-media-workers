// Render one CardData into the three formats. Headless Chromium lays out the
// HTML (real text shaping — Arabic joins, RTL works, unlike Satori) and
// screenshots it; sharp re-encodes to JPEG under 500 KB.
//
// The browser and the codec are injected so the orchestration and the
// templates stay testable without either.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { card9x16, CARD_9X16 } from "./templates/card-9x16.js";
import { card1x1, CARD_1X1 } from "./templates/card-1x1.js";
import { card1_91x1, CARD_1_91X1 } from "./templates/card-1.91x1.js";
import type { CardData } from "./templates/shared.js";

export type { CardData };

export type Format = "9x16" | "1x1" | "1.91x1";
export type RenderedCard = {
  format: Format;
  jpeg: Uint8Array;
  width: number;
  height: number;
};

export type RenderDeps = {
  /** HTML doc (already sized to w×h) -> PNG screenshot bytes. */
  screenshot: (html: string, width: number, height: number) => Promise<Uint8Array>;
  /** PNG bytes -> JPEG bytes at the given quality (1..100). */
  encodeJpeg: (png: Uint8Array, quality: number) => Promise<Uint8Array>;
  /** @font-face blocks injected into every doc (empty in template tests). */
  fontFaceCss: () => Promise<string>;
};

// T5.5 — every image must weigh under 500 KB.
const MAX_BYTES = 500 * 1024;
const QUALITY_LADDER = [85, 78, 70, 62];

const SPECS = [
  { spec: CARD_9X16, build: card9x16 },
  { spec: CARD_1X1, build: card1x1 },
  { spec: CARD_1_91X1, build: card1_91x1 },
] as const;

async function toJpegUnderBudget(
  png: Uint8Array,
  encodeJpeg: RenderDeps["encodeJpeg"],
): Promise<Uint8Array> {
  let out = await encodeJpeg(png, QUALITY_LADDER[0]!);
  for (let i = 1; i < QUALITY_LADDER.length && out.byteLength > MAX_BYTES; i++) {
    out = await encodeJpeg(png, QUALITY_LADDER[i]!);
  }
  return out;
}

/** Renders all three formats from the same data, one pass, JPEG < 500 KB each. */
export async function renderShareCards(
  data: CardData,
  deps: RenderDeps,
): Promise<RenderedCard[]> {
  const fontFaceCss = await deps.fontFaceCss();
  const out: RenderedCard[] = [];
  for (const { spec, build } of SPECS) {
    const html = build(data, fontFaceCss);
    const png = await deps.screenshot(html, spec.width, spec.height);
    const jpeg = await toJpegUnderBudget(png, deps.encodeJpeg);
    out.push({ format: spec.format, jpeg, width: spec.width, height: spec.height });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Real deps
// ---------------------------------------------------------------------------

const FONTS_DIR = fileURLToPath(new URL("../fonts/", import.meta.url));
let fontCssCache: string | null = null;

/** Both faces embedded as data: URIs — hermetic, no host fontconfig needed. */
export async function fontFaceCssReal(): Promise<string> {
  if (fontCssCache !== null) return fontCssCache;
  const [sans, naskh] = await Promise.all([
    readFile(`${FONTS_DIR}NotoSans-Regular.ttf`),
    readFile(`${FONTS_DIR}NotoNaskhArabic-Regular.ttf`),
  ]);
  fontCssCache = [
    `@font-face{font-family:'Noto Sans';font-weight:400;font-style:normal;` +
    `src:url(data:font/ttf;base64,${sans.toString("base64")}) format('truetype')}`,
    `@font-face{font-family:'Noto Naskh Arabic';font-weight:400;font-style:normal;` +
    `src:url(data:font/ttf;base64,${naskh.toString("base64")}) format('truetype')}`,
  ].join("\n");
  return fontCssCache;
}

export async function encodeJpegReal(
  png: Uint8Array,
  quality: number,
): Promise<Uint8Array> {
  const { default: sharp } = await import("sharp");
  return sharp(Buffer.from(png)).jpeg({ quality, mozjpeg: true }).toBuffer();
}

/**
 * Launches one Chromium and returns a screenshot fn bound to it plus a close
 * fn. Reuse the same instance across a drain loop; close it at the end.
 */
export async function makeChromiumScreenshot(): Promise<{
  screenshot: RenderDeps["screenshot"];
  close: () => Promise<void>;
}> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--font-render-hinting=none", "--force-color-profile=srgb"],
  });
  const screenshot: RenderDeps["screenshot"] = async (html, width, height) => {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    try {
      await page.setContent(html, { waitUntil: "load" });
      // wait for the embedded @font-face data: URIs to finish decoding
      await page.evaluate("document.fonts ? document.fonts.ready : null");
      return await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width, height },
      });
    } finally {
      await page.close();
    }
  };
  return { screenshot, close: () => browser.close() };
}
