// ceilingCutHeight.js（天伏の切断高の解決。階の 1 値＋低い天井の部屋の例外）の単体テスト。ceilingSurfaces.test.js と同じ fixture で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature } from '@core';
import { ceilingCutResolverOf } from './ceilingCutHeight.js';
import { makeGrid, assignZoneSpec } from '../plan/planTestFixtures.js';

const BASE = 1500;

test('例外なし: 全部屋の天井面の最低点が基本の切断高より上なら、cutZAt はどこでも基本の高さ・範囲は min=max=基本', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  g.interior([[0, 0]]).setOverride('ceilingHeight', '2600');
  g.interior([[1, 0]]).setOverride('ceilingHeight', '2200');
  const r = ceilingCutResolverOf(g.graph);
  assert.equal(r.baseCutMm, BASE);
  assert.deepEqual(r.exceptions, []);
  assert.equal(r.roomCutMm.size, 0);
  assert.deepEqual(r.range, { min: BASE, max: BASE });
  for (const [x, y] of [[1000, 1500], [3000, 1500], [9999, 9999]]) assert.equal(r.cutZAt(x, y), BASE);
});

test('例外: 天井面の最低点が基本の高さ以下の部屋だけ、切断高が最低点の直下（−0.5）へ下がる。cutZAt は点の属する部屋で替わる', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const normal = g.interior([[0, 0]]);
  const low = g.interior([[1, 0]]);
  normal.setOverride('ceilingHeight', '2400');
  low.setOverride('ceilingHeight', '1200');
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.exceptions, [{ roomId: low.id, minCeilingZ: 1200, cutMm: 1199.5 }]);
  assert.deepEqual([...r.roomCutMm], [[low.id, 1199.5]]);
  assert.deepEqual(r.range, { min: 1199.5, max: BASE });
  assert.equal(r.cutZAt(3000, 1500), 1199.5, '低い部屋の中');
  assert.equal(r.cutZAt(1000, 1500), BASE, '普通の部屋の中');
  assert.equal(r.cutZAt(9000, 1500), BASE, '索引外（部屋の外）は基本');
});

test('境界: 最低点がちょうど基本の高さなら例外なし（数値の切断高でも描ける）、1 mm 下なら例外', () => {
  const mk = ch => {
    const g = makeGrid([0, 2000], [0, 3000]);
    g.interior([[0, 0]]).setOverride('ceilingHeight', String(ch));
    return ceilingCutResolverOf(g.graph).exceptions;
  };
  assert.deepEqual(mk(BASE), []);
  assert.deepEqual(mk(BASE + 1), []);
  assert.deepEqual(mk(BASE - 1).map(e => e.cutMm), [BASE - 1.5]);
});

test('基本の切断高は opts.baseCutMm で替えられる（階の値を使わない呼び出し）。基本を上げると天井 2400 の部屋も例外になる', () => {
  const g = makeGrid([0, 2000], [0, 3000]);
  const room = g.interior([[0, 0]]);
  room.setOverride('ceilingHeight', '2400');
  const r = ceilingCutResolverOf(g.graph, { baseCutMm: 3000 });
  assert.equal(r.baseCutMm, 3000);
  assert.deepEqual(r.exceptions, [{ roomId: room.id, minCeilingZ: 2400, cutMm: 2399.5 }]);
  assert.equal(r.cutZAt(1000, 1500), 2399.5);
  assert.equal(r.cutZAt(5000, 1500), 3000);
});

test('傾斜・ドーム: 面の最低点（基準高）で判定する。平均や最高点は使わない（低い側 1000・ライズ 2000 → 最低点 1000 で例外）', () => {
  const g = makeGrid([0, 4000, 8000], [0, 4000]);
  const slope = g.interior([[0, 0]]);
  slope.setCeilingZones(assignZoneSpec(g.graph, slope, [g.cell(0, 0)], { heightMm: 1000, shape: 'slope', dims: [2000, 0] }));
  const dome = g.interior([[1, 0]]);
  dome.setCeilingZones(assignZoneSpec(g.graph, dome, [g.cell(1, 0)], { heightMm: 2000, shape: 'dome', dims: [500] }));
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.exceptions, [{ roomId: slope.id, minCeilingZ: 1000, cutMm: 999.5 }], '傾斜だけ例外（ドームの最低点 2000 は基本より上）');
  assert.equal(r.cutZAt(2000, 2000), 999.5);
  assert.equal(r.cutZAt(6000, 2000), BASE);
});

test('天井区画: 部屋の一部の区画だけ低くても、その部屋の全セルが同じ切断高（部屋ごとに 1 値）', () => {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  room.setOverride('ceilingHeight', '2400');
  room.setCeilingZones(assignZoneSpec(g.graph, room, [g.cell(1, 0)], { heightMm: 1100, shape: 'flat', dims: [] }));
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.exceptions, [{ roomId: room.id, minCeilingZ: 1100, cutMm: 1099.5 }]);
  assert.equal(r.cutZAt(1000, 1500), 1099.5, '区画に入らない側のセルも同じ部屋なので同じ切断高');
  assert.equal(r.cutZAt(3000, 1500), 1099.5);
});

test('床段差: 面の高さは床段差込みの絶対 z。床 −400・CH 1800 の部屋は 1400 で例外、床 +200・CH 1200 は 1400 で例外（同じ）、床 +400・CH 1200 は 1600 で例外なし', () => {
  const mk = (floor, ch) => {
    const g = makeGrid([0, 2000], [0, 3000]);
    const room = g.interior([[0, 0]]);
    room.setFloorLevel(floor);
    room.setOverride('ceilingHeight', String(ch));
    return ceilingCutResolverOf(g.graph).exceptions.map(e => e.minCeilingZ);
  };
  assert.deepEqual(mk(-400, 1800), [1400]);
  assert.deepEqual(mk(200, 1200), [1400]);
  assert.deepEqual(mk(400, 1200), []);
});

test('階段吹抜け（STAIR_VOID）の平らな面と、天井を持たない部屋（吹抜け）は例外にならない（基本の高さ）', () => {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  g.interior([[0, 0]]).setOverride('ceilingHeight', '2400');
  const sv = g.feature([[1, 0]], RoomFeature.STAIR_VOID);
  sv.setOverride('ceilingHeight', '900');
  g.feature([[2, 0]], RoomFeature.VOID);
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.exceptions, []);
  assert.equal(r.cutZAt(3000, 1500), BASE, '階段吹抜け');
  assert.equal(r.cutZAt(5000, 1500), BASE, '吹抜け');
});

test('【失敗系】graph が null・天井面を持つ部屋が無い・非有限の座標は基本の高さ。例外なし', () => {
  const none = ceilingCutResolverOf(null);
  assert.equal(none.baseCutMm, BASE);
  assert.deepEqual(none.exceptions, []);
  assert.equal(none.cutZAt(0, 0), BASE);
  const g = makeGrid([0, 2000], [0, 3000]);
  g.feature([[0, 0]], RoomFeature.VOID);
  const r = ceilingCutResolverOf(g.graph);
  assert.deepEqual(r.exceptions, []);
  const low = makeGrid([0, 2000], [0, 3000]);
  low.interior([[0, 0]]).setOverride('ceilingHeight', '1000');
  const lr = ceilingCutResolverOf(low.graph);
  assert.equal(lr.cutZAt(NaN, 1500), BASE);
  assert.equal(lr.cutZAt(undefined, undefined), BASE);
  assert.equal(ceilingCutResolverOf(low.graph, { baseCutMm: NaN }).baseCutMm, BASE, '非有限の baseCutMm は階の値');
});
