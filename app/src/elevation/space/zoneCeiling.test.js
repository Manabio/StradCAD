// zoneCeiling.js（展開図が天伏の平面区画の高さに追従するための点問い合わせ）の単体テスト。
// 区画の作り方は ceiling/ceilingHeightField.test.js と同じ fixture。期待値はリテラル。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, StairType } from '@core';
import { zoneCeilingFieldOf, zoneCeilingChAt, zoneCeilingEdgesAlong } from './zoneCeiling.js';
import { createZone } from '../../ceiling/ceilingZones.js';
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

test('【失敗系】傾斜・円弧の区画は null（後のステップ。部屋の CH に落とす）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(0, 0)], { heightMm: 2400, shape: 'slope', dims: [600, 0] }).zones);
  room.setCeilingZones(createZone(g.graph, room, [g.cell(1, 0)], { heightMm: 2400, shape: 'arc', dims: [400, 0] }).zones);
  const f = zoneCeilingFieldOf(g.graph);
  assert.equal(f, null, '使える面が0なら field ごと null');
  assert.equal(zoneCeilingChAt(f, room, 1000, 1500), null);
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
