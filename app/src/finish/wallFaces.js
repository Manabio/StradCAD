/**
 * 部屋・階段の footprint 境界CLと、その内壁実面（壁仕上げ材の内側の角）の解決（純関数群）。
 *
 * CL偏芯の階またぎ連動（finish/eccentricityFloorSync.js）で偏芯指定・修正された壁と、
 * 階段の描画幅（stairGeometry.js の insetStairBounds）・吹抜けの×領域（voidGeometry.js）を
 * 取り合わせるために使う。壁が無い辺は cl.effectiveValue（芯）へフォールバックする
 * ——生成前・削除後でも常に何らかの矩形が得られる。
 */
import { graphList, scopedValue } from '../graphReadScope.js';

// axisCL.id → その軸上の壁。innerWallFaceAt は「部屋×面の端」ごとに呼ばれるため、
// 毎回 graph.walls を全走査すると O(面数×壁数) になる。読み取りスコープ内では索引を使い回す
// （スコープ外は従来どおり毎回組む＝全走査と同じオーダー）。
function wallsOnAxisCL(graph, axisCLId) {
  const byAxis = scopedValue(graph, 'wallFaces:byAxisCL', () => {
    const m = new Map();
    for (const w of graphList(graph, 'walls') ?? []) {
      const id = w.axisCL?.id;
      if (id == null) continue;
      const list = m.get(id);
      if (list) list.push(w); else m.set(id, [w]);
    }
    return m;
  });
  return byAxis.get(axisCLId) ?? [];
}

// 壁面の inward 判定に使う許容差(mm)
const FACE_EPS = 1e-6;
// 壁スパンと footprint 境界スパンの重なりを「有意」とみなす下限(mm)。clEccentricity.js の
// SPAN_OVERLAP_EPS と同水準（浮動小数の丸め・端点接触を誤って有意重なりと判定しない）。
const SPAN_OVERLAP_EPS = 5;

// struct CL は graph._structGraph.shapeMap に格納されるため両方を検索する（他 finish/*.js と同じ規約）
function getShape(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/**
 * cells（refreshCells 済セル集合）を包む矩形の4境界CLを返す。各辺は value 最小/最大の CL
 * （矩形footprintのみを想定。非矩形は呼び出し側が事前に形状を確認していること）。
 * @returns {{left, top, right, bottom}|null} CenterLine群（left/right=VERTICAL, top/bottom=HORIZONTAL）
 */
export function footprintBoundaryCLs(cells, graph) {
  let left = null, right = null, top = null, bottom = null;
  for (const key of cells) {
    const [L, T, R, B] = key.split(':');
    const l = getShape(graph, L), t = getShape(graph, T), r = getShape(graph, R), b = getShape(graph, B);
    if (!l || !t || !r || !b) continue;
    if (!left   || l.value < left.value)   left   = l;
    if (!right  || r.value > right.value)  right  = r;
    if (!top    || t.value < top.value)    top    = t;
    if (!bottom || b.value > bottom.value) bottom = b;
  }
  if (!left || !top || !right || !bottom) return null;
  return { left, top, right, bottom };
}

/**
 * cl（軸CL）上の壁のうち、isVertical・スパン[spanLo,spanHi]との有意重なり・inward方向
 * （footprint内部へ向かう符号）を満たすものの中から、最も内側（inwardへ最も進んだ）
 * w.axisValue を返す（w.axisValue は壁の室側仕上げ面の位置——core.js Wall 参照）。
 * 該当する壁がなければ null（呼び出し側は cl.effectiveValue へフォールバックする）。
 * 壁の同定は clId の一致のみで行う（value 近似一致は使わない——同一CL上の壁は1本の前提）。
 * @param {1|-1} inward - cl.effectiveValue から footprint 内部へ向かう符号
 */
export function innerWallFaceAt(graph, cl, { isVertical, inward, spanLo, spanHi }) {
  let best = null;
  for (const w of wallsOnAxisCL(graph, cl.id)) {
    if (w.isVertical !== isVertical) continue;
    const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
    if (Math.min(wHi, spanHi) - Math.max(wLo, spanLo) <= SPAN_OVERLAP_EPS) continue;
    if (inward * (w.axisValue - cl.effectiveValue) <= -FACE_EPS) continue;
    if (best == null || inward * (w.axisValue - best) > 0) best = w.axisValue;
  }
  return best;
}

/**
 * cells（footprint）の壁内4頂点（壁仕上げ材の内側の角。壁が無い辺は cl.effectiveValue で
 * フォールバック）と、各辺の壁有無を返す。結果が退化矩形（x2<=x1 または y2<=y1。壁面の
 * 交差・座標不整合等の異常値）なら null を返す——呼び出し側はこれをフォールバック
 * （階段は固定 WALL_INSET、吹抜けは描画スキップ）の合図として扱う。
 * @returns {{x1:number, y1:number, x2:number, y2:number, hasWall:{left:boolean, top:boolean, right:boolean, bottom:boolean}}|null}
 */
export function faceRect(cells, graph) {
  const b = footprintBoundaryCLs(cells, graph);
  if (!b) return null;
  const { left, top, right, bottom } = b;
  // 垂直CL（left/right）のスパン=直交方向（上下）の範囲、水平CL（top/bottom）のスパン=左右の範囲
  // （edgeGeometry.js の lo/hi と同じ規約。壁の coord1/coord2 もこの軸に沿う——core.js Wall 参照）
  const spanV = { lo: top.effectiveValue,  hi: bottom.effectiveValue };
  const spanH = { lo: left.effectiveValue, hi: right.effectiveValue };

  const leftFace   = innerWallFaceAt(graph, left,   { isVertical: true,  inward:  1, spanLo: spanV.lo, spanHi: spanV.hi });
  const rightFace  = innerWallFaceAt(graph, right,  { isVertical: true,  inward: -1, spanLo: spanV.lo, spanHi: spanV.hi });
  const topFace    = innerWallFaceAt(graph, top,    { isVertical: false, inward:  1, spanLo: spanH.lo, spanHi: spanH.hi });
  const bottomFace = innerWallFaceAt(graph, bottom, { isVertical: false, inward: -1, spanLo: spanH.lo, spanHi: spanH.hi });

  const rect = {
    x1: leftFace   ?? left.effectiveValue,
    y1: topFace    ?? top.effectiveValue,
    x2: rightFace  ?? right.effectiveValue,
    y2: bottomFace ?? bottom.effectiveValue,
    hasWall: { left: leftFace != null, top: topFace != null, right: rightFace != null, bottom: bottomFace != null },
  };
  if (!(rect.x2 - rect.x1 > 0 && rect.y2 - rect.y1 > 0)) return null;
  return rect;
}
