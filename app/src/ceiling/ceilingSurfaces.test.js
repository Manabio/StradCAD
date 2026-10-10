// ceilingSurfaces.js（天井面の算出）の単体テスト。実物の PlanGraph / Room で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, RoomKind, CeilingZone } from '@core';
import { roomHasCeiling, ceilingSurfacesOf } from './ceilingSurfaces.js';
import { makeGrid, rect } from '../plan/planTestFixtures.js';

test('roomHasCeiling: 屋内で feature なしだけが天井を持つ。屋外・吹抜け・階段・階段吹抜け・屋根・昇降路・未定義・null は持たない', () => {
  const g = makeGrid([0, 1000, 2000, 3000, 4000], [0, 1000]);
  const plain = g.interior([[0, 0]]);
  assert.equal(roomHasCeiling(plain), true);
  for (const f of [RoomFeature.VOID, RoomFeature.STAIR, RoomFeature.STAIR_VOID, RoomFeature.UNDEFINED, RoomFeature.ELEVATOR_EQUIPMENT]) {
    const room = g.feature([[1, 0]], f);
    assert.equal(roomHasCeiling(room), false, f);
  }
  assert.equal(roomHasCeiling(g.roof([[2, 0]])), false, '屋根');
  const outdoor = g.interior([[3, 0]]);
  outdoor.setKind(RoomKind.EXTERIOR);
  assert.equal(roomHasCeiling(outdoor), false, '屋外');
  assert.equal(roomHasCeiling(null), false);
  assert.equal(roomHasCeiling(undefined), false);
});

test('2部屋: 部屋ごとにセル矩形の和と天井高（FL からの mm）を返す。順序は graph.rooms の順、矩形は (y1,x1) 順', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const a = g.interior([[0, 0]]);
  const b = g.interior([[1, 0]]);
  a.setOverride('ceilingHeight', '2600');
  b.setOverride('ceilingHeight', '2200');
  assert.deepEqual(ceilingSurfacesOf(g.graph), [
    { roomId: a.id, zoneId: null, rects: [rect(0, 0, 2000, 3000)], zMm: 2600, shape: 'flat', dims: [], chMm: 2600 },
    { roomId: b.id, zoneId: null, rects: [rect(2000, 0, 4000, 3000)], zMm: 2200, shape: 'flat', dims: [], chMm: 2200 },
  ]);
});

test('複数セルの部屋は矩形を (y1,x1) 順に並べる', () => {
  const g = makeGrid([0, 2000, 4000], [0, 1500, 3000]);
  const room = g.interior([[1, 1], [0, 1], [1, 0], [0, 0]]);
  const [surface] = ceilingSurfacesOf(g.graph);
  assert.equal(surface.roomId, room.id);
  assert.deepEqual(surface.rects, [rect(0, 0, 2000, 1500), rect(2000, 0, 4000, 1500), rect(0, 1500, 2000, 3000), rect(2000, 1500, 4000, 3000)]);
});

test('部分指定: 子が持つセルは子の天井になり、親の矩形からは外れる（親のセルが子に上書きされる）。子の CH は子の欄が優先', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]]);
  parent.setOverride('ceilingHeight', '2400');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setOverride('ceilingHeight', '2100');
  assert.deepEqual(ceilingSurfacesOf(g.graph), [
    { roomId: parent.id, zoneId: null, rects: [rect(0, 0, 2000, 3000)], zMm: 2400, shape: 'flat', dims: [], chMm: 2400 },
    { roomId: child.id, zoneId: null, rects: [rect(2000, 0, 4000, 3000)], zMm: 2100, shape: 'flat', dims: [], chMm: 2100 },
  ]);
});

test('床段差: 部分指定の子（FL+400・自分の CH 欄なし）の天井面は親と同じ FL+2400。FL−150・CH 2400 の部屋は FL+2250', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const parent = g.interior([[0, 0], [1, 0]]);
  parent.setOverride('ceilingHeight', '2400');
  const child = g.graph.addRoom(new Set([g.cell(1, 0)]), '小上がり', undefined, new Set([parent.id]));
  child.setFloorLevel(400);
  const low = g.interior([[2, 0]]);
  low.setFloorLevel(-150);
  low.setOverride('ceilingHeight', '2400');
  const z = id => ceilingSurfacesOf(g.graph).find(s => s.roomId === id).zMm;
  assert.equal(z(parent.id), 2400);
  assert.equal(z(child.id), 2400, '子の CH は 2000 に補正され、床段差 400 を足して親と同じ天井面');
  assert.equal(z(low.id), 2250);
});

test('CH 未指定（fallback）は graph.defaultCeilingHeight の mm。数値化できない欄（レンジ表記）も既定の mm', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.graph.setDefaultCeilingHeight(2500);
  const a = g.interior([[0, 0]]);
  const b = g.interior([[1, 0]]);
  b.setOverride('ceilingHeight', '2300〜3500');
  assert.deepEqual(ceilingSurfacesOf(g.graph).map(s => [s.roomId, s.zMm]), [[a.id, 2500], [b.id, 2500]]);
});

test('天井を持たない部屋（吹抜け・階段・屋根・屋外・未定義）は出さない。部屋が無い階・graph なしは空', () => {
  const g = makeGrid([0, 1000, 2000, 3000, 4000, 5000], [0, 1000]);
  const keep = g.interior([[0, 0]]);
  g.feature([[1, 0]], RoomFeature.VOID);
  g.feature([[2, 0]], RoomFeature.STAIR);
  g.roof([[3, 0]]);
  g.feature([[4, 0]], RoomFeature.UNDEFINED);
  assert.deepEqual(ceilingSurfacesOf(g.graph).map(s => s.roomId), [keep.id]);
  assert.deepEqual(ceilingSurfacesOf(makeGrid([0, 1000], [0, 1000]).graph), []);
  assert.deepEqual(ceilingSurfacesOf(null), []);
});

test('天井区画（S5）: 区画のある部屋は「残り（zoneId null・部屋の CH）→ 区画の配列順」の面に分かれる。zMm は床段差を含む。高さ null の区画は部屋の CH', () => {
  const g = makeGrid([0, 1000, 2000, 3000, 4000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0], [2, 0], [3, 0]]);
  room.setFloorLevel(100);
  room.setOverride('ceilingHeight', '2400');
  room.setCeilingZones([
    new CeilingZone({ id: 'zA', cells: [g.cell(3, 0)], heightMm: 2800 }),
    new CeilingZone({ id: 'zB', cells: [g.cell(1, 0)], heightMm: null, shape: 'slope', dims: [500, 90] }),
  ]);
  assert.deepEqual(ceilingSurfacesOf(g.graph), [
    { roomId: room.id, zoneId: null, rects: [rect(0, 0, 1000, 1000), rect(2000, 0, 3000, 1000)], zMm: 100 + 2400, shape: 'flat', dims: [], chMm: 2400 },
    { roomId: room.id, zoneId: 'zA', rects: [rect(3000, 0, 4000, 1000)], zMm: 100 + 2800, shape: 'flat', dims: [], chMm: 2800 },
    { roomId: room.id, zoneId: 'zB', rects: [rect(1000, 0, 2000, 1000)], zMm: 100 + 2400, shape: 'slope', dims: [500, 90], chMm: 2400 },
  ]);
});

test('天井区画: 同じセルが複数の区画にあれば先勝ち。空になった面（全セルが先の区画に取られた・解けない）と空の残りは出さない', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0]]);
  const [c0, c1] = [g.cell(0, 0), g.cell(1, 0)];
  room.setCeilingZones([
    new CeilingZone({ id: 'first', cells: [c0, c1], heightMm: 2500 }),
    new CeilingZone({ id: 'second', cells: [c1], heightMm: 2900 }),
    new CeilingZone({ id: 'ghost', cells: ['gone:gone:gone:gone'], heightMm: 3000 }),
  ]);
  assert.deepEqual(ceilingSurfacesOf(g.graph).map(s => [s.zoneId, s.zMm]), [['first', 2500]], '残りも second も ghost も出ない');
});

test('天井区画: 天井を持たない部屋（吹抜け・屋外など）の区画は無視する。区画の無い部屋の出力は zoneId null のまま', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const keep = g.interior([[0, 0]]);
  const hole = g.feature([[1, 0]], RoomFeature.VOID);
  hole.setCeilingZones([new CeilingZone({ id: 'z', cells: [g.cell(1, 0)], heightMm: 2500 })]);
  assert.deepEqual(ceilingSurfacesOf(g.graph).map(s => [s.roomId, s.zoneId]), [[keep.id, null]]);
});

test('【失敗系】セルが解決できない部屋（CL 削除で消失したキー）は出さない。例外にしない', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const ghost = g.graph.addRoom(new Set(['nope:nope:nope:nope']), '消失');
  const ok = g.interior([[0, 0]]);
  assert.doesNotThrow(() => ceilingSurfacesOf(g.graph));
  const ids = ceilingSurfacesOf(g.graph).map(s => s.roomId);
  assert.ok(ids.includes(ok.id) && !ids.includes(ghost.id));
});
