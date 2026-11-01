// ================================================================
// PDF のページの演算子列（pdfjs の getOperatorList の fnArray／argsArray）→ パス（線分列。ページのユーザー空間 pt・y 上向き）。
// 純関数。pdfjs 自体は引かない（番号の表 ops＝pdfjs の OPS を呼び出し側が渡す）。外部ファイルなので上限で打ち切る。
//   - 拾うのは constructPath だけ。args=[描画命令の番号, 経路データ, 外接矩形]。経路データは符号つきの平らな数列
//     （PdfDrawOp: moveTo x y／lineTo x y／curveTo 6 値／quadraticCurveTo 4 値／closePath）。pdfjs 6.4 は 1 要素の配列で包む。
//   - 描画命令: endPath（クリップの経路・何も描かない）は捨てる。塗り系（fill／eoFill／fillStroke 系／close*）は開いた部分経路を
//     始点へ閉じる（塗りは暗黙に閉じるため）。stroke だけなら閉じない。塗りだけで色が白のものは地（背景・白抜き）として捨てる。
//   - CTM: 初期は単位行列（演算子列の座標はユーザー空間のまま）。transform は左から掛ける（新 CTM＝M×CTM）、save／restore で積む。
//     paintFormXObjectBegin（matrix, bbox）は save＋transform(matrix)、End は restore。
//   - 曲線はベジェの弦公差 chordTolPt（pt）で等分割（Wang の式: 3 次 n=√(6M/8ε)、2 次 n=√(2M/8ε)。M＝制御点の 2 階差分の最大長）。
//   - 文字（showText 系）・画像（paintImage 系）は読まず件数だけ警告（ページ全体の件数。クリップとは無関係）。
// 出力 paths: [{ segments:[{a:{x,y}, b:{x,y}}], bbox:{minX,minY,maxX,maxY} }]
// ================================================================

import { PdfDrawOp, PdfWarning, PdfLimitKind, PDF_MAX_PATH_OPS, PDF_BACKGROUND_FILL, DXF_MAX_SEGMENTS } from '../../core/constants.js';

// pdfjs の OPS の名前（番号は呼び出し側の表から引く）。
const TEXT_OP_NAMES = Object.freeze(['showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText']);
const IMAGE_OP_NAMES = Object.freeze([
  'paintImageXObject', 'paintImageMaskXObject', 'paintInlineImageXObject', 'paintImageXObjectRepeat',
  'paintImageMaskXObjectRepeat', 'paintImageMaskXObjectGroup', 'paintInlineImageXObjectGroup', 'paintSolidColorImageMask',
]);
const FILL_ONLY_NAMES = Object.freeze(['fill', 'eoFill']);
const FILL_STROKE_NAMES = Object.freeze(['fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke']);
const NO_PAINT_NAMES = Object.freeze(['endPath']);

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const MATRIX_LENGTH = 6;
const CUBIC_FACTOR = 6 / 8;   // Wang の式の d(d−1)/8（d=3）
const QUAD_FACTOR = 2 / 8;    // 同（d=2）
const MIN_CURVE_SEGMENTS = 1;
const RGB_COLOR_ARG = 0;
const MATRIX_ARG = 0;
const PAINT_ARG = 0;
const DATA_ARG = 1;

/** 行列 a を先に・b を後に適用する合成（PDF の row-vector 規約: p′ = p·A·B）。 */
function multiply(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}
const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
const finitePt = p => Number.isFinite(p.x) && Number.isFinite(p.y);
const matrixOf = arg => {
  if (arg === null || arg === undefined) return null;
  const m = [];
  for (let i = 0; i < MATRIX_LENGTH; i++) m.push(Number(arg[i]));
  return m.every(Number.isFinite) ? m : null;
};

/** 経路データ（平らな数列。1 要素の配列で包まれていてもよい）。 */
function dataOf(arg) {
  if (Array.isArray(arg) && arg.length === 1 && (ArrayBuffer.isView(arg[0]) || Array.isArray(arg[0]))) return arg[0];
  return arg ?? [];
}

function paintKindOf(op, ops) {
  const is = names => names.some(n => ops[n] === op);
  if (is(NO_PAINT_NAMES)) return null;
  const fill = is(FILL_ONLY_NAMES) || is(FILL_STROKE_NAMES);
  const stroke = !is(FILL_ONLY_NAMES);
  const closes = fill || ['closeStroke', 'closeFillStroke', 'closeEOFillStroke'].some(n => ops[n] === op);
  return { fill, stroke, closes, fillOnly: fill && !stroke };
}

function flattenCount(m, factor, tolPt) {
  if (!(tolPt > 0) || !Number.isFinite(m)) return MIN_CURVE_SEGMENTS;
  return Math.min(DXF_MAX_SEGMENTS, Math.max(MIN_CURVE_SEGMENTS, Math.ceil(Math.sqrt(factor * m / tolPt))));
}
const second = (p0, p1, p2) => Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y);

/** 経路データ → { segments（CTM 適用済み）, unknownOp（未知の描画命令で打ち切ったか）, nonFinite（捨てた線分数） }。 */
function segmentsOfPath(data, ctm, tolPt, closeOpen, budget) {
  const segments = [];
  let start = null;
  let cur = null;
  let unknownOp = false;
  let nonFinite = 0;
  const push = (a, b) => { if (finitePt(a) && finitePt(b)) segments.push({ a, b }); else nonFinite += 1; };
  // 曲線の分割数は線分の予算の残りまでに抑える（1 本の曲線で予算を超えない）。
  const capped = n => Math.min(n, Math.max(MIN_CURVE_SEGMENTS, budget - segments.length));
  const pt = (x, y) => apply(ctm, x, y);
  const closeSub = () => { if (closeOpen && cur && start && (cur.x !== start.x || cur.y !== start.y)) push(cur, start); };
  let i = 0;
  while (i < data.length && segments.length < budget) {
    const code = data[i++];
    if (code === PdfDrawOp.MOVE_TO) {
      closeSub();
      start = pt(data[i], data[i + 1]);
      cur = start;
      i += 2;
    } else if (code === PdfDrawOp.LINE_TO) {
      const p = pt(data[i], data[i + 1]);
      i += 2;
      if (cur) push(cur, p); else start = p;
      cur = p;
    } else if (code === PdfDrawOp.CURVE_TO) {
      const p1 = pt(data[i], data[i + 1]);
      const p2 = pt(data[i + 2], data[i + 3]);
      const p3 = pt(data[i + 4], data[i + 5]);
      i += 6;
      if (!cur) { start = p1; cur = p1; }
      const m = Math.max(second(cur, p1, p2), second(p1, p2, p3));
      const n = capped(flattenCount(m, CUBIC_FACTOR, tolPt));
      let prev = cur;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        const q = {
          x: u * u * u * cur.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * cur.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        };
        push(prev, q);
        prev = q;
      }
      cur = p3;
    } else if (code === PdfDrawOp.QUAD_TO) {
      const p1 = pt(data[i], data[i + 1]);
      const p2 = pt(data[i + 2], data[i + 3]);
      i += 4;
      if (!cur) { start = p1; cur = p1; }
      const n = capped(flattenCount(second(cur, p1, p2), QUAD_FACTOR, tolPt));
      let prev = cur;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const u = 1 - t;
        const q = { x: u * u * cur.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * cur.y + 2 * u * t * p1.y + t * t * p2.y };
        push(prev, q);
        prev = q;
      }
      cur = p2;
    } else if (code === PdfDrawOp.CLOSE) {
      if (cur && start && (cur.x !== start.x || cur.y !== start.y)) push(cur, start);
      cur = start;
    } else {
      unknownOp = true; // 未知の符号: 以降は読めない（長さが分からない）。件数を警告する
      break;
    }
  }
  closeSub();
  return { segments, unknownOp, nonFinite };
}

export function bboxOf(segments) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const { a, b } of segments) {
    minX = Math.min(minX, a.x, b.x); maxX = Math.max(maxX, a.x, b.x);
    minY = Math.min(minY, a.y, b.y); maxY = Math.max(maxY, a.y, b.y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * @param {{fnArray: number[], argsArray: any[]}} opList
 * @param {Record<string, number>} ops pdfjs の OPS（名前→番号）
 * @param {{chordTolPt?: number, maxPaths?: number, maxSegments?: number}} [opts]
 * @returns {{paths: {segments: object[], bbox: object}[], warnings: object[]}}
 */
export function pdfExtractPaths(opList, ops, { chordTolPt = 0, maxPaths = PDF_MAX_PATH_OPS, maxSegments = DXF_MAX_SEGMENTS } = {}) {
  const { fnArray, argsArray } = opList;
  const numbers = names => new Set(names.map(n => ops[n]).filter(v => v !== undefined));
  const textOps = numbers(TEXT_OP_NAMES);
  const imageOps = numbers(IMAGE_OP_NAMES);
  const fillColorOps = numbers(['setFillRGBColor']);
  const otherFillColorOps = numbers(['setFillGray', 'setFillCMYKColor', 'setFillColor', 'setFillColorN', 'setFillColorSpace']);

  const paths = [];
  const stack = [];
  let ctm = IDENTITY;
  let fillColor = null;
  let texts = 0;
  let images = 0;
  let painted = 0;
  let segTotal = 0;
  let pathLimited = false;
  let segmentLimited = false;
  let unknownOps = 0;
  let nonFiniteSegments = 0;

  const push = () => stack.push({ ctm, fillColor });
  const pop = () => { const s = stack.pop(); if (s) ({ ctm, fillColor } = s); };

  for (let k = 0; k < fnArray.length; k++) {
    const op = fnArray[k];
    const args = argsArray[k];
    if (op === ops.save) push();
    else if (op === ops.restore) pop();
    else if (op === ops.transform) {
      const m = matrixOf(args);
      if (m) ctm = multiply(m, ctm);
    } else if (op === ops.paintFormXObjectBegin) {
      push();
      const m = matrixOf(args?.[MATRIX_ARG]);
      if (m) ctm = multiply(m, ctm);
    } else if (op === ops.paintFormXObjectEnd) pop();
    else if (fillColorOps.has(op)) fillColor = typeof args?.[RGB_COLOR_ARG] === 'string' ? args[RGB_COLOR_ARG].toLowerCase() : null;
    else if (otherFillColorOps.has(op)) fillColor = null;
    else if (textOps.has(op)) texts += 1;
    else if (imageOps.has(op)) images += 1;
    else if (op === ops.constructPath) {
      const kind = paintKindOf(args?.[PAINT_ARG], ops);
      if (kind === null) continue;
      if (kind.fillOnly && fillColor === PDF_BACKGROUND_FILL) continue;
      if (painted >= maxPaths) { pathLimited = true; break; }
      if (segTotal >= maxSegments) { segmentLimited = true; break; }
      painted += 1;
      const budget = maxSegments - segTotal;
      const { segments, unknownOp, nonFinite } = segmentsOfPath(dataOf(args?.[DATA_ARG]), ctm, chordTolPt, kind.closes, budget);
      if (unknownOp) unknownOps += 1;
      nonFiniteSegments += nonFinite;
      if (segments.length >= budget) segmentLimited = true; // 線分数の予算を使い切った（この経路は途中まで）
      if (segments.length === 0) continue;
      segTotal += segments.length;
      paths.push({ segments, bbox: bboxOf(segments) });
    }
  }

  const warnings = [];
  if (texts > 0) warnings.push({ code: PdfWarning.TEXT_IGNORED, count: texts });
  if (images > 0) warnings.push({ code: PdfWarning.IMAGE_IGNORED, count: images });
  if (pathLimited) warnings.push({ code: PdfWarning.PATH_LIMIT, kind: PdfLimitKind.PATHS, limit: maxPaths });
  if (segmentLimited) warnings.push({ code: PdfWarning.PATH_LIMIT, kind: PdfLimitKind.SEGMENTS, limit: maxSegments });
  if (unknownOps > 0) warnings.push({ code: PdfWarning.UNKNOWN_DRAW_OP, count: unknownOps });
  if (nonFiniteSegments > 0) warnings.push({ code: PdfWarning.NON_FINITE_SEGMENT, count: nonFiniteSegments });
  return { paths, warnings };
}
