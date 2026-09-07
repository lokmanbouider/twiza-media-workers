import { describe, expect, it } from "vitest";
import { card1x1, CARD_1X1 } from "./card-1x1.js";
import { baseCardData, textOf } from "./card-test-helpers.js";

describe("card1x1", () => {
  it("fr: 1080x1080 frame, labels, stats, brand", () => {
    expect(CARD_1X1).toEqual({ format: "1x1", width: 1080, height: 1080 });
    const html = card1x1(baseCardData());
    expect(html).toContain(".card{width:1080px;height:1080px}");
    const t = textOf(html);
    expect(t).toContain("AVANT");
    expect(t).toContain("APRÈS");
    expect(t).toContain("3 points nettoyés");
    expect(t).toContain("TWIZA");
  });

  it("ar: RTL and the After pane is rendered first", () => {
    const html = card1x1(baseCardData({ locale: "ar" }));
    expect(html).toContain('<html dir="rtl"');
    const firstBadge = html.indexOf('class="badge"');
    const afterAt = html.indexOf("بعد");
    const beforeAt = html.indexOf("قبل");
    expect(afterAt).toBeGreaterThan(-1);
    expect(firstBadge).toBeGreaterThan(-1);
    // After ("بعد") appears before Before ("قبل") in source order
    expect(afterAt).toBeLessThan(beforeAt);
  });

  it("drops the bags stat when zero", () => {
    expect(textOf(card1x1(baseCardData({ bags: 0 })))).not.toContain("sac");
  });
});
