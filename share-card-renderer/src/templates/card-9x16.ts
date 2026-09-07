// 9:16 (1080 × 1920) — TikTok / Instagram Stories, the priority format.
// Before stacked above After for the strongest contrast.

import { cardStrings } from "../strings.js";
import {
  bottomLine,
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

export const CARD_9X16 = { format: "9x16" as const, width: 1080, height: 1920 };

const CSS = `
.card{flex-direction:column;background:#f4f7f4}
.pane{width:100%;height:760px;display:flex}
.panel{flex:1 1 auto;display:flex;flex-direction:column;padding:48px 56px;
  background:${GREEN};justify-content:space-between}
.title{color:#fff;font-size:56px;font-weight:700;line-height:1.15}
.sub{color:rgba(255,255,255,0.85);font-size:34px;margin-top:14px}
.pills{display:flex;flex-wrap:wrap;gap:16px;margin-top:28px}
.foot{display:flex;justify-content:space-between;align-items:flex-end;margin-top:28px}
.tag{color:#fff;font-size:30px;font-weight:600;max-width:620px}
`;

export function card9x16(data: CardData, fontFaceCss = ""): string {
  const s = cardStrings(data.locale);
  const body = `<div class="card">
  <div class="pane">${photoHtml(data.beforeDataUri, s.before, s.rtl, 34)}</div>
  <div class="pane">${photoHtml(data.afterDataUri, s.after, s.rtl, 34)}</div>
  <div class="panel">
    <div>
      <div class="title clamp2">${escapeHtml(data.title ?? "")}</div>
      <div class="sub clamp1">${escapeHtml(placeAndDate(data))}</div>
    </div>
    <div class="pills">${statLines(data).map((v) => pillHtml(v, 36)).join("")}</div>
    <div class="foot">
      <div class="tag clamp1">${escapeHtml(bottomLine(data))}</div>
      ${brandChipHtml(30)}
    </div>
  </div>
</div>`;
  return htmlDoc({
    width: CARD_9X16.width,
    height: CARD_9X16.height,
    rtl: s.rtl,
    bodyHtml: body,
    extraCss: CSS,
    fontFaceCss,
  });
}
