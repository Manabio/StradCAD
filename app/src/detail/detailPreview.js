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
export const PREVIEW_DIM_GAP_MM = 80;
/** 寸法線を辺から離す距離を図の大きさに比例させる比（図全体の bbox の長辺 × 比。PREVIEW_DIM_GAP_MM は下限）。 */
export const PREVIEW_DIM_GAP_RATIO = 0.2;
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

function bboxOf(pts) {
  return {
    minS: Math.min(...pts.map(p => p.s)), maxS: Math.max(...pts.map(p => p.s)),
    minT: Math.min(...pts.map(p => p.t)), maxT: Math.max(...pts.map(p => p.t)),
  };
}

/**
 * 寸法線の辺からの距離（mm）。max(gapBase, PREVIEW_DIM_GAP_RATIO × 図全体の bbox の長辺)。頂点が無ければ gapBase。
 * @param {number} gapBase 下限（既定 PREVIEW_DIM_GAP_MM）
 * @param {{s:number,t:number}[]} pts 描いた全ストロークの頂点
 */
export function previewDimGap(gapBase, pts) {
  const base = Number.isFinite(gapBase) && gapBase > 0 ? gapBase : PREVIEW_DIM_GAP_MM; // 不正は既定へ（例外にしない）
  if (!Array.isArray(pts) || pts.length === 0) return base;
  const b = bboxOf(pts);
  const g = Math.max(base, PREVIEW_DIM_GAP_RATIO * Math.max(b.maxS - b.minS, b.maxT - b.minT));
  return Number.isFinite(g) && g > 0 ? g : base;
}

/**
 * 同じ側の寸法を行へ割り付ける（貪欲法）。区間の始点で安定ソートし、各寸法を「置いた寸法と衝突しない最小の行」へ。
 * 衝突＝区間が重なる（端点一致も重なり）か、区間の中心同士の距離が gap 未満（値が重なる）。
 * @param {{from:number,to:number}[]} dims
 * @param {number} gap 正の有限値
 * @returns {number[]} dims と同じ順の行番号（0 始まり）
 */
export function assignDimRows(dims, gap) {
  if (!Number.isFinite(gap) || gap <= 0) throw new RangeError(`gap は正の有限値: ${gap}`);
  const list = dims ?? [];
  for (const d of list) {
    if (!d || !Number.isFinite(d.from) || !Number.isFinite(d.to)) throw new RangeError('寸法の from/to が不正');
  }
  const span = d => [Math.min(d.from, d.to), Math.max(d.from, d.to)];
  const order = list.map((_, i) => i).sort((i, j) => span(list[i])[0] - span(list[j])[0] || i - j); // 安定
  const rows = new Array(list.length);
  const placed = []; // {lo, hi, center, k}
  for (const i of order) {
    const [lo, hi] = span(list[i]);
    const center = (lo + hi) / 2;
    let k = 0;
    while (placed.some(p => p.k === k && ((lo <= p.hi && p.lo <= hi) || Math.abs(center - p.center) < gap))) k++;
    rows[i] = k;
    placed.push({ lo, hi, center, k });
  }
  return rows;
}

/**
 * @param {object} figure DetailFigure（下書きでもよい。歩けないストロークは飛ばす）
 * @param {{dimGapMm?: number, labelOffsetMm?: number, labelSizePx?: number, labelOf?: (role:string)=>string}} [opts]
 *   末尾に origin の Datum の基準線（datumGuidePrimitives）を付ける
 */
export function previewPrimitives(figure, opts = {}) {
  const gapBase = opts.dimGapMm ?? PREVIEW_DIM_GAP_MM;
  const off = opts.labelOffsetMm ?? PREVIEW_LABEL_OFFSET_MM;
  const size = opts.labelSizePx ?? PREVIEW_LABEL_SIZE_PX;
  const fig = normalizeDetailFigure(figure);
  const datumById = new Map(fig.datums.filter(d => d && typeof d === 'object').map(d => [d.id, d]));
  const out = [];
  const allPts = [];
  const pending = []; // 寸法（out の slot に後で入れる）
  let strokeSeq = 0;

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
    const sid = strokeSeq++;
    const seen = new Set();
    const box = bboxOf(pts);
    const centerS = (Math.min(...pts.map(p => p.s)) + Math.max(...pts.map(p => p.s))) / 2;
    const centerT = (Math.min(...pts.map(p => p.t)) + Math.max(...pts.map(p => p.t))) / 2;
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
      // 側はこのストロークの bbox の中心から遠い側（図の外側。中心上は + 側）。位置は gap・行が決まる後段で埋める
      const horizontal = parts[0].axis === DetailAxis.S;
      const side = horizontal ? (a.t >= centerT ? 1 : -1) : (a.s >= centerS ? 1 : -1);
      const from = horizontal ? Math.min(a.s, b.s) : Math.min(a.t, b.t);
      const to = horizontal ? Math.max(a.s, b.s) : Math.max(a.t, b.t);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(horizontal ? a.t : a.s)) return; // 座標が壊れた手は寸法を出さない（検証が別に出す）
      // 同じストローク・同じ側で from・to・label が同じ寸法は 1 本だけ（最初の手が代表。櫛形で行が増え続けない）
      const dupKey = `${horizontal}|${side}|${from}|${to}|${label}`;
      if (seen.has(dupKey)) return;
      seen.add(dupKey);
      const slot = out.length;
      out.push(null);
      pending.push({ slot, sid, box, horizontal, side, from, to, foot: horizontal ? a.t : a.s, label, editKey });
    });
  }
  const gap = previewDimGap(gapBase, allPts);
  // ストロークごと × 側（h 上／h 下／v 左／v 右）に行へまとめ、そのストロークの bbox の辺から gap + k × gap/2 に置く
  // （別のストロークの材を足が貫かない。ストローク間で値が重なりうるのは既知の限界）
  const strokeIds = [...new Set(pending.map(d => d.sid))];
  for (const sid of strokeIds) {
    for (const horizontal of [true, false]) {
      for (const side of [-1, 1]) {
        const group = pending.filter(d => d.sid === sid && d.horizontal === horizontal && d.side === side);
        if (group.length === 0) continue;
        const rows = assignDimRows(group, gap);
        const box = group[0].box;
        const base = horizontal ? (side < 0 ? box.minT : box.maxT) : (side < 0 ? box.minS : box.maxS);
        group.forEach((d, i) => {
          const at = base + side * (gap + rows[i] * (gap / 2));
          const footLen = Math.abs(at - d.foot) - gap / 2; // 材側に gap/2 の空きを残して寸法線まで
          const opts = { editable: true, editKey: d.editKey };
          if (footLen > 0) { opts.foot = d.foot; opts.footLen = footLen; }
          if (!horizontal) { opts.labelVertical = true; opts.labelSide = 'left'; } // 縦の値は常に線の左（天が左）
          out[d.slot] = dim(horizontal ? 'h' : 'v', d.from, d.to, at, d.label, opts);
        });
      }
    }
  }
  out.push(...datumGuidePrimitives(fig.datums.filter(d => d && typeof d === 'object'), allPts, { gap, labelOf: opts.labelOf, labelOffsetMm: off, labelSizePx: size }));
  return out;
}
