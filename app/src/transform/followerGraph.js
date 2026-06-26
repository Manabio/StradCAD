// 中心線移動時の「随伴して一緒に動く図形」を型をまたいで辿るための汎用BFS。
//
// 随伴関係（CLのrefId連鎖・壁のaxisCL直付き、将来は給排水・構造なども想定）は
// ANCHOR_RESOLVERS に型ごとのルールとして登録する。BFS本体は型を知らない。
//
// movingCLが通り芯（project.structGraph 共有）の場合、他フロア（採用・検討問わず）にも
// 随伴CL・随伴壁が存在し得るため、resolveMoveRange はそれらを IndexedDB から一時的に
// 読み込んで（アクティブ化はしない「peek」）走査範囲に含める。
import { CenterLine, ShapeType, Discipline, Point } from '@core';
import { floorSwapManager } from '../storage/FloorSwapManager.js';

// 「ユーザーが一目で確認できる随伴範囲」を基準にした目安値（性能上の限界ではない）。
// 運用しながら必要に応じて調整する。
export const MAX_DEPTH = 3;
export const MAX_COUNT = 30;
// 閾値判定用に正確な実測値を得るための安全上限（暴走防止。UIには出さない）
const SAFETY_DEPTH = 12;
const SAFETY_COUNT = 500;

// 図形が「何にいくつのオフセットで随伴しているか」を返すルール表。
// 新しい分野の随伴関係を追加する場合はここに1エントリ追加するだけでよい。
const ANCHOR_RESOLVERS = [
  { // 中心線の refId 連鎖（参照先からの相対オフセットで追従する随伴線）
    match:  (s) => s instanceof CenterLine && !!s.refId,
    anchor: (s) => (s._referencedCL ? { target: s._referencedCL, offset: s.refOffset } : null),
  },
  { // 壁の axisCL 直付き（軸CLと一体で移動する壁）
    match:  (s) => s.type === ShapeType.WALL,
    anchor: (s) => ({ target: s.axisCL, offset: s.axisOffset }),
  },
];

function resolveAnchor(shape) {
  for (const r of ANCHOR_RESOLVERS) {
    if (r.match(shape)) return r.anchor(shape);
  }
  return null;
}

export function isSharedCL(cl) {
  return cl.discipline === Discipline.STRUCT && cl.labeled;
}

// Intersection | Point から、移動軸方向の座標（ドラッグ中の表示位置）を取り出す。
function nodeAxisCoord(node, isV) {
  if (node instanceof Point) return isV ? node.effectiveX : node.effectiveY;
  return isV ? node.x : node.y;
}

// graphs群から候補図形（CenterLine・Wall・Diagonal）を重複なく集める。
function gatherShapes(graphs) {
  const seen = new Set();
  const centerLines = [];
  const walls = [];
  const diagonals = [];
  for (const g of graphs) {
    for (const cl of g.centerLines) {
      if (seen.has(cl)) continue;
      seen.add(cl); centerLines.push(cl);
    }
    for (const s of g.shapes) {
      if (seen.has(s)) continue;
      if (s.type === ShapeType.WALL)      { seen.add(s); walls.push(s); }
      else if (s.type === ShapeType.DIAGONAL) { seen.add(s); diagonals.push(s); }
    }
  }
  return { centerLines, walls, diagonals };
}

/**
 * movingCL に随伴する図形を不動点反復で収集する。
 * 型をまたいだ多段連鎖（CL→壁→将来の他分野要素…）を ANCHOR_RESOLVERS 経由で辿る。
 * @returns {{ offsetOf: Map<object, number>, depth: number, count: number, exceeded: object|null }}
 *   offsetOf は movingCL からの相対オフセット（movingCL 自身は 0）
 */
export function collectFollowerOffsets(shapesBundle, movingCL, { maxDepth = MAX_DEPTH, maxCount = MAX_COUNT } = {}) {
  const depthOf  = new Map([[movingCL, 0]]);
  const offsetOf = new Map([[movingCL, 0]]);
  const candidates = [...shapesBundle.centerLines, ...shapesBundle.walls].filter(s => s !== movingCL);

  let changed = true;
  while (changed) {
    changed = false;
    for (const shape of candidates) {
      if (depthOf.has(shape)) continue;
      const a = resolveAnchor(shape);
      if (!a || !a.target || !depthOf.has(a.target)) continue;
      depthOf.set(shape, depthOf.get(a.target) + 1);
      offsetOf.set(shape, offsetOf.get(a.target) + a.offset);
      changed = true;
    }
    if (depthOf.size - 1 >= SAFETY_COUNT) break;
    if (Math.max(...depthOf.values()) >= SAFETY_DEPTH) break;
  }

  const depth = Math.max(0, ...depthOf.values());
  const count = depthOf.size - 1; // movingCL 自身は除く
  const exceeded = {
    depth: depth > maxDepth ? { actual: depth, max: maxDepth } : null,
    count: count > maxCount ? { actual: count, max: maxCount } : null,
  };
  return { offsetOf, depth, count, exceeded: (exceeded.depth || exceeded.count) ? exceeded : null };
}

/**
 * 中心線移動時に許容される移動範囲 [min, max] を絶対座標 (value) で返す。
 * offsetOf に含まれる図形（movingCL自身・随伴CL・随伴壁）は障害物にならない。
 */
export function computeMoveRange(shapesBundle, movingCL, offsetOf) {
  const isV     = movingCL.centerLineType === 'X';
  const current = movingCL.value;
  let min = -Infinity, max = Infinity;

  const consider = (pos) => {
    if (pos == null || pos === current) return;
    if (pos > current) { if (pos < max) max = pos; }
    else               { if (pos > min) min = pos; }
  };
  const offsets = [...offsetOf.values()];

  for (const cl of shapesBundle.centerLines) {
    if (cl.centerLineType !== movingCL.centerLineType) continue;
    if (offsetOf.has(cl)) continue;
    for (const off of offsets) consider(cl.effectiveValue - off);
  }
  for (const wall of shapesBundle.walls) {
    if (offsetOf.has(wall)) continue;
    if (wall.isVertical !== isV) continue;
    for (const off of offsets) consider(wall.axisValue - off);
  }
  for (const shape of shapesBundle.diagonals) {
    const lo = Math.min(nodeAxisCoord(shape.nodeA, isV), nodeAxisCoord(shape.nodeB, isV));
    const hi = Math.max(nodeAxisCoord(shape.nodeA, isV), nodeAxisCoord(shape.nodeB, isV));
    for (const off of offsets) {
      const ref = current + off; // この随伴要素から見た現在位置
      if (hi <= ref)      consider(hi - off);
      else if (lo >= ref) consider(lo - off);
      // ref を跨ぐ場合は既存の交差状態のため対象外
    }
  }
  return { min, max };
}

// movingCLが通り芯（全フロア共有）の場合のみ、他フロア（採用・検討問わず）を
// IndexedDBから一時的に読み込む（アクティブ化はしない＝既存のスワップ状態に影響しない）。
async function gatherScanGraphs(project, activeGraph, movingCL) {
  if (!isSharedCL(movingCL)) return [activeGraph];
  const others = [...project.planeMap.values()].filter(p => p.id !== project.activePlaneId);
  const peeked = await Promise.all(others.map(p => floorSwapManager.peek(p, project.structGraph)));
  return [activeGraph, ...peeked];
}

/**
 * movingCL の移動範囲を解決する（非同期。通り芯の場合のみ他フロアをIDBから読み込む）。
 * @returns {Promise<{ range: {min,max} } | { exceeded: object }>}
 */
export async function resolveMoveRange(project, activeGraph, movingCL, opts = {}) {
  const graphs = await gatherScanGraphs(project, activeGraph, movingCL);
  const bundle = gatherShapes(graphs);
  const { offsetOf, exceeded } = collectFollowerOffsets(bundle, movingCL, opts);
  if (exceeded) return { exceeded };
  return { range: computeMoveRange(bundle, movingCL, offsetOf) };
}
