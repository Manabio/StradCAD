// ================================================================
// ヘルパー画面のプレビュー用に、図を SvgFigurePrimitive の列へ変換する（純関数）。
//   - LenSpec.mm で歩く（fit しない。param・material も mm のまま）。
//   - 各ストローク: polyline（closed は closed:true を付ける。AutoScaledFigure は closed を SVG の <polygon> で描き線を閉じる。
//     <polyline> のままだと fill しか閉じず四角が開いて見えた＝2026-11-01 の DXF 矩形の目視で発覚・修正）＋頂点番号の text。
//   - 各 Move: 寸法 dim（横移動は dir 'h'、縦移動は 'v'）。editable:true と editKey:{strokeId, moveIndex} を付ける。
//     'V'（斜め）の Move は寸法を出さない。既知の限界（斜め寸法は先送り）。
//   - ストロークは origin の Anchor の頂点が origin の Datum の offsetMm に来るよう平行移動して描く（Anchor が揃わない下書きは原点のまま）。
// ================================================================

import { PenDir, DetailAxis, DetailDatumKind, DetailDash } from '../core/constants.js';
import { polyline, text, dim } from '../structural/sectionFigure/svgFigurePrimitives.js';
import { normalizeDetailFigure, moveParts } from './detailModel.js';
import { penWalk } from './detailPen.js';

/** 寸法線を辺から離す距離（mm）。 */
export const PREVIEW_DIM_GAP_MM = 40;
/** 頂点番号を頂点から離す距離（mm）。 */
export const PREVIEW_LABEL_OFFSET_MM = 15;
/** 頂点番号の文字サイズ（px。text の size）。 */
export const PREVIEW_LABEL_SIZE_PX = 11;

/**
 * @param {object} figure DetailFigure（下書きでもよい。歩けないストロークは飛ばす）
 * @param {{dimGapMm?: number, labelOffsetMm?: number, labelSizePx?: number}} [opts]
 */
export function previewPrimitives(figure, opts = {}) {
  const gap = opts.dimGapMm ?? PREVIEW_DIM_GAP_MM;
  const off = opts.labelOffsetMm ?? PREVIEW_LABEL_OFFSET_MM;
  const size = opts.labelSizePx ?? PREVIEW_LABEL_SIZE_PX;
  const fig = normalizeDetailFigure(figure);
  const datumById = new Map(fig.datums.filter(d => d && typeof d === 'object').map(d => [d.id, d]));
  const out = [];

  for (const stroke of fig.strokes) {
    if (!stroke || typeof stroke !== 'object') continue;
    const walked = penWalk(stroke, len => (len && typeof len.mm === 'number' ? len.mm : null));
    if (!Array.isArray(walked)) continue;
    const shift = { [DetailAxis.S]: 0, [DetailAxis.T]: 0 };
    for (const a of fig.anchors) {
      const d = datumById.get(a?.datumId);
      if (a?.strokeId !== stroke.id || !d || d.kind !== DetailDatumKind.ORIGIN || !walked[a.vertexIndex]) continue;
      if (d.axis === DetailAxis.S || d.axis === DetailAxis.T) shift[d.axis] = d.offsetMm - walked[a.vertexIndex][d.axis];
    }
    const pts = walked.map(p => ({ s: p.s + shift[DetailAxis.S], t: p.t + shift[DetailAxis.T] }));

    const extra = { strokeId: stroke.id };
    if (stroke.closed) extra.closed = true;
    if (stroke.line?.dashRole === DetailDash.DASHED) extra.dash = DetailDash.DASHED;
    out.push(polyline(pts.map(p => [p.s, p.t]), extra));

    pts.forEach((p, i) => out.push(text(p.s + off, p.t - off, String(i), { size })));

    stroke.moves.forEach((move, moveIndex) => {
      if (move.dir === PenDir.VECTOR) return; // 斜めの寸法は先送り
      const parts = moveParts(move);
      if (!parts) return;
      const a = pts[moveIndex];
      const b = pts[moveIndex + 1];
      const editKey = { strokeId: stroke.id, moveIndex };
      const label = parts[0].len?.mm;
      if (parts[0].axis === DetailAxis.S) {
        out.push(dim('h', Math.min(a.s, b.s), Math.max(a.s, b.s), a.t + gap, label, { editable: true, editKey }));
      } else {
        out.push(dim('v', Math.min(a.t, b.t), Math.max(a.t, b.t), a.s + gap, label, { editable: true, editKey }));
      }
    });
  }
  return out;
}
