// 構造モード（伏図）の床開口の×（純モジュール。react-konva / store.js / snap.js / .jsx を引かない）。
// 吹抜け・昇降路・階段吹抜け・破れ先など、openingBeamAxes.js openingEdgeComponents が返す矩形成分ごとに、
// 開口を囲む梁の「内側の面」を角とする×（対角線2本）を返す。梁の無い辺は辺のCL座標（edge.coord）で代用する。
// 平面図の吹抜け×（finish/voidGeometry.js computeVoidCrosses。壁の内面基準）とは基準が違うため別実装。
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { rectangularSidesOf } from './openingBeamAxes.js';

// 辺から外向き（開口と反対側）に探す最大距離(mm)。梁芯の逃げ＝下地帯半幅＋梁幅/2
// （13.stq=95、在来木造=約120）を全構造で覆う前提値。これを超えて離れた梁は開口の縁梁と見なさない。
export const OPENING_CROSS_SEARCH_MM = 300;
// 辺から内向き（開口側）に探す最大距離は min(OPENING_CROSS_SEARCH_MM, 開口のその方向の寸法/2)。
// 柱外面合わせの偏芯で大梁が通り芯より内側に入る（13.stq=225）ぶんを拾いつつ、開口の中心線を越えない
// （対辺側の梁を誤って採らない）。

// 開口の縁梁にならない役割（屋根/基礎専用・土台）。隔て梁は床レベルで辺に立つので縁梁。
// 踊り場受け梁 LG（'landing'）も縁梁に含める——LG 区間には床大梁 G を置かない設計のため、階段吹抜けの
// 踊り場側の辺では LG が伏図に描かれる唯一の縁部材。×は「描かれた部材の内側」で閉じるのが目的であり、
// 小梁の配置規則で LG を支えにしないこととは別の判断（リード裁定 2026-10-08）。
const NON_BOUNDARY_ROLES = new Set(['roofBeam', 'foundation', 'sill']);

/**
 * 1辺を囲む梁（辺と平行・区間が重なる・探索帯の中で辺に最も近い）の内側の面の座標を返す。
 * 梁が無ければ edge.coord。最寄りが同距離のときは外向き（開口の外側にある梁）を縁梁とする。
 * beamHalfWidthOf が null/undefined を返したら 0 とみなす。
 * @param {number} dim 開口の辺に直交する方向の成分寸法（内向きの探索幅の上限＝dim/2。辺の長さではない）
 * @returns {number}
 */
function innerFaceOf(edge, dim, beams, beamHalfWidthOf) {
  const inward = Math.min(OPENING_CROSS_SEARCH_MM, dim / 2);
  let best = null;
  let bestDist = Infinity;
  let bestOffset = -Infinity;
  for (const b of beams) {
    if (NON_BOUNDARY_ROLES.has(b.role)) continue;
    if (b.isVertical !== edge.isVertical) continue;
    const a = b.clStart.effectiveValue, c = b.clEnd.effectiveValue;
    const overlap = Math.min(edge.hi, Math.max(a, c)) - Math.max(edge.lo, Math.min(a, c));
    if (!(overlap > CL_OVERLAP_TOL_MM)) continue;
    const offset = edge.outwardSign * (b.axisValue - edge.coord); // 外向きを正
    if (offset < -inward || offset > OPENING_CROSS_SEARCH_MM) continue;
    const dist = Math.abs(offset);
    // 同距離（外向き+d と内向き−d）は外向きを採る。入力順に依存しない。
    if (dist < bestDist || (dist === bestDist && offset > bestOffset)) { best = b; bestDist = dist; bestOffset = offset; }
  }
  if (!best) return edge.coord;
  return best.axisValue - edge.outwardSign * (beamHalfWidthOf(best) ?? 0);
}

/**
 * 内側矩形を横断する梁で区切った区間（1方向）。横断梁＝この方向の軸が帯ごと内側矩形の内側（厳密）にあり、
 * 区間が内側矩形の全長を覆う梁（途中で終わる梁は分割しない。縁梁は帯が内側面に接するので横断ではない）。
 * 各梁の描画面（軸±半幅）の間は区間に含めない。潰れた区間（幅≦0）は返さない。
 * @param {boolean} vertical true＝縦梁（軸がx）で x 方向を区切る
 * @returns {Array<[number, number]>}
 */
function crossSpans(inner, vertical, beams, beamHalfWidthOf) {
  const lo = vertical ? inner.x1 : inner.y1, hi = vertical ? inner.x2 : inner.y2;
  const sLo = vertical ? inner.y1 : inner.x1, sHi = vertical ? inner.y2 : inner.x2;
  const cuts = [];
  for (const b of beams) {
    if (NON_BOUNDARY_ROLES.has(b.role)) continue;
    if (b.isVertical !== vertical) continue;
    const half = beamHalfWidthOf(b) ?? 0;
    if (!(b.axisValue - half > lo) || !(b.axisValue + half < hi)) continue;
    const a = b.clStart.effectiveValue, c = b.clEnd.effectiveValue;
    if (Math.min(a, c) > sLo + CL_OVERLAP_TOL_MM || Math.max(a, c) < sHi - CL_OVERLAP_TOL_MM) continue;
    cuts.push({ axis: b.axisValue, half });
  }
  cuts.sort((p, q) => p.axis - q.axis || p.half - q.half);
  const spans = [];
  let start = lo;
  for (const { axis, half } of cuts) {
    if (axis - half - start > 0) spans.push([start, axis - half]);
    start = Math.max(start, axis + half);
  }
  if (hi - start > 0) spans.push([start, hi]);
  return spans;
}

/**
 * 矩形成分ごとの×（対角線2本）。成分の並び順どおり・成分内は「左上-右下」「左下-右上」の順。
 * 内側の矩形を全長で横断する梁があれば、その梁の描画面で区切った小矩形ごとに×を出す
 * （小矩形は y→x の昇順。inner＝その小矩形）。
 * 内側の矩形が潰れる（幅・高さ≦0）成分、4辺そろわない成分は出さない。
 * @param {Array<Array<{isVertical:boolean, coord:number, lo:number, hi:number, outwardSign:1|-1, componentId?:string}>>} components
 *   openingEdgeComponents の戻り値（成分ごとの4辺）
 * @param {Array<object>} beams graph.beams（isVertical / axisValue / clStart / clEnd / role）
 * @param {{beamHalfWidthOf: (beam:object)=>number}} opts 梁の描画半幅（略図の単線は0＝軸線まで）
 * @returns {Array<{componentId:string, x1:number, y1:number, x2:number, y2:number,
 *   inner:{x1:number, y1:number, x2:number, y2:number}}>} inner＝内側の矩形（左上x1,y1・右下x2,y2）
 */
export function openingCrossSegments(components, beams, { beamHalfWidthOf }) {
  const out = [];
  components.forEach((edges, index) => {
    const sides = rectangularSidesOf(edges); // 縦横の分類・昇順整列・矩形判定は小梁と共通
    if (!sides) return;
    const { v1, v2, h1, h2 } = sides;
    const w = v2.coord - v1.coord, h = h2.coord - h1.coord;
    const inner = {
      x1: innerFaceOf(v1, w, beams, beamHalfWidthOf), y1: innerFaceOf(h1, h, beams, beamHalfWidthOf),
      x2: innerFaceOf(v2, w, beams, beamHalfWidthOf), y2: innerFaceOf(h2, h, beams, beamHalfWidthOf),
    };
    if (!(inner.x2 - inner.x1 > 0) || !(inner.y2 - inner.y1 > 0)) return;
    const componentId = edges[0].componentId ?? String(index);
    const xs = crossSpans(inner, true, beams, beamHalfWidthOf);
    const ys = crossSpans(inner, false, beams, beamHalfWidthOf);
    for (const [y1, y2] of ys) {
      for (const [x1, x2] of xs) {
        const sub = { x1, y1, x2, y2 };
        out.push({ componentId, x1, y1, x2, y2, inner: sub });
        out.push({ componentId, x1, y1: y2, x2, y2: y1, inner: sub });
      }
    }
  });
  return out;
}
