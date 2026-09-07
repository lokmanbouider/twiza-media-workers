import { describe, expect, it } from "vitest";
import { type RenderDeps, renderShareCards } from "./render.js";
import { baseCardData } from "./templates/card-test-helpers.js";

function fakeDeps(over: Partial<RenderDeps> = {}): RenderDeps {
  return {
    fontFaceCss: () => Promise.resolve(""),
    screenshot: (_html, w, h) =>
      Promise.resolve(new Uint8Array(w * h > 1_000_000 ? 2_000_000 : 500_000)),
    encodeJpeg: (_png, quality) =>
      // shrinks with quality; only q <= 70 fits the 500 KB budget here
      Promise.resolve(new Uint8Array(quality >= 78 ? 600_000 : 400_000)),
    ...over,
  };
}

describe("renderShareCards", () => {
  it("emits the three formats with their dimensions", async () => {
    const cards = await renderShareCards(baseCardData(), fakeDeps());
    expect(cards.map((c) => c.format)).toEqual(["9x16", "1x1", "1.91x1"]);
    expect(cards.map((c) => [c.width, c.height])).toEqual([
      [1080, 1920],
      [1080, 1080],
      [1200, 630],
    ]);
  });

  it("feeds each format's HTML at the right pixel size to screenshot", async () => {
    const seen: [number, number][] = [];
    await renderShareCards(
      baseCardData(),
      fakeDeps({
        screenshot: (_html, w, h) => {
          seen.push([w, h]);
          return Promise.resolve(new Uint8Array(500_000));
        },
      }),
    );
    expect(seen).toEqual([[1080, 1920], [1080, 1080], [1200, 630]]);
  });

  it("steps the JPEG quality down until under 500 KB", async () => {
    const qualities: number[] = [];
    const cards = await renderShareCards(
      baseCardData(),
      fakeDeps({
        encodeJpeg: (_png, q) => {
          qualities.push(q);
          return Promise.resolve(new Uint8Array(q >= 78 ? 600_000 : 400_000));
        },
      }),
    );
    expect(qualities.slice(0, 3)).toEqual([85, 78, 70]);
    for (const c of cards) expect(c.jpeg.byteLength).toBeLessThanOrEqual(500 * 1024);
  });

  it("keeps the highest quality that already fits", async () => {
    const qualities: number[] = [];
    await renderShareCards(
      baseCardData(),
      fakeDeps({
        encodeJpeg: (_png, q) => {
          qualities.push(q);
          return Promise.resolve(new Uint8Array(100_000));
        },
      }),
    );
    expect(qualities).toEqual([85, 85, 85]);
  });

  it("injects the font-face CSS into every doc", async () => {
    const docs: string[] = [];
    await renderShareCards(
      baseCardData({ locale: "ar" }),
      fakeDeps({
        fontFaceCss: () => Promise.resolve("@font-face{font-family:'X'}"),
        screenshot: (html) => {
          docs.push(html);
          return Promise.resolve(new Uint8Array(400_000));
        },
      }),
    );
    expect(docs).toHaveLength(3);
    for (const d of docs) expect(d).toContain("@font-face{font-family:'X'}");
  });
});
