// ================================================================
// 同じ面で一体の帯（軸平行の矩形）の和集合の外形線（基礎伏図の基礎梁。ユーザー裁定2026-11-12）。
//
// RC の基礎は天端が同面で一体に打つため、基礎梁の交点（十字・T・L・幅違い・端の突合せ）で帯の内側へ線を通さない。
// 外形だけを描く。各帯の矩形のうち、他の矩形の内側に入る辺の区間を取り除き、残りを帯ごとの線分にして返す。
// 描画側は帯（梁）ごとの <Group> に線分を入れてタップの対象を保つため、結果は帯の id ごとに分けて返す。
//
// react・store.js・snap.js・.jsx を引かない純モジュール（node:test から単体 import できる）。
// import は CL_OVERLAP_TOL_MM のみ。
// StructuralLayer.jsx から移した純計算（区間から切れ目を引く segmentsMinusGaps・基礎梁の帯の入力を作る foundationBandInputs）も置く
// （.jsx の中では node:test で振る舞いを固定できないため）。
// ================================================================
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';

// 矩形の4辺。line＝辺の座標、axis＝辺が垂直な軸（'x'＝左右の辺、'y'＝上下の辺）、sign＝外向きの符号、
// t0/t1＝辺に沿う区間。固定順（出力を入力順に決定的にする）。
const SIDES = [
  { key: 'left',   axis: 'x', sign: -1 },
  { key: 'right',  axis: 'x', sign: 1 },
  { key: 'top',    axis: 'y', sign: -1 },
  { key: 'bottom', axis: 'y', sign: 1 },
];

function validate(bands) {
  if (!Array.isArray(bands)) {
    throw new Error(`unionBandOutline: bands は配列でなければならない（実際: ${typeof bands}）`);
  }
  const seen = new Set();
  bands.forEach((b, i) => {
    const id = b?.id;
    if (![b?.axisValue, b?.lo, b?.hi, b?.half].every(Number.isFinite)) {
      throw new Error(`unionBandOutline: bands[${i}]（id=${String(id)}）の axisValue・lo・hi・half が有限の数でない`);
    }
    if (!(b.lo < b.hi)) {
      throw new Error(`unionBandOutline: bands[${i}]（id=${String(id)}）は lo < hi でなければならない（lo=${b.lo}, hi=${b.hi}）`);
    }
    if (!(b.half > 0)) {
      throw new Error(`unionBandOutline: bands[${i}]（id=${String(id)}）は half > 0 でなければならない（実際: ${b.half}）`);
    }
    if (seen.has(id)) {
      throw new Error(`unionBandOutline: id が重複している（${String(id)}）`);
    }
    seen.add(id);
  });
}

// 帯の端（軸方向の lo／hi）が直交する帯に出会うとき、その端を相手の half だけ外へ延ばした区間を返す（複数なら最大）。
function extendedSpan(b, bands, tol) {
  let lo = b.lo, hi = b.hi;
  let extLo = 0, extHi = 0;
  for (const p of bands) {
    if (p === b || p.isVertical === b.isVertical) continue;
    // 自分の軸が相手の区間（端を含む）に入るときだけ出会う。
    if (b.axisValue < p.lo - tol || b.axisValue > p.hi + tol) continue;
    if (Math.abs(b.lo - p.axisValue) <= tol) extLo = Math.max(extLo, p.half);
    if (Math.abs(b.hi - p.axisValue) <= tol) extHi = Math.max(extHi, p.half);
  }
  lo -= extLo;
  hi += extHi;
  return { lo, hi };
}

function toRect(b, span) {
  return b.isVertical
    ? { x0: b.axisValue - b.half, x1: b.axisValue + b.half, y0: span.lo, y1: span.hi }
    : { x0: span.lo, x1: span.hi, y0: b.axisValue - b.half, y1: b.axisValue + b.half };
}

// 辺（side）の座標・辺に沿う区間。
function edgeOf(r, side) {
  if (side.axis === 'x') return { line: side.sign < 0 ? r.x0 : r.x1, t0: r.y0, t1: r.y1 };
  return { line: side.sign < 0 ? r.y0 : r.y1, t0: r.x0, t1: r.x1 };
}

// 矩形 s が、辺（line・外向き sign）のすぐ外側へ入り込んでいるときの、辺に沿う区間（無ければ null）。
// 入り込む＝s が辺の直線を外向きに tol より超えて広がり、かつ内側から直線まで届く（外から接するだけの矩形も含む）。
function coverOutside(s, side, line, tol) {
  const n0 = side.axis === 'x' ? s.x0 : s.y0;
  const n1 = side.axis === 'x' ? s.x1 : s.y1;
  const reaches = side.sign < 0 ? (n0 < line - tol && n1 >= line - tol) : (n1 > line + tol && n0 <= line + tol);
  if (!reaches) return null;
  return side.axis === 'x' ? [s.y0, s.y1] : [s.x0, s.x1];
}

// [t0, t1] から cuts（区間の列）を引いた残りの区間（昇順・tol 以下は捨てる）。
function subtractIntervals(t0, t1, cuts, tol) {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  const out = [];
  let cur = t0;
  for (const [c0, c1] of sorted) {
    if (c0 > cur) out.push([cur, Math.min(c0, t1)]);
    cur = Math.max(cur, c1);
    if (cur >= t1) break;
  }
  if (cur < t1) out.push([cur, t1]);
  return out.filter(([a, b]) => b - a > tol);
}

/** 区間 [lo, hi] から gaps（[gapLo, gapHi] の列。未ソート・重なり可）を引いた残りの区間の列（昇順）。壁の開口・土台の交点の切れ目で共用する。
 *  gap が空なら [[lo, hi]]、lo>=hi なら []。gap が区間の外（hi より先）にあるときは区間の終端 hi で止める。
 *  【HEAD との差】HEAD（耐力壁の wallSegments 内）は `[cur, gapLo]` を返したため、壁 0..1000・開口 1200..1400（壁の外）で
 *  `[[0,1200]]`（壁端を越えて描く）だった。今回は `[[0,1000]]`。不良の修正の向きだが、この形だけは壁も変わる
 *  （区間内の gap・端に接する gap・重なり・逆順は HEAD と同じ）。 */
export function segmentsMinusGaps(lo, hi, gaps) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error(`segmentsMinusGaps: lo・hi が有限の数でない（lo=${lo}, hi=${hi}）`);
  }
  if (!Array.isArray(gaps)) {
    throw new Error(`segmentsMinusGaps: gaps は配列でなければならない（実際: ${typeof gaps}）`);
  }
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  const segments = [];
  let cur = lo;
  for (const [gapLo, gapHi] of sorted) {
    const end = Math.min(gapLo, hi);
    if (end > cur) segments.push([cur, end]);
    cur = Math.max(cur, gapHi);
  }
  if (hi > cur) segments.push([cur, hi]);
  return segments;
}

/** 基礎梁の帯（unionBandOutline の入力）を作る。spans: [{ beam, coord1, coord2 }]（coord1>coord2 でも可）、
 *  widthOf: beam => 描画幅 mm | null（null の梁＝帯で描かない＝入力から除く）。half＝幅/2・lo<hi に整える。入力は書き換えない。 */
export function foundationBandInputs(spans, widthOf) {
  if (!Array.isArray(spans)) {
    throw new Error(`foundationBandInputs: spans は配列でなければならない（実際: ${typeof spans}）`);
  }
  if (typeof widthOf !== 'function') {
    throw new Error(`foundationBandInputs: widthOf は関数でなければならない（実際: ${typeof widthOf}）`);
  }
  const out = [];
  for (const { beam: b, coord1, coord2 } of spans) {
    const width = widthOf(b);
    if (width == null) continue;
    out.push({
      id: b.id, isVertical: b.isVertical, axisValue: b.axisValue,
      lo: Math.min(coord1, coord2), hi: Math.max(coord1, coord2), half: width / 2,
    });
  }
  return out;
}

/** 同面で一体の帯（軸平行の矩形）の和集合の外形線を、帯ごとの線分に分けて返す。
 *  bands: [{ id, isVertical, axisValue, lo, hi, half }]（lo<hi は軸方向の区間。isVertical=true は軸が x=axisValue で lo/hi が y）
 *  戻り値: Map<id, Array<{x1,y1,x2,y2}>>（全帯の id を持つ。線が残らない帯は空配列）
 *  規則: ①軸方向の端が直交する帯に出会う（端が相手の軸に tol 以内・自分の軸が相手の区間に入る）とき、その端を相手の half だけ
 *  外へ延ばす（L の外角が閉じる。出会わない端＝自由端は延ばさない）。②矩形の辺のうち、すぐ外側が他の矩形に入る区間を取り除く。
 *  ③同じ直線・同じ外向きで重なる辺は、入力の先の帯だけに残す。④tol 以下の線分は捨てる。入力は書き換えない。 */
export function unionBandOutline(bands, { tol = CL_OVERLAP_TOL_MM } = {}) {
  validate(bands);
  const rects = bands.map(b => toRect(b, extendedSpan(b, bands, tol)));
  const result = new Map();

  bands.forEach((b, i) => {
    const segments = [];
    for (const side of SIDES) {
      const { line, t0, t1 } = edgeOf(rects[i], side);
      const cuts = [];
      rects.forEach((s, j) => {
        if (j === i) return;
        const inner = coverOutside(s, side, line, tol);
        if (inner) cuts.push(inner);
        // 同じ直線・同じ外向きの辺は先の帯に任せる（同じ線を2回描かない）。
        if (j < i) {
          const e = edgeOf(s, side);
          if (Math.abs(e.line - line) <= tol) cuts.push([e.t0, e.t1]);
        }
      });
      for (const [a, c] of subtractIntervals(t0, t1, cuts, tol)) {
        segments.push(side.axis === 'x' ? { x1: line, y1: a, x2: line, y2: c } : { x1: a, y1: line, x2: c, y2: line });
      }
    }
    result.set(b.id, segments);
  });
  return result;
}
