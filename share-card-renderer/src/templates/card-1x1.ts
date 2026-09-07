// 1:1 (1080 × 1080) — Instagram / Facebook feed. Before and After side by
// side (top), a green caption bar below. In RTL the After pane comes first.

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

export const CARD_1X1 = { format: "1x1" as const, width: 1080, height: 1080 };

const CSS = `
.card{flex-direction:column;background:${GREEN}}
.row{display:flex;width:100%;height:720px}
.half{width:540px;height:100%;display:flex}
.panel{flex:1 1 auto;display:flex;flex-direction:column;padding:36px 48px;
  justify-content:space-between}
.title{color:#fff;font-size:44px;font-weight:700}
.sub{color:rgba(255,255,255,0.85);font-size:28px;margin-top:10px}
.foot{display:flex;justify-content:space-between;align-items:flex-end;margin-top:16px}
.pills{display:flex;flex-wrap:wrap;gap:12px;max-width:760px}
`;

export function card1x1(data: CardData, fontFaceCss = ""): string {
  const s = cardStrings(data.locale);
  const first = s.rtl ? data.afterDataUri : data.beforeDataUri;
  const firstLabel = s.rtl ? s.after : s.before;
  const second = s.rtl ? data.beforeDataUri : data.afterDataUri;
  const secondLabel = s.rtl ? s.before : s.after;

  const body = `<div class="card">
  <div class="row">
    <div class="half">${photoHtml(first, firstLabel, s.rtl, 30)}</div>
    <div class="half">${photoHtml(second, secondLabel, s.rtl, 30)}</div>
  </div>
  <div class="panel">
    <div>
      <div class="title clamp1">${escapeHtml(data.title ?? "")}</div>
      <div class="sub clamp1">${escapeHtml(placeAndDate(data))}</div>
    </div>
    <div class="foot">
      <div class="pills">${statLines(data).map((v) => pillHtml(v, 28)).join("")}</div>
      ${brandChipHtml(26)}
    </div>
  </div>
</div>`;
  return htmlDoc({
    width: CARD_1X1.width,
    height: CARD_1X1.height,
    rtl: s.rtl,
    bodyHtml: body,
    extraCss: CSS,
    fontFaceCss,
  });
}
