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

/** 立体のリテラル（汎用立体の入力・期待値用）。 */
export function solid(kind, footprint, zLo, zHi, extra = {}) {
  return { kind, footprint, zLo, zHi, source: { kind, id: extra.id ?? `${kind}-1` }, ...(extra.style ? { style: extra.style } : {}) };
}
