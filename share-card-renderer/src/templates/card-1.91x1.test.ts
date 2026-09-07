import { describe, expect, it } from "vitest";
import { card1_91x1, CARD_1_91X1 } from "./card-1.91x1.js";
import { baseCardData, textOf } from "./card-test-helpers.js";

describe("card1_91x1", () => {
  it("fr: 1200x630 frame with the text panel", () => {
    expect(CARD_1_91X1).toEqual({ format: "1.91x1", width: 1200, height: 630 });
    const html = card1_91x1(baseCardData());
    expect(html).toContain(".card{width:1200px;height:630px}");
    const t = textOf(html);
    expect(t).toContain("Nettoyage de la plage");
    expect(t).toContain("AVANT");
    expect(t).toContain("TWIZA");
  });

  it("ar: RTL", () => {
    expect(card1_91x1(baseCardData({ locale: "ar" }))).toContain('<html dir="rtl"');
  });

  it("title clamps to 3 lines", () => {
    expect(card1_91x1(baseCardData())).toContain('class="title clamp3"');
  });
});
