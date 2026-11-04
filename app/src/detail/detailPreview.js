// ================================================================
// ヘルパー画面のプレビュー用に、図を SvgFigurePrimitive の列へ変換する（純関数）。
//   - LenSpec.mm で歩く（fit しない。param・material も mm のまま）。
//   - 各ストローク: polyline（closed は closed:true を付ける。AutoScaledFigure は closed を SVG の <polygon> で描き線を閉じる。
//     <polyline> のままだと fill しか閉じず四角が開いて見えた＝2026-11-01 の DXF 矩形の目視で発覚・修正）＋頂点番号の text。
//   - 各 Move: 寸法 dim（横移動は dir 'h'、縦移動は 'v'）。editable:true と editKey:{strokeId, moveIndex} を付ける。
//     'V'（斜め）の Move は寸法を出さない。既知の限界（斜め寸法は先送り）。
//   - ストロークは origin の Anchor の頂点が origin の Datum の offsetMm に来るよう平行移動して描く（Anchor が揃わない下書きは原点のまま）。
// ================================================================

import { PenDir, DetailAxis, DetailDatumKind, DetailDash, DetailEdgeMark } from '../core/constants.js';
import { polyline, text, dim } from '../structural/sectionFigure/svgFigurePrimitives.js';
import { normalizeDetailFigure, moveParts } from './detailModel.js';
import { penWalk } from './detailPen.js';

/** 寸法線を辺から離す距離（mm）。 */
export const PREVIEW_DIM_GAP_MM = 40;
/** 頂点番号を頂点から離す距離（mm）。 */
export const PREVIEW_LABEL_OFFSET_MM = 15;
/** 頂点番号の文字サイズ（px。text の size）。 */
export const PREVIEW_LABEL_SIZE_PX = 11;

/** 「空気との境目」の印（Move.edge）の辺に重ねる線の太さ（px。polyline の width。S8a）。 */
export const PREVIEW_AIR_EDGE_WIDTH_PX = 2.5;

/**
 * 印のある辺（手 i＝頂点 i→i+1）に重ねる太線の polyline の列。印が無ければ []。
 * @param {{s:number,t:number}[]} pts 頂点列
 * @param {(string|null|undefined)[]} marks 手の番号に対応する印
 */
export function airEdgeOverlays(pts, marks) {
  const out = [];
  (marks ?? []).forEach((mark, i) => {
    if (mark !== DetailEdgeMark.AIR || !pts[i] || !pts[i + 1]) return;
    out.push(polyline([[pts[i].s, pts[i].t], [pts[i + 1].s, pts[i + 1].t]], { width: PREVIEW_AIR_EDGE_WIDTH_PX }));
  });
  return out;
}

/**
 * origin の Datum（s・t 軸）の基準線。図の全頂点の外接矩形を両端 gap だけ延ばした破線＋役割名の text。
 * 寸法・頂点番号と違い editable／editKey を持たない（クリックにも寸法編集にも掛からない。guide:true の印だけ付ける）。
 * end の Datum・軸が s/t でないもの・offsetMm が有限でないものは出さない（黙って 0 に置き換えると誤った位置に線が出るため。
 * 呼び出し側 ui の previewEntryOf は非有限を 0 にしてから渡すので、画面では 0 の位置に出る）。頂点が無ければ [] 。
 * @param {{role:string, axis:string, kind:string, offsetMm:number}[]} datums
 * @param {{s:number,t:number}[]} pts 描いた全ストロークの頂点
 * @param {{gap?: number, labelOf?: (role:string)=>string, labelOffsetMm?: number, labelSizePx?: number}} [opts]
 *   labelOf は役割名の表示（detail/ は ui/ を引けないので呼び出し側が渡す。既定は role 文字列そのまま）
 */
export function datumGuidePrimitives(datums, pts, opts = {}) {
  const gap = opts.gap ?? PREVIEW_DIM_GAP_MM;
  const off = opts.labelOffsetMm ?? PREVIEW_LABEL_OFFSET_MM;
  const size = opts.labelSizePx ?? PREVIEW_LABEL_SIZE_PX;
  const labelOf = opts.labelOf ?? (role => role);
  if (!Array.isArray(pts) || pts.length === 0) return [];
  const minS = Math.min(...pts.map(p => p.s)) - gap;
  const maxS = Math.max(...pts.map(p => p.s)) + gap;
  const minT = Math.min(...pts.map(p => p.t)) - gap;
  const maxT = Math.max(...pts.map(p => p.t)) + gap;
  const out = [];
  for (const d of datums ?? []) {
    if (!d || d.kind !== DetailDatumKind.ORIGIN || !Number.isFinite(d.offsetMm)) continue;
    const name = labelOf(d.role);
    if (d.axis === DetailAxis.S) {
      out.push(polyline([[d.offsetMm, minT], [d.offsetMm, maxT]], { dash: DetailDash.DASHED, guide: true }));
      out.push(text(d.offsetMm, minT - off, name, { size, guide: true }));
    } else if (d.axis === DetailAxis.T) {
      out.push(polyline([[minS, d.offsetMm], [maxS, d.offsetMm]], { dash: DetailDash.DASHED, guide: true }));
      out.push(text(maxS + off, d.offsetMm, name, { size, anchor: 'start', baseline: 'middle', guide: true }));
    }
  }
  return out;
}

/**
 * @param {object} figure DetailFigure（下書きでもよい。歩けないストロークは飛ばす）
 * @param {{dimGapMm?: number, labelOffsetMm?: number, labelSizePx?: number, labelOf?: (role:string)=>string}} [opts]
 *   末尾に origin の Datum の基準線（datumGuidePrimitives）を付ける
 */
export function previewPrimitives(figure, opts = {}) {
  const gap = opts.dimGapMm ?? PREVIEW_DIM_GAP_MM;
  const off = opts.labelOffsetMm ?? PREVIEW_LABEL_OFFSET_MM;
  const size = opts.labelSizePx ?? PREVIEW_LABEL_SIZE_PX;
  const fig = normalizeDetailFigure(figure);
  const datumById = new Map(fig.datums.filter(d => d && typeof d === 'object').map(d => [d.id, d]));
  const out = [];
  const allPts = [];

  for (const stroke of fig.strokes) {
    if (!stroke || typeof stroke !== 'object') continue;
    const walked = penWalk(stroke, len => (len && typeof len.mm === 'number' ? len.mm : null));
    if (!Array.isArray(walked)) continue;
    const shift = { [DetailAxis.S]: 0, [DetailAxis.T]: 0 };
    for (const a of fig.anchors) {
      const d = datumById.get(a?.datumId);
      if (a?.strokeId !== stroke.id || !d || d.kind !== DetailDatumKind.ORIGIN || !walked[a.vertexIndex]) continue;
      if (d.axis === DetailAxis.S || d.axis === DetailAxis.T) {
        const aOff = Number.isFinite(a.offsetMm) ? a.offsetMm : 0; // 非有限は検証が別に出す
        shift[d.axis] = d.offsetMm + aOff - walked[a.vertexIndex][d.axis];
      }
    }
    const pts = walked.map(p => ({ s: p.s + shift[DetailAxis.S], t: p.t + shift[DetailAxis.T] }));

    allPts.push(...pts);
    const extra = { strokeId: stroke.id };
    if (stroke.closed) extra.closed = true;
    if (stroke.line?.dashRole === DetailDash.DASHED) extra.dash = DetailDash.DASHED;
    out.push(polyline(pts.map(p => [p.s, p.t]), extra));
    out.push(...airEdgeOverlays(pts, stroke.moves.map(m => m?.edge)));

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
  out.push(...datumGuidePrimitives(fig.datums.filter(d => d && typeof d === 'object'), allPts, { gap, labelOf: opts.labelOf, labelOffsetMm: off, labelSizePx: size }));
  return out;
}
