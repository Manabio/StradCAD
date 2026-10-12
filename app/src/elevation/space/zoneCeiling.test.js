// zoneCeiling.js（展開図が天伏の平面区画の高さに追従するための点問い合わせ）の単体テスト。
// 区画の作り方は ceiling/ceilingHeightField.test.js と同じ fixture。期待値はリテラル。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, StairType, Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import {
  zoneCeilingFieldOf, zoneCeilingChAt, zoneCeilingChAlong, zoneCeilingChTopAt, zoneCeilingEdgesAlong, zoneCeilingFarEdge,
} from './zoneCeiling.js';
import { createZone } from '../../ceiling/ceilingZones.js';
import { setRoomCeilingShape } from '../../ceiling/roomCeilingShape.js';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { worldToCell, CEILING_CELL_GRID } from '../../finish/gridCells.js';
import { buildCeilingHeightField } from '../../ceiling/ceilingHeightField.js';
import { makeGrid } from '../../plan/planTestFixtures.js';

const flat = mm => ({ heightMm: mm, shape: 'flat', dims: [] });

// 主寝室型: 2室分の幅 x 0..2000 / 2000..5000、左 2400・右 3000 の平面区画（部屋CH 2500）
function twoZoneGrid() {
  const g = makeGrid([0, 2000, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(2400)).zones);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], flat(3000)).zones);
  return { ...g, room };
}

test('【区画なしは field null】区画を持たない図面と graph null は null（何も変わらない早道）', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  g.interior([[0, 0]]);
  assert.equal(zoneCeilingFieldOf(g.graph), null);
  assert.equal(zoneCeilingFieldOf(null), null);
  assert.equal(zoneCeilingChAt(null, null, 0, 0), null);
});

test('【平面区画は chMm】区画の上の点は区画の高さ（部屋 FL 基準）・区画の無い残りは null', () => {
  const g = makeGrid([0, 2000, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], flat(3000)).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.ok(f);
  assert.equal(zoneCeilingChAt(f, room, 3500, 1500), 3000);
  assert.equal(zoneCeilingChAt(f, room, 1000, 1500), null, '区画に入らない残りは部屋の CH に落とす');
  assert.equal(zoneCeilingChAt(f, room, 9000, 1500), null, '面の外');
});

test('【床段差の二重加算なし】床 +100 の部屋の区画は chMm のまま（床段差を含まない）', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setFloorLevel(100);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(3000)).zones);
  assert.equal(zoneCeilingChAt(zoneCeilingFieldOf(g.graph), room, 1000, 1500), 3000);
});

test('【失敗系】円弧・ドームの区画だけの図面は field null（E4 まで対象外。部屋の CH に落とす）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2400, shape: 'dome', dims: [500] }).zones);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.equal(f, null, '使える面が0なら field ごと null');
  assert.equal(zoneCeilingChAt(f, room, 1000, 1500), null);
  assert.equal(zoneCeilingChAlong(f, room, { isVertical: false, depthCoord: 1500, lo: 0, hi: 1000 }), null);
  assert.equal(zoneCeilingChTopAt(f, room, 1000, 1500), null);
});

// 傾斜の区画: 1セル x 0..4000 × y 0..3000・底 2400・ライズ 600・向き dir
function slopeGrid(dir) {
  const g = makeGrid([0, 4000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [600, dir] }).zones);
  return { ...g, room, f: zoneCeilingFieldOf(g.graph) };
}
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg} 実際:${actual} 期待:${expected}`);

test('【slope の面の両端値】向き 0/180（走りが x の面）: 全長で 2400→3000／3000→2400・半分の区間で 2400→2700', () => {
  const q = { isVertical: false, depthCoord: 1500, probeDepth: 1495 };
  for (const [dir, lo, hi] of [[0, 2400, 3000], [180, 3000, 2400]]) {
    const { room, f } = slopeGrid(dir);
    const full = zoneCeilingChAlong(f, room, { ...q, lo: 0, hi: 4000 });
    near(full.chLo, lo, `dir ${dir} lo`); near(full.chHi, hi, `dir ${dir} hi`);
  }
  const { room, f } = slopeGrid(0);
  const half = zoneCeilingChAlong(f, room, { ...q, lo: 0, hi: 2000 });
  near(half.chLo, 2400, '半分 lo'); near(half.chHi, 2700, '半分 hi');
});

test('【slope の面の両端値】向き 90/270（走りが y の面）: 全長で 2400→3000／3000→2400', () => {
  for (const [dir, lo, hi] of [[90, 2400, 3000], [270, 3000, 2400]]) {
    const { room, f } = slopeGrid(dir);
    const v = zoneCeilingChAlong(f, room, { isVertical: true, depthCoord: 2000, probeDepth: 1995, lo: 0, hi: 3000 });
    near(v.chLo, lo, `dir ${dir} lo`); near(v.chHi, hi, `dir ${dir} hi`);
  }
});

test('【走りに直交する傾斜は両端同値で奥行き座標の値】向き 90 の傾斜を水平の面（走り x・奥行き y）で見ると depthCoord=750 で 2400+600×750/3000', () => {
  const { room, f } = slopeGrid(90);
  const c = zoneCeilingChAlong(f, room, { isVertical: false, depthCoord: 750, probeDepth: 755, lo: 100, hi: 3900 });
  near(c.chLo, 2550, 'lo'); near(c.chHi, 2550, 'hi');
});

test('【flat は両端同値】区画つき平面は {chMm, chMm}・区画なしの残りは null', () => {
  const g = makeGrid([0, 2000, 5000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], flat(3000)).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.deepEqual(zoneCeilingChAlong(f, room, { isVertical: false, depthCoord: 1500, lo: 2000, hi: 5000 }), { chLo: 3000, chHi: 3000 });
  assert.equal(zoneCeilingChAlong(f, room, { isVertical: false, depthCoord: 1500, lo: 0, hi: 2000 }), null, '区画に入らない残り（平面）は null');
});

test('【arc・dome・他の部屋・面なし・両端が別の面は null】', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [600, 0] }).zones);
  const b = g.interior([[1, 0]]);
  b.setCeilingZones(createZone(g.graph, b, [g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const c = g.interior([[2, 0]]);
  c.setCeilingZones(createZone(g.graph, c, [g.cell(2, 0)], { heightMm: 2400, shape: 'dome', dims: [500] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  const q = (lo, hi) => ({ isVertical: false, depthCoord: 1500, lo, hi });
  assert.ok(zoneCeilingChAlong(f, a, q(0, 2000)), '前提: a の傾斜は引ける');
  assert.equal(zoneCeilingChAlong(f, b, q(2000, 4000)), null, '円弧');
  assert.equal(zoneCeilingChAlong(f, c, q(4000, 6000)), null, 'ドーム');
  assert.equal(zoneCeilingChAlong(f, b, q(0, 2000)), null, '他の部屋の面');
  assert.equal(zoneCeilingChAlong(f, a, q(7000, 9000)), null, '面なし');
  assert.equal(zoneCeilingChAlong(f, a, q(1000, 3000)), null, '両端が別の面（辺で割っていない片）は防御で null');
  assert.equal(zoneCeilingChAlong(f, null, q(0, 2000)), null);
  assert.equal(zoneCeilingChAlong(null, a, q(0, 2000)), null);
});

test('【ChTopAt】slope は chMm＋ライズ・flat 区画は chMm・arc/dome/面なし/他の部屋は null', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [600, 0] }).zones);
  const b = g.interior([[1, 0]]);
  b.setCeilingZones(createZone(g.graph, b, [g.cell(1, 0)], { heightMm: 2700, shape: 'flat', dims: [] }).zones);
  const c = g.interior([[2, 0]]);
  c.setCeilingZones(createZone(g.graph, c, [g.cell(2, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.equal(zoneCeilingChTopAt(f, a, 100, 1500), 3000, '低い側の点でも最高点');
  assert.equal(zoneCeilingChTopAt(f, b, 3000, 1500), 2700);
  assert.equal(zoneCeilingChTopAt(f, c, 5000, 1500), null, '円弧');
  assert.equal(zoneCeilingChTopAt(f, a, 3000, 1500), null, '他の部屋の面');
  assert.equal(zoneCeilingChTopAt(f, a, 9000, 1500), null, '面なし');
  assert.equal(zoneCeilingChTopAt(null, a, 100, 1500), null);
});

test('【includeShaped】slope の辺は既定では返らず、指定すると返る（arc の辺は返らない）', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const a = g.interior([[0, 0], [1, 0]]);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [600, 0] }).zones);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  const q = { isVertical: false, depthCoord: 1500, lo: -100, hi: 7000 };
  assert.deepEqual(zoneCeilingEdgesAlong(f, q), []);
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, includeShaped: true }), [0, 2000], 'slope（x 0..2000）の辺だけ');
});

test('【失敗系】他の部屋の面・room null・STAIR の対の部屋の区画・STAIR_VOID の面は null', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  a.setCeilingZones(createZone(g.graph, a, [g.cell(0, 0)], flat(2700)).zones);
  const b = g.interior([[1, 0]]);
  const pair = g.feature([[2, 0]], RoomFeature.STAIR);
  g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(2, 0)]) });
  pair.setCeilingZones(createZone(g.graph, pair, [g.cell(2, 0)], flat(2800)).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.equal(zoneCeilingChAt(f, a, 1000, 1500), 2700);
  assert.equal(zoneCeilingChAt(f, b, 1000, 1500), null, '他の部屋の面');
  assert.equal(zoneCeilingChAt(f, null, 1000, 1500), null, 'room null');
  assert.equal(zoneCeilingChAt(f, pair, 5000, 1500), null, '天井を持たない STAIR の対の部屋');
  const g2 = makeGrid([0, 2000, 4000], [0, 3000]);
  const ok = g2.interior([[0, 0]]);
  ok.setCeilingZones(createZone(g2.graph, ok, [g2.cell(0, 0)], flat(2700)).zones);
  const sv = g2.feature([[1, 0]], RoomFeature.STAIR_VOID);
  assert.equal(zoneCeilingChAt(zoneCeilingFieldOf(g2.graph), sv, 3000, 1500), null, 'STAIR_VOID の面は zoneId なし');
});

test('【失敗系】getFinishInfo が例外を投げる部屋がいても zoneCeilingFieldOf は例外にせず null', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(2700)).zones);
  const bad = g.interior([[1, 0]]);
  bad.getFinishInfo = () => { throw new Error('壊れた部屋'); };
  assert.throws(() => buildCeilingHeightField(g.graph), /壊れた部屋/, '前提: 足場そのものは例外を投げる');
  let f;
  assert.doesNotThrow(() => { f = zoneCeilingFieldOf(g.graph); });
  assert.equal(f, null, '例外は握りつぶして区画なし扱い（展開図全体を巻き添えにしない）');
});

test('【辺は探査行を含む矩形だけ・(lo,hi) の内側だけ・昇順】', () => {
  const { graph, room } = twoZoneGrid();
  const f = zoneCeilingFieldOf(graph);
  // 面は水平（isVertical=false）: 走り方向 x・奥行き y。区画の x 辺は 0, 2000, 5000
  const q = { isVertical: false, depthCoord: 1500, lo: -100, hi: 6000 };
  assert.deepEqual(zoneCeilingEdgesAlong(f, q), [0, 2000, 5000]);
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, lo: 0, hi: 5000 }), [2000], '端点ちょうどは含めない');
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, depthCoord: 3500 }), [], '奥行きが矩形の外');
  assert.deepEqual(zoneCeilingEdgesAlong(f, { ...q, depthCoord: 0 }), [], '奥行きが矩形の辺ちょうど（厳密に含まない）');
  assert.deepEqual(zoneCeilingEdgesAlong(null, q), []);
  // 垂直面: 走り方向 y・奥行き x。y 辺は 0, 3000
  assert.deepEqual(zoneCeilingEdgesAlong(f, { isVertical: true, depthCoord: 1000, lo: -1, hi: 9999 }), [0, 3000]);
  assert.ok(room);
});

// ---- zoneCeilingFarEdge（E3b-1: 視線の先＝奥の端の高さ）----
const slope = (mm, rise, dir) => ({ heightMm: mm, shape: 'slope', dims: [rise, dir] });

// 3000×2000 の1室に区画 slope[600, dir]（底 2400）。
function slopeRoom(dir, opts = {}) {
  const g = makeGrid([0, 3000], [0, 2000]);
  const room = g.interior([[0, 0]], opts);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], slope(2400, 600, dir)).zones);
  return { ...g, room, field: zoneCeilingFieldOf(g.graph) };
}

test('【奥の端・4方向×面の向き】水平の面（走り x・奥行き y）と垂直の面（走り y・奥行き x）で、視線の向き ±1 ごとに奥の端の高さが 2400/3000 になる', () => {
  // [isVertical, startCoord, dir, 勾配の向き, run, 期待 chLo=chHi]
  const cases = [
    [false, 0, +1, 90, [500, 2500], 3000],    // y=2000 が奥・+y に上がる→高い側
    [false, 0, +1, 270, [500, 2500], 2400],   // 奥が低い側
    [false, 2000, -1, 90, [500, 2500], 2400], // 反対側から見る: 奥は y=0
    [false, 2000, -1, 270, [500, 2500], 3000],
    [true, 0, +1, 0, [200, 1800], 3000],      // x=3000 が奥・+x に上がる
    [true, 0, +1, 180, [200, 1800], 2400],
    [true, 3000, -1, 0, [200, 1800], 2400],   // 奥は x=0
    [true, 3000, -1, 180, [200, 1800], 3000],
  ];
  for (const [isVertical, startCoord, dir, sd, [runLo, runHi], expected] of cases) {
    const { room, graph, field } = slopeRoom(sd);
    const r = zoneCeilingFarEdge(field, graph, room, { isVertical, runLo, runHi, startCoord, dir });
    const label = `isVertical=${isVertical} start=${startCoord} dir=${dir} 勾配=${sd}`;
    assert.ok(r, label);
    assert.equal(r.alongRun, false, label);
    assert.equal(r.chLo, expected, label);
    assert.equal(r.chHi, expected, `${label}: 奥行き方向の傾斜は走りによらず同値`);
  }
});

test('【奥の端・走り方向の傾斜は alongRun】水平の面で +x 勾配は runLo/runHi の高さ（500→2500, 2500→2900）、垂直の面で -y 勾配は 200→2940, 1800→2460', () => {
  {
    const { room, graph, field } = slopeRoom(0);
    const r = zoneCeilingFarEdge(field, graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 });
    assert.deepEqual(r, { chLo: 2500, chHi: 2900, alongRun: true });
  }
  {
    const { room, graph, field } = slopeRoom(270);
    const r = zoneCeilingFarEdge(field, graph, room, { isVertical: true, runLo: 200, runHi: 1800, startCoord: 0, dir: +1 });
    assert.equal(r.alongRun, true);
    assert.ok(Math.abs(r.chLo - 2940) < 1e-9 && Math.abs(r.chHi - 2460) < 1e-9, JSON.stringify(r));
  }
});

test('【奥の端に壁あり】奥 y=2000 の壁の仕上げ面（2000−57.5）で評価する＝2400+600×1942.5/2000＝2982.75。壁なしは座標 2000 の 3000', () => {
  const q = { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 };
  const walled = slopeRoom(90, { walls: true });
  assert.ok(Math.abs(zoneCeilingFarEdge(walled.field, walled.graph, walled.room, q).chLo - 2982.75) < 1e-9);
  const plain = slopeRoom(90);
  assert.equal(zoneCeilingFarEdge(plain.field, plain.graph, plain.room, q).chLo, 3000);
});

test('【奥の端に壁あり・天井芯が先】同座標 y=2000 に天井芯（先頭）と中心線（後）が並んでも、中心線の壁の仕上げ面 2982.75 で評価する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.CEILING });
  const cl = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1] = [cl(CenterLineType.VERTICAL, 0), cl(CenterLineType.VERTICAL, 3000)];
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 2000)];
  assert.equal(graph.centerLines[0].discipline, Discipline.CEILING, '前提: 天井芯が先頭');
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '居間');
  generateRoomWallsFromOutline(graph, room);
  const key = worldToCell(1500, 1000, graph, CEILING_CELL_GRID).key;
  room.setCeilingZones(createZone(graph, room, [key], slope(2400, 600, 90)).zones);
  const r = zoneCeilingFarEdge(zoneCeilingFieldOf(graph), graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 });
  assert.ok(r && Math.abs(r.chLo - 2982.75) < 1e-9, JSON.stringify(r));
});

test('【面が奥で途切れる・同じ面が続く】区画が 2 セル（y0..1000, 1000..2000）なら奥は 2000（3000）。1000 で別の区画に変わるなら奥は 1000（区画 A の bbox の高い側 3000）', () => {
  {
    const g = makeGrid([0, 3000], [0, 1000, 2000]);
    const room = g.interior([[0, 0], [0, 1]]);
    room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0), g.cell(0, 1)], slope(2400, 600, 90)).zones);
    const r = zoneCeilingFarEdge(zoneCeilingFieldOf(g.graph), g.graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 });
    assert.equal(r.chLo, 3000, '同じ面の 2 矩形を越えて y=2000 まで進む');
  }
  {
    const g = makeGrid([0, 3000], [0, 1000, 2000]);
    const room = g.interior([[0, 0], [0, 1]]);
    room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], slope(2400, 600, 90)).zones);
    room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 1)], flat(2700)).zones);
    const f = zoneCeilingFieldOf(g.graph);
    const r = zoneCeilingFarEdge(f, g.graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 });
    assert.deepEqual(r, { chLo: 3000, chHi: 3000, alongRun: false }, '区画 A の奥 y=1000 で止まる（2 矩形の面ではない）');
    assert.deepEqual(zoneCeilingFarEdge(f, g.graph, room, { isVertical: false, runLo: 500, runHi: 2500, startCoord: 1000, dir: +1 }),
      { chLo: 2700, chHi: 2700, alongRun: false }, '区画 B の中から始めれば平面');
  }
});

test('【平面の区画は従来と同じ値】flat 区画は {chMm, chMm, alongRun false}。床段差 +100 でも chMm のまま（床段差を含まない）', () => {
  const g = makeGrid([0, 3000], [0, 2000]);
  const room = g.interior([[0, 0]]);
  room.setFloorLevel(100);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], flat(2700)).zones);
  const r = zoneCeilingFarEdge(zoneCeilingFieldOf(g.graph), g.graph, room, { isVertical: false, runLo: 100, runHi: 900, startCoord: 0, dir: +1 });
  assert.deepEqual(r, { chLo: 2700, chHi: 2700, alongRun: false });
});

test('【部屋形状の傾斜も対象】区画なしの部屋形状 slope[300,+y]（部屋の CH 2500）は奥の端 2800。床段差込みの zMm は使わない', () => {
  const g = makeGrid([0, 3000], [0, 2000]);
  const room = g.interior([[0, 0]]);
  room.setOverride('ceilingHeight', '2500');
  room.setFloorLevel(100);
  setRoomCeilingShape(room, { shape: 'slope', dims: [300, 90] });
  const r = zoneCeilingFarEdge(zoneCeilingFieldOf(g.graph), g.graph, room, { isVertical: false, runLo: 100, runHi: 900, startCoord: 0, dir: +1 });
  assert.deepEqual(r, { chLo: 2800, chHi: 2800, alongRun: false });
});

test('【失敗系・null】区画なしの部屋・他の部屋・room null・field null・dir 不正・非有限の座標は null。円弧・ドームも null', () => {
  const q = { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 };
  const g = makeGrid([0, 3000, 6000], [0, 2000]);
  const slopeR = g.interior([[0, 0]]);
  slopeR.setCeilingZones(createZone(g.graph, slopeR, [g.cell(0, 0)], slope(2400, 600, 90)).zones);
  const plainR = g.interior([[1, 0]]); // 区画なし（flat・zoneId なし）
  const field = zoneCeilingFieldOf(g.graph);
  assert.ok(field);
  assert.ok(zoneCeilingFarEdge(field, g.graph, slopeR, q), '前提: 正常な問い合わせは値を返す');
  assert.equal(zoneCeilingFarEdge(field, g.graph, plainR, { ...q, runLo: 3500, runHi: 5500 }), null, '区画なしの部屋は null');
  assert.equal(zoneCeilingFarEdge(field, g.graph, plainR, q), null, '面の所有者でない部屋は null');
  assert.equal(zoneCeilingFarEdge(field, g.graph, null, q), null);
  assert.equal(zoneCeilingFarEdge(null, g.graph, slopeR, q), null);
  assert.equal(zoneCeilingFarEdge(field, g.graph, slopeR, { ...q, dir: 0 }), null);
  assert.equal(zoneCeilingFarEdge(field, g.graph, slopeR, { ...q, dir: 2 }), null);
  assert.equal(zoneCeilingFarEdge(field, g.graph, slopeR, { ...q, startCoord: NaN }), null);
  assert.equal(zoneCeilingFarEdge(field, g.graph, slopeR, { ...q, runLo: NaN }), null);
  // 円弧・ドーム（slope の部屋が別にあって field は null でない）
  for (const [shape, dims] of [['arc', [400, 90]], ['dome', [500]]]) {
    const h = makeGrid([0, 3000, 6000], [0, 2000]);
    const a = h.interior([[0, 0]]);
    a.setCeilingZones(createZone(h.graph, a, [h.cell(0, 0)], { heightMm: 2400, shape, dims }).zones);
    const b = h.interior([[1, 0]]);
    b.setCeilingZones(createZone(h.graph, b, [h.cell(1, 0)], slope(2400, 600, 90)).zones);
    const f = zoneCeilingFieldOf(h.graph);
    assert.ok(f, shape);
    assert.equal(zoneCeilingFarEdge(f, h.graph, a, q), null, shape);
  }
});

test('【歩く上限】奥へ続く同じ面の矩形が 64 を超える異常な格子は null（64 以内なら値）', () => {
  const g = makeGrid([0, 3000], [0, 2000]);
  const room = g.interior([[0, 0]]);
  const chain = n => {
    const s = {
      roomId: room.id, zoneId: 'z', shape: 'slope', dims: [600, 90], chMm: 2400, zMm: 2400,
      rects: Array.from({ length: n }, (_, i) => ({ x1: 0, x2: 3000, y1: i * 100, y2: (i + 1) * 100 })),
    };
    const inRect = (r, x, y) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;
    return { surfaces: [s], surfaceAt: (x, y) => (s.rects.some(r => inRect(r, x, y)) ? s : null) };
  };
  const q = { isVertical: false, runLo: 500, runHi: 2500, startCoord: 0, dir: +1 };
  assert.equal(zoneCeilingFarEdge(chain(65), g.graph, room, q), null);
  const r = zoneCeilingFarEdge(chain(40), g.graph, room, q);
  assert.equal(r.chLo, 3000, '40 矩形（y 0..4000）の奥 y=4000 で u=1');
});
