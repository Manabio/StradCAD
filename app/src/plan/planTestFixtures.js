// plan/ の単体テストが共有するフィクスチャ（実物の PlanGraph / Plane を使う。展開図の
// sectionStructure.test.js・sectionHits.test.js と同じ流儀）。
import {
  Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType, RoomKind, RoomFeature,
} from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';

export const ARCH = { labeled: false, discipline: Discipline.ARCH };
const STRUCT = { labeled: true, discipline: Discipline.STRUCT };

/**
 * 格子 xs × ys の階。cell(i,j) は左 i 列・上 j 行のセルのキー。
 * interior(cells, {walls}) … 屋内の部屋（walls:true で壁も生成）／roof(cells) … 屋根の部屋（下屋）／
 * feature(cells, feature) … 吹抜け・階段吹抜けなどの部屋。
 */
export function makeGrid(xs, ys, { id = 'p1', startFloor = 1 } = {}) {
  const graph = new PlanGraph(new Plane(id, 0, `${startFloor}階`, startFloor, 1));
  const cx = xs.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `x${i}`));
  const cy = ys.map((v, j) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `y${j}`));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  const interior = (cells, { walls = false } = {}) => {
    const room = graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '居間');
    if (walls) generateRoomWallsFromOutline(graph, room);
    return room;
  };
  const feature = (cells, f) => {
    const room = graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '特殊');
    room.setFeature(f);
    return room;
  };
  const roof = cells => {
    const room = graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '屋根');
    room.setKind(RoomKind.EXTERIOR);
    room.setFeature(RoomFeature.ROOF);
    room.setRoofSpec(createLeanToRoofSpec());
    return room;
  };
  return { graph, cx, cy, cell, interior, feature, roof };
}

/** 1部屋（x0..x1 × y0..y1）＋壁の階。 */
export function makeRoomGraph(x0, y0, x1, y1, opts) {
  const g = makeGrid([x0, x1], [y0, y1], opts);
  g.room = g.interior([[0, 0]], { walls: true });
  return g;
}

/** 層。graph を省略すると空の階。role/floorZMm/ceilZMm は buildBandLayers の層と同じ意味。 */
export function fakeLayer({ graph = new PlanGraph(new Plane('p0', 0, '1階', 1, 1)), floorZMm = 0, role = 'self', ceilZMm } = {}) {
  const layer = { graph, floorZMm, role };
  if (ceilZMm !== undefined) layer.ceilZMm = ceilZMm;
  return layer;
}

/** 水平梁（isVertical=false）: 通り芯 y=axis、x=from..to。 */
export function addBeamH(graph, { axis = 1000, from = 0, to = 2000, role = 'primary', levelOffset = 0, sectionDefId = 'STEEL-H200x100', material = StructuralMaterialType.STEEL, id } = {}) {
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, axis, STRUCT);
  const c0 = graph.addCenterLine(CenterLineType.VERTICAL, from, STRUCT);
  const c1 = graph.addCenterLine(CenterLineType.VERTICAL, to, STRUCT);
  return graph.addBeam(material, sectionDefId, axisCL, false, c0, c1, { role, levelOffset }, id);
}

/** 柱（交点 x,y）。 */
export function addColumnAt(graph, x, y, { sectionDefId = 'WOOD-105x105', material = StructuralMaterialType.WOOD, role } = {}) {
  const vx = graph.addCenterLine(CenterLineType.VERTICAL, x, STRUCT);
  const hy = graph.addCenterLine(CenterLineType.HORIZONTAL, y, STRUCT);
  return graph.addColumn(material, sectionDefId, vx, hy, role ? { role } : {});
}

export const rect = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

/**
 * 立体のリテラル（汎用立体の入力・期待値用）。extra: id / style / layerFloorZ（省略＝自階）/ part / zAt / innerLines。
 */
export function solid(kind, footprint, zLo, zHi, extra = {}) {
  return {
    kind, footprint, zLo, zHi,
    source: {
      kind, id: extra.id ?? `${kind}-1`,
      ...(extra.layerFloorZ !== undefined ? { layerFloorZ: extra.layerFloorZ } : {}),
      ...(extra.part !== undefined ? { part: extra.part } : {}),
    },
    ...(extra.style ? { style: extra.style } : {}),
    ...(extra.zAt ? { zAt: extra.zAt } : {}),
    ...(extra.innerLines ? { innerLines: extra.innerLines } : {}),
  };
}

/** 線 [x1,y1,x2,y2] を (x,y) の辞書順で小さい端から並べた新しい配列（向きに依らない比較用）。 */
export function normLine(p) {
  const [a, b, c, d] = p;
  return a < c || (a === c && b <= d) ? [a, b, c, d] : [c, d, a, b];
}

/** プリミティブから cls（省略＝全部）・source.kind（省略＝全部）で絞った線。 */
export function linesOf(prims, cls, kind) {
  return prims.filter(p => (!cls || p.cls === cls) && (!kind || p.source.kind === kind));
}

/** 線を向き正規化・小数6桁・辞書順に並べた配列（個々の線のまま。結合しない）。 */
export function sortedLines(prims) {
  return prims.map(p => normLine(p.points).map(v => Math.round(v * 1e6) / 1e6))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
}

/** 同じ直線上で重なる・接する線を1本に結んだ線の配列（和の輪郭の比較用。軸平行の線だけ対象）。 */
export function mergedLines(prims) {
  const groups = new Map();
  for (const p of sortedLines(prims)) {
    const vertical = p[0] === p[2];
    if (!vertical && p[1] !== p[3]) throw new Error('mergedLines は軸平行の線だけ');
    const key = `${vertical ? 'v' : 'h'}:${vertical ? p[0] : p[1]}`;
    if (!groups.has(key)) groups.set(key, { vertical, value: vertical ? p[0] : p[1], ivs: [] });
    groups.get(key).ivs.push(vertical ? [p[1], p[3]] : [p[0], p[2]]);
  }
  const out = [];
  for (const g of groups.values()) {
    g.ivs.sort((a, b) => a[0] - b[0]);
    let cur = null;
    const flush = () => cur && out.push(g.vertical ? [g.value, cur[0], g.value, cur[1]] : [cur[0], g.value, cur[1], g.value]);
    for (const [lo, hi] of g.ivs) {
      if (cur && lo <= cur[1] + 1e-6) cur[1] = Math.max(cur[1], hi);
      else { flush(); cur = [lo, hi]; }
    }
    flush();
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
}

/** 線の長さの総和。 */
export function totalLength(prims) {
  return prims.reduce((s, p) => s + Math.hypot(p.points[2] - p.points[0], p.points[3] - p.points[1]), 0);
}
