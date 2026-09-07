// 1.91:1 (1200 × 630) — Open Graph preview for shared links (T5.7). Photos
// on the reading side, a green text panel on the other. In RTL the panel and
// the After pane lead.

import { cardStrings } from "../strings.js";
import {
  brandChipHtml,
  type CardData,
  escapeHtml,
  GREEN,
  htmlDoc,
  photoHtml,
  pillHtml,
  placeAndDate,
  statLines,
} from "./shared.js";

export const CARD_1_91X1 = { format: "1.91x1" as const, width: 1200, height: 630 };

const CSS = `
.card{background:${GREEN}}
.photos{display:flex;width:744px;height:630px}
.half{width:372px;height:100%;display:flex}
.panel{width:456px;height:630px;display:flex;flex-direction:column;
  background:${GREEN};padding:40px 36px;justify-content:space-between}
.title{color:#fff;font-size:40px;font-weight:700;line-height:1.15}
.sub{color:rgba(255,255,255,0.85);font-size:24px;margin-top:12px}
.pills{display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.panel .brand{align-self:flex-start}
`;

export function card1_91x1(data: CardData, fontFaceCss = ""): string {
  const s = cardStrings(data.locale);
  const first = s.rtl ? data.afterDataUri : data.beforeDataUri;
  const firstLabel = s.rtl ? s.after : s.before;
  const second = s.rtl ? data.beforeDataUri : data.afterDataUri;
  const secondLabel = s.rtl ? s.before : s.after;

  const photos = `<div class="photos">
    <div class="half">${photoHtml(first, firstLabel, s.rtl, 24)}</div>
    <div class="half">${photoHtml(second, secondLabel, s.rtl, 24)}</div>
  </div>`;
  const panel = `<div class="panel">
    <div>
      <div class="title clamp3">${escapeHtml(data.title ?? "")}</div>
      <div class="sub clamp2">${escapeHtml(placeAndDate(data))}</div>
    </div>
    <div class="pills">${statLines(data).map((v) => pillHtml(v, 24)).join("")}</div>
    ${brandChipHtml(24)}
  </div>`;

  return htmlDoc({
    width: CARD_1_91X1.width,
    height: CARD_1_91X1.height,
    rtl: s.rtl,
    bodyHtml: `<div class="card">${photos}${panel}</div>`,
    extraCss: CSS,
    fontFaceCss,
  });
}
