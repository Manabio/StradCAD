/**
 * 仕上げモードの背景描画（FinishModeLayer）が壁（ShapesLayer）の上に重ねて描く補助線を、
 * 壁本体の内部を通らないよう加工する純関数群。
 *
 * - 区割り線（gridDividerSegments）: 壁の実在範囲（material∪backing）と重なる部分を切り欠く
 *   （壁の中を線が通って見える不良の是正）。
 * - 外壁判定線（computeExteriorWallSegments）: CL座標ではなく外壁の外面（さらにストローク半幅ぶん
 *   外側）に描く。
 *
 * 依存は gridCells.js・wallGeneration.js・wallFaces.js・stair/stairGeometry.js(subtractIntervals)
 * のみ——FinishModeLayer.jsx の描画データ源をこの1ファイルに集約する。
 */
import { gridDividerSegments } from './gridCells.js';
import { computeExteriorWallSegments } from './wallGeneration.js';
import { outerWallFaceAt } from './wallFaces.js';
import { subtractIntervals } from './stair/stairGeometry.js';

// 浮動小数の丸め誤差だけを吸収する許容差(mm)。「面ちょうど」を内側と誤判定しないよう、
// 壁の実在範囲の厚み方向境界は厳密な開区間（この値だけ内側）で判定する。
const EPS = 1e-6;

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する（他 finish/*.js と同じ規約）。
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/**
 * graph.walls から、壁の実在範囲（material∪backing）の矩形一覧を返す（軸平行）。
 * 長さ0・軸CL未解決（厚み方向範囲が求まらない）の壁は除外する。
 * @returns {Array<{isVertical:boolean, alongLo:number, alongHi:number, acrossLo:number, acrossHi:number}>}
 */
export function wallBodyRects(graph) {
  const rects = [];
  for (const w of graph.walls) {
    if (!w.axisCL) continue;
    const alongLo = Math.min(w.coord1, w.coord2);
    const alongHi = Math.max(w.coord1, w.coord2);
    if (!(alongHi - alongLo > 0)) continue;

    const material = w.materialRange;
    const backing = w.backingRange;
    const acrossLo = backing ? Math.min(material.lo, backing.lo) : material.lo;
    const acrossHi = backing ? Math.max(material.hi, backing.hi) : material.hi;
    if (!Number.isFinite(acrossLo) || !Number.isFinite(acrossHi) || !(acrossHi - acrossLo > 0)) continue;

    rects.push({ isVertical: w.isVertical, alongLo, alongHi, acrossLo, acrossHi });
  }
  return rects;
}

/**
 * gridDividerSegments（区割り線）のうち、壁の実在範囲（wallBodyRects）と重なる部分を
 * 切り欠いた線分を返す。壁が1本も無ければ入力と同値。
 * - 直交する壁（alongLo < value < alongHi）: その壁の厚み方向区間[acrossLo,acrossHi]を
 *   区割り線の区間[lo,hi]から差し引く。
 * - 平行な壁（acrossLo+EPS < value < acrossHi-EPS。厳密に内側——面ちょうどは残す）: その壁の
 *   長さ方向区間[alongLo,alongHi]を区割り線の区間[lo,hi]から差し引く。
 * @returns {Array<{key, isVertical, value, lo, hi}>}
 */
export function dividerSegmentsOutsideWalls(graph) {
  const segs = gridDividerSegments(graph);
  const rects = wallBodyRects(graph);
  if (rects.length === 0) return segs;

  const result = [];
  for (const seg of segs) {
    const crossingCovers = [];
    const parallelCovers = [];
    for (const r of rects) {
      if (r.isVertical !== seg.isVertical) {
        if (seg.value > r.alongLo && seg.value < r.alongHi) crossingCovers.push([r.acrossLo, r.acrossHi]);
      } else {
        if (seg.value > r.acrossLo + EPS && seg.value < r.acrossHi - EPS) parallelCovers.push([r.alongLo, r.alongHi]);
      }
    }

    let pieces = crossingCovers.length > 0 ? subtractIntervals(seg.lo, seg.hi, crossingCovers) : [[seg.lo, seg.hi]];
    if (parallelCovers.length > 0) {
      const next = [];
      for (const [lo, hi] of pieces) next.push(...subtractIntervals(lo, hi, parallelCovers));
      pieces = next;
    }

    pieces.forEach(([lo, hi], i) => {
      result.push({ key: `${seg.key}:${i}`, isVertical: seg.isVertical, value: seg.value, lo, hi });
    });
  }
  return result;
}

// seg（他の外壁判定線）がboundaryCLId（セグメントが接続する角の相手軸）を軸に持ち、自分の
// 元のCL座標（rawValue。面調整前）がその相手の区間（start/end。CL座標のまま・面調整の影響を
// 受けない）に収まるなら、相手の面調整後valueを角の座標として返す。面調整後のvalue同士で
// 判定すると、互いの面調整（外側へ移動）によって角では必ず区間の外へ外れてしまい、どの矩形も
// 正しい角にならない（面調整前の設計上の位置関係で「この角か」を判定し、置き換える値だけ
// 面調整後のものを使う）。
function cornerFaceValue(seg, resolved, boundaryCLId) {
  for (const other of resolved) {
    if (other === seg || other.loopType !== seg.loopType || other.axisCLId !== boundaryCLId) continue;
    const lo = Math.min(other.start, other.end), hi = Math.max(other.start, other.end);
    if (seg.rawValue >= lo && seg.rawValue <= hi) return other.value;
  }
  return null;
}

/**
 * computeExteriorWallSegments（外壁判定線。CL座標）を、外壁の外面（さらにstrokeHalfWidthMmぶん
 * 外側）へ置き換えた線分にする。角は接続する相手の面調整後の座標に揃える（無ければCL座標のまま）。
 * @returns {Array<{key, isVertical, value, start, end, loopType}>}
 */
export function exteriorGuideSegments(graph, { strokeHalfWidthMm = 0 } = {}) {
  const base = computeExteriorWallSegments(graph);

  const resolved = base.map(seg => {
    const axisCL = getShape(graph, seg.axisCLId);
    const spanLo = Math.min(seg.start, seg.end);
    const spanHi = Math.max(seg.start, seg.end);
    const face = axisCL
      ? outerWallFaceAt(graph, axisCL, {
          isVertical: seg.isVertical, outward: seg.outwardSign, spanLo, spanHi,
          wallFilter: w => w.isExteriorWall,
        })
      : null;
    const value = face != null ? face + seg.outwardSign * strokeHalfWidthMm : seg.value;
    return { ...seg, value, rawValue: seg.value };
  });

  return resolved.map(seg => {
    const start = cornerFaceValue(seg, resolved, seg.startCLId) ?? seg.start;
    const end   = cornerFaceValue(seg, resolved, seg.endCLId)   ?? seg.end;
    return {
      key: `ew${seg.axisCLId}:${seg.loopType}:${seg.outwardSign}:${seg.startCLId}:${seg.endCLId}`,
      isVertical: seg.isVertical,
      value: seg.value,
      start, end,
      loopType: seg.loopType,
    };
  });
}
