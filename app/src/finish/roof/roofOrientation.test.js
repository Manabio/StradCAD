// 片流れの「高い側」の導出のうち graph を読む部分（roofOrientation.js）のテスト。ステップ C1b。
//   roofEdgeInteriorAdjacency: 屋根範囲の各辺の外側が同じ階の屋内に接する長さ。
//   roofHighSideViewOfRoom: 下屋の「高い側」の選択欄の表示判断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape,
} from '@core';
import { roofEdgeInteriorAdjacency, roofHighSideViewOfRoom } from './roofOrientation.js';
import { createLeanToRoofSpec, roofRoomBounds } from './roofDefaults.js';
import { rectOfBounds } from './roofGeometry.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

/** 格子 xs × ys の階。cell(i,j) は左 i 列・上 j 行のセルキー。 */
function makeGrid(xs, ys) {
  const graph = new PlanGraph(new Plane('p1', 0, '2階', 2, 1));
  const cx = xs.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `x${i}`));
  const cy = ys.map((v, j) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `y${j}`));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  const addRoom = (cells, { kind = RoomKind.INTERIOR, feature = null, name = '室' } = {}) => {
    const room = graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), name);
    room.setKind(kind);
    if (feature) room.setFeature(feature);
    if (feature === RoomFeature.ROOF) room.setRoofSpec(createLeanToRoofSpec());
    return room;
  };
  const roof = cells => addRoom(cells, { kind: RoomKind.EXTERIOR, feature: RoomFeature.ROOF, name: '屋根' });
  const rectOf = room => rectOfBounds(roofRoomBounds(room, graph));
  return { graph, addRoom, roof, rectOf };
}

const A = (top, bottom, left, right) => ({ top, bottom, left, right });
const ZERO = A(0, 0, 0, 0);

// 屋根は中央 (1,1) の 2000x1500。周囲 3x3 の格子（x:0,2000,4000,6000 / y:0,1500,3000,4500）。
const XS = [0, 2000, 4000, 6000];
const YS = [0, 1500, 3000, 4500];

test('屋内が上だけに接する屋根は top だけが屋内の長さを持つ', () => {
  const { graph, addRoom, roof, rectOf } = makeGrid(XS, YS);
  addRoom([[1, 0]]);
  const r = roof([[1, 1]]);
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), A(2000, 0, 0, 0));
});

test('屋内が左だけ・下だけ・右だけに接する屋根は、その辺だけが屋内の長さを持つ（辺の取り違えを検出）', () => {
  for (const [cellIJ, expected] of [
    [[0, 1], A(0, 0, 1500, 0)],
    [[1, 2], A(0, 2000, 0, 0)],
    [[2, 1], A(0, 0, 0, 1500)],
  ]) {
    const { graph, addRoom, roof, rectOf } = makeGrid(XS, YS);
    addRoom([cellIJ]);
    const r = roof([[1, 1]]);
    assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), expected, JSON.stringify(cellIJ));
  }
});

test('2辺に接して長さが違う: 辺ごとの長さがそのまま出る（上 2000・左 1500）', () => {
  const { graph, addRoom, roof, rectOf } = makeGrid(XS, YS);
  addRoom([[1, 0]]);
  addRoom([[0, 1]], { name: '別室' });
  const r = roof([[1, 1]]);
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), A(2000, 0, 1500, 0));
});

test('同じ長さの辺が複数ある: 各辺の長さは等しく出る（順序の決定は resolveRoofHighSide の責務）', () => {
  const { graph, addRoom, roof, rectOf } = makeGrid(XS, YS);
  addRoom([[1, 0]]);
  addRoom([[1, 2]], { name: '別室' });
  const r = roof([[1, 1]]);
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), A(2000, 2000, 0, 0));
});

test('どこにも屋内が接しない屋根（周囲は無割当）は全辺 0', () => {
  const { graph, roof, rectOf } = makeGrid(XS, YS);
  const r = roof([[1, 1]]);
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), ZERO);
});

test('辺の一部だけが屋内に接する: 接している区間の長さだけ（上辺 4000 のうち左半分 2000 が屋内）', () => {
  const { graph, addRoom, roof, rectOf } = makeGrid(XS, YS);
  addRoom([[0, 0]]); // x:0..2000, y:0..1500。屋根は x:2000..6000, y:1500..3000 の横長（2セル）
  const r = roof([[1, 1], [2, 1]]);
  assert.deepEqual(rectOf(r), { x1: 2000, y1: 1500, x2: 6000, y2: 3000 });
  // (0,0) の下辺は屋根の左隣（x:0..2000）で屋根の上辺（x:2000..6000）には接しない。左辺は y:0..1500 で屋根 y:1500..3000 に接しない
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), ZERO);
  addRoom([[1, 0]], { name: '上の室' }); // x:2000..4000 が屋根の上辺 4000 のうち 2000 に接する
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), A(2000, 0, 0, 0));
});

test('屋根セル同士の隣接・他の屋根は屋内に数えない（屋根が他の屋根に接しても 0）', () => {
  const { graph, roof, rectOf } = makeGrid(XS, YS);
  const r1 = roof([[1, 1]]);
  roof([[0, 1], [1, 0]]); // 左と上に別の屋根
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r1), graph), ZERO);
});

test('屋外部屋（バルコニー等）・未割当は屋内に数えない', () => {
  const { graph, addRoom, roof, rectOf } = makeGrid(XS, YS);
  addRoom([[1, 0]], { kind: RoomKind.EXTERIOR, name: 'バルコニー' });
  const r = roof([[1, 1]]);
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), ZERO);
});

test('未定義部屋（feature=UNDEFINED。kind は屋内）・階段の部屋は、建物範囲と同じく屋内に数える（他に屋内の部屋がある階）', () => {
  const { graph, addRoom, roof, rectOf } = makeGrid(XS, YS);
  addRoom([[2, 2]], { name: '居間' }); // 建物範囲の権威（屋根には接しない角）
  addRoom([[1, 0]], { feature: RoomFeature.UNDEFINED, name: '未定義' });
  addRoom([[0, 1]], { feature: RoomFeature.STAIR, name: '階段' });
  const r = roof([[1, 1]]);
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), A(2000, 0, 1500, 0));
});

test('階段だけの階は建物範囲が未定義（空）なので、階段に接していても 0（建物範囲の定義 footprintCellKeys に従う）', () => {
  const { graph, addRoom, roof, rectOf } = makeGrid(XS, YS);
  addRoom([[0, 1]], { feature: RoomFeature.STAIR, name: '階段' });
  const r = roof([[1, 1]]);
  assert.deepEqual(roofEdgeInteriorAdjacency(rectOf(r), graph), ZERO);
});

test('【失敗系】rect が null なら全辺 0（例外にならない）', () => {
  const { graph, addRoom } = makeGrid(XS, YS);
  addRoom([[1, 0]]);
  assert.deepEqual(roofEdgeInteriorAdjacency(null, graph), ZERO);
});

// ---- roofHighSideViewOfRoom ----

test('roofHighSideViewOfRoom: 屋内に接する辺が高い側（下屋・片流れ・矩形）。明示値が優先', () => {
  const { graph, addRoom, roof } = makeGrid(XS, YS);
  addRoom([[0, 1]]); // 左に接する
  const r = roof([[1, 1]]);
  assert.deepEqual(roofHighSideViewOfRoom(r, graph), { visible: true, value: 'left' });
  r.roofSpec.setField('highSide', 'right');
  assert.deepEqual(roofHighSideViewOfRoom(r, graph), { visible: true, value: 'right' });
});

test('roofHighSideViewOfRoom: 屋内に接しない下屋は長手に平行な辺の小さい側（横長=上・縦長=左）', () => {
  const wide = makeGrid(XS, YS);
  const rw = wide.roof([[1, 1], [2, 1]]); // 4000x1500 横長
  assert.deepEqual(roofHighSideViewOfRoom(rw, wide.graph), { visible: true, value: 'top' });
  const tall = makeGrid(XS, YS);
  const rt = tall.roof([[1, 1], [1, 2]]); // 2000x3000 縦長
  assert.deepEqual(roofHighSideViewOfRoom(rt, tall.graph), { visible: true, value: 'left' });
});

test('【失敗系】roofHighSideViewOfRoom: 形状が片流れでない（明示の切妻・寄棟・陸屋根、短手が3640超の自動の切妻）は非表示', () => {
  const hidden = { visible: false, value: null };
  for (const shape of [RoofShape.GABLE, RoofShape.HIP, RoofShape.FLAT, RoofShape.STAGGERED]) {
    const { graph, roof } = makeGrid(XS, YS);
    const r = roof([[1, 1]]);
    r.roofSpec.setField('shape', shape);
    r.roofSpec.setField('highSide', 'top');
    assert.deepEqual(roofHighSideViewOfRoom(r, graph), hidden, shape);
  }
  // 自動の形状: 短手 4000（>3640）の矩形は切妻
  const big = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  const rb = big.roof([[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.deepEqual(roofHighSideViewOfRoom(rb, big.graph), hidden, '短手 8000 → 切妻');
});

test('【失敗系】roofHighSideViewOfRoom: 矩形でない片流れ（L字の下屋。短手 3640 以下で自動は片流れ）は非表示。明示値があっても出さない', () => {
  const { graph, roof } = makeGrid(XS, YS);
  const r = roof([[1, 1], [2, 1], [1, 2]]); // L字
  assert.equal(rectOfBounds(roofRoomBounds(r, graph)), null, '前提: 矩形でない');
  assert.deepEqual(roofHighSideViewOfRoom(r, graph), { visible: false, value: null });
  r.roofSpec.setField('shape', RoofShape.MONO);
  r.roofSpec.setField('highSide', 'left');
  assert.deepEqual(roofHighSideViewOfRoom(r, graph), { visible: false, value: null });
});
