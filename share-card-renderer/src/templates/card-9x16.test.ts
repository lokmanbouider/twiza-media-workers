import { describe, expect, it } from "vitest";
import { card9x16, CARD_9X16 } from "./card-9x16.js";
import { baseCardData, textOf } from "./card-test-helpers.js";

describe("card9x16", () => {
  it("fr: title, before/after labels, stats and brand", () => {
    const t = textOf(card9x16(baseCardData()));
    expect(t).toContain("Nettoyage de la plage");
    expect(t).toContain("AVANT");
    expect(t).toContain("APRÈS");
    expect(t).toContain("3 points nettoyés");
    expect(t).toContain("8 participants");
    expect(t).toContain("12 sacs");
    expect(t).toContain("Bab Ezzouar · Alger");
    expect(t).toContain("TWIZA");
  });

  it("drops the bags stat when zero", () => {
    expect(textOf(card9x16(baseCardData({ bags: 0 })))).not.toContain("sac");
  });

  it("ar: RTL document and Arabic labels", () => {
    const html = card9x16(baseCardData({ locale: "ar", title: "تنظيف الشاطئ" }));
    expect(html).toContain('<html dir="rtl"');
    const t = textOf(html);
    expect(t).toContain("قبل");
    expect(t).toContain("بعد");
    expect(t).toContain("تنظيف الشاطئ");
  });

  it("fixed 1080x1920 frame", () => {
    expect(CARD_9X16).toEqual({ format: "9x16", width: 1080, height: 1920 });
    expect(card9x16(baseCardData())).toContain(".card{width:1080px;height:1920px}");
  });

  it("shows the national total when known, else the tagline", () => {
    const withNat = textOf(card9x16(baseCardData({ nationalCleaned: 1247 })));
    expect(withNat).toContain("nettoyés en Algérie");
    expect(withNat).not.toContain("Nettoyons l'Algérie, ensemble.");
    expect(textOf(card9x16(baseCardData({ nationalCleaned: 0 })))).toContain(
      "Nettoyons l'Algérie, ensemble.",
    );
  });

  it("escapes user-supplied title", () => {
    const html = card9x16(baseCardData({ title: '<script>x</script>' }));
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("carries the injected font-face css", () => {
    expect(card9x16(baseCardData(), "@font-face{font-family:'Z'}")).toContain(
      "@font-face{font-family:'Z'}",
    );
  });
});
