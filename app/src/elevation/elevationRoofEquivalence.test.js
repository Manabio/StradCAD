// 屋根（RoomFeature.ROOF。ステップB1a）: 展開図・断面の屋根の描画は対象外（ユーザー裁定）なので、
// 屋根セルは展開図・断面の判定でも「部屋の無いセル（無割当）」と同値でなければならない
// ——屋根を付けても展開図・断面は付ける前と1プリミティブも変わらない。
// 比較は帯のプリミティブ列（plain object）をUUIDだけ出現順に正規化して JSON で行う
// （エンティティやグラフを assert の差分表示へ渡さない）。対照: 同じセルが通常の屋内部屋なら一致しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomKind, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildEnclosureCellToRoom, buildCellToRoom } from '../finish/edgeClassify.js';
import { buildStairBand } from './elevationStair.js';
import { buildRoomBand } from './elevationBand.js';
import { roomAtFaceSide, buildRoomFaces } from './elevationFaces.js';
import { isRealRoom } from './section/sectionLayerStack.js';
import { buildSpaceIndex } from './space/spaceModel.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalize(value) {
  const seen = new Map();
  return JSON.stringify(value).replace(UUID, (id) => {
    if (!seen.has(id)) seen.set(id, `#${seen.size}`);
    return seen.get(id);
  });
}

function addRoomOf(graph, cell, mode) {
  if (mode === 'none') return null;
  const room = graph.addRoom(new Set([cell]), mode === 'roof' ? '屋根' : '居間');
  if (mode === 'roof') { room.setKind(RoomKind.EXTERIOR); room.setFeature(RoomFeature.ROOF); }
  return room;
}

// 下の階: 折返し階段（踊り場 y:0..1500 全幅＋往路・復路レーン y:1500..4500）。
// 上の階（elevation 2400）: 踊り場の真上のセル x:0..2000 × y:0..1500 を mode（roof/none/interior）にする。
function stairBandFor(mode) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, ARCH);
  const landingKey = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const cells = new Set([landingKey, `${x0.id}:${ym.id}:${xm.id}:${y1.id}`, `${xm.id}:${ym.id}:${x1.id}:${y1.id}`]);
  const room = graph.addRoom(cells, '階段');
  generateRoomWallsFromOutline(graph, room);
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });

  const upper = new PlanGraph(new Plane('p2', 2400, '2階', 1, 1));
  const ux0 = upper.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
  const ux1 = upper.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH);
  const uy0 = upper.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const uy1 = upper.addCenterLine(CenterLineType.HORIZONTAL, 1500, ARCH);
  upper.addCenterLine(CenterLineType.HORIZONTAL, 4500, ARCH); // 階段の全幅が上階の格子にも載るように
  addRoomOf(upper, `${ux0.id}:${uy0.id}:${ux1.id}:${uy1.id}`, mode);

  const band = buildStairBand(room, graph, upper, { stair, floorHeight: 2400 });
  return normalize(band.primitives);
}

test('【屋根・展開図】階段の帯（上階の屋根セル）は、同じセルが無割当の帯とプリミティブ列が一致する', () => {
  const roof = stairBandFor('roof');
  const none = stairBandFor('none');
  assert.ok(roof.length > 1000, '前提: プリミティブが出ている');
  assert.equal(roof, none);
});

test('【屋根・展開図・対照】階段の帯: 上階の同じセルが通常の屋内部屋なら無割当の帯と一致しない（検出力の確認）', () => {
  assert.notEqual(stairBandFor('interior'), stairBandFor('none'));
});

// 屋根セル自身の階を切る帯: 同じ階に屋根セルが隣接する部屋の帯（壁の向こう側のセル解決）。
function roomBandFor(mode) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, ARCH);
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 8000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  addRoomOf(graph, `${x1.id}:${y0.id}:${x2.id}:${y1.id}`, mode);
  return { graph, room, band: normalize(buildRoomBand(room, graph).primitives) };
}

test('【屋根・展開図】同じ階に屋根セルが隣接する部屋の帯は、隣が無割当の帯とプリミティブ列が一致する', () => {
  assert.equal(roomBandFor('roof').band, roomBandFor('none').band);
});

test('【屋根・展開図】roomAtFaceSide: 壁の向こう側（外向き）が屋根でも無割当と同じ null、屋内部屋なら部屋を返す（対照）', () => {
  const probe = (mode) => {
    const { graph, room } = roomBandFor(mode);
    const faces = buildRoomFaces(room, graph);
    const right = faces.find(f => f.isVertical && f.axisCL.value === 4000);
    // inward は室内向き。外向き（屋根・隣室側）を引くため逆符号のフェイスを使わず、内側から見た面の反対側を直接引く。
    const outsideFace = { ...right, inward: -right.inward };
    return roomAtFaceSide(outsideFace, 1500, graph);
  };
  assert.equal(probe('roof'), null);
  assert.equal(probe('none'), null);
  assert.equal(probe('interior')?.name, '居間');
});

test('【屋根・断面】buildSpaceIndex.cellAt: 屋根セルは room=null・ceilZ=null（無割当のセルと同じ）。屋内部屋なら部屋と ceilZ を持つ（対照）', () => {
  const cellAtRoofPoint = (mode) => {
    const { graph } = roomBandFor(mode);
    const layer = { graph, floorZMm: 0, role: 'self' };
    return buildSpaceIndex([layer]).cellAt(layer, 6000, 1500);
  };
  const roof = cellAtRoofPoint('roof');
  const none = cellAtRoofPoint('none');
  assert.equal(roof.room, null);
  assert.equal(roof.ceilZ, null);
  assert.deepEqual({ floorZ: roof.floorZ, ceilZ: roof.ceilZ }, { floorZ: none.floorZ, ceilZ: none.ceilZ });
  const interior = cellAtRoofPoint('interior');
  assert.ok(interior.room && interior.ceilZ != null);
});

test('isRealRoom: 屋根は実床なし（false）。通常の屋内部屋は true、VOID・STAIR_VOID・昇降路・null は false', () => {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const mk = (feature, kind = RoomKind.INTERIOR) => { const r = g.addRoom(new Set([`d${Math.random()}`]), 'r'); r.setKind(kind); r.setFeature(feature); return r; };
  assert.equal(isRealRoom(mk(RoomFeature.ROOF, RoomKind.EXTERIOR)), false);
  assert.equal(isRealRoom(mk(null)), true);
  assert.equal(isRealRoom(mk(RoomFeature.VOID)), false);
  assert.equal(isRealRoom(mk(RoomFeature.STAIR_VOID)), false);
  assert.equal(isRealRoom(mk(RoomFeature.ELEVATOR_EQUIPMENT)), false);
  assert.equal(isRealRoom(null), false);
});

test('buildEnclosureCellToRoom: 屋根セルだけを索引から除く（buildCellToRoom は変えない。屋外部屋・屋内部屋は残る）', () => {
  const { graph, extra } = (() => {
    const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
    const x = [0, 1000, 2000, 3000].map(v => g.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
    const y = [0, 1000].map(v => g.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
    const cell = (i) => `${x[i].id}:${y[0].id}:${x[i + 1].id}:${y[1].id}`;
    g.addRoom(new Set([cell(0)]), '居間');
    const terrace = g.addRoom(new Set([cell(1)]), 'テラス');
    terrace.setKind(RoomKind.EXTERIOR);
    const roof = g.addRoom(new Set([cell(2)]), '屋根');
    roof.setKind(RoomKind.EXTERIOR);
    roof.setFeature(RoomFeature.ROOF);
    return { graph: g, extra: cell(2) };
  })();
  assert.equal(buildCellToRoom(graph).get(extra)?.feature, RoomFeature.ROOF, '壁側の索引は屋根を部屋として引ける');
  const m = buildEnclosureCellToRoom(graph);
  assert.equal(m.has(extra), false);
  assert.equal(m.size, 2);
});
