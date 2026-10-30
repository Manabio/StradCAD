// 屋根区画の純関数（作成・削除・実効セル・主屋根の残りセル）と createRoofZoneSpec のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, CenterLineType, Discipline, RoofSpec, RoofZone, RoofShape,
  DEFAULT_SOFFIT_MATERIAL, DEFAULT_SOFFIT_BACKING, SoffitOrientation,
} from '@core';
import { createRoofZone, removeRoofZone, roofZoneEffectiveCells, mainRoofRestCellKeys, roofZoneGroupInputs } from './roofZones.js';
import { createRoofZoneSpec } from './roofDefaults.js';
import { NON_DEFAULT_ROOF_SPEC } from '../roofTestFixtures.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

/** 屋内の部屋が左2セル（A・B）、右の1セル（C）は部屋の外（フットプリント外）の格子。 */
function layout() {
  const graph = new PlanGraph(new Plane('p1', 0, '2階', 2, 1));
  const x = [0, 1000, 2000, 3000].map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `x${i}`));
  const y = [0, 1000].map((v, i) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `y${i}`));
  const key = i => `${x[i].id}:${y[0].id}:${x[i + 1].id}:${y[1].id}`;
  const [a, b, c] = [key(0), key(1), key(2)];
  graph.addRoom(new Set([a, b]), '居間');
  return { graph, a, b, c };
}

const ids = () => { let n = 0; return () => `id${++n}`; };

test('createRoofZone: 区画を追加し、cells は昇順・重複除去。zoneId を返す', () => {
  const { zones, zoneId } = createRoofZone([], ['b', 'a', 'b'], new RoofSpec(), ids());
  assert.equal(zoneId, 'id1');
  assert.equal(zones.length, 1);
  assert.deepEqual(zones[0].cells, ['a', 'b']);
});

test('createRoofZone: 後から作った区画が既存区画のセルを奪い、空になった区画は消える', () => {
  const f = ids();
  const r1 = createRoofZone([], ['a', 'b'], new RoofSpec(), f);
  const r2 = createRoofZone(r1.zones, ['b', 'c'], new RoofSpec(), f);
  assert.deepEqual(r2.zones.map(z => [z.id, [...z.cells]]), [['id1', ['a']], ['id2', ['b', 'c']]]);
  const r3 = createRoofZone(r2.zones, ['a', 'b', 'c'], new RoofSpec(), f);
  assert.deepEqual(r3.zones.map(z => [z.id, [...z.cells]]), [['id3', ['a', 'b', 'c']]], '全部奪われた区画は消える');
});

test('【失敗系】createRoofZone: 空入力（空配列・空文字だけ）は変更なし（同一配列・zoneId null）', () => {
  const base = createRoofZone([], ['a'], new RoofSpec(), ids()).zones;
  for (const cells of [[], [''], [null, 3]]) {
    const r = createRoofZone(base, cells, new RoofSpec(), ids());
    assert.equal(r.zones, base);
    assert.equal(r.zoneId, null);
  }
});

test('createRoofZone: idFactory 省略時は一意な id を生成する', () => {
  const r1 = createRoofZone([], ['a'], new RoofSpec());
  const r2 = createRoofZone(r1.zones, ['b'], new RoofSpec());
  assert.equal(typeof r1.zoneId, 'string');
  assert.notEqual(r1.zoneId, '');
  assert.notEqual(r1.zoneId, r2.zoneId);
});

test('【失敗系】createRoofZone: idFactory が既存の id を返したら throw し、入力の区画は変わらない（保存後に先勝ちで黙って消えるのを防ぐ）', () => {
  const { a, b } = layout();
  const { zones } = createRoofZone([], [a], new RoofSpec(), () => 'dup');
  assert.throws(() => createRoofZone(zones, [b], new RoofSpec(), () => 'dup'), /区画 id が重複/);
  assert.deepEqual(zones.map(z => [z.id, [...z.cells]]), [['dup', [a]]]);
});

test('createRoofZone: 入力の区画配列・区画は書き換えない', () => {
  const f = ids();
  const base = createRoofZone([], ['a', 'b'], new RoofSpec(), f).zones;
  createRoofZone(base, ['b'], new RoofSpec(), f);
  assert.deepEqual(base[0].cells, ['a', 'b']);
});

test('removeRoofZone: 該当 id を除く。【失敗系】未知の id は同一配列を返す', () => {
  const f = ids();
  const { zones } = createRoofZone(createRoofZone([], ['a'], new RoofSpec(), f).zones, ['b'], new RoofSpec(), f);
  assert.deepEqual(removeRoofZone(zones, 'id1').map(z => z.id), ['id2']);
  assert.equal(removeRoofZone(zones, 'nope'), zones);
  assert.deepEqual(removeRoofZone(zones, 'id2').map(z => z.id), ['id1']);
});

test('roofZoneEffectiveCells: フットプリント外のセルを除く。【失敗系】解決できないキーは無視', () => {
  const { graph, a, b, c } = layout();
  const zone = new RoofZone({ id: 'z', cells: [a, c, 'no-such:cell:key:x'] });
  assert.deepEqual([...roofZoneEffectiveCells(zone, graph)], [a]);
  assert.ok(![...roofZoneEffectiveCells(zone, graph)].includes(c));
  assert.ok(b);
});

test('mainRoofRestCellKeys: 区画なしならフットプリント全体。区画の実効セルを除いた残りを返す', () => {
  const { graph, a, b, c } = layout();
  assert.deepEqual([...mainRoofRestCellKeys(graph)].sort(), [a, b].sort());
  graph.setRoofZones([new RoofZone({ id: 'z', cells: [a, c] })]);
  assert.deepEqual([...mainRoofRestCellKeys(graph)], [b]);
  graph.setRoofZones([new RoofZone({ id: 'z', cells: [a, b] })]);
  assert.deepEqual([...mainRoofRestCellKeys(graph)], [], '全部が区画に入れば主屋根の残りは無い');
});

test('createRoofZoneSpec: 主屋根の値を写し、形状・高い側・棟木の向きだけ null（自動）、軒裏は既定で埋め、備考は写す', () => {
  const main = RoofSpec.fromData({
    ...NON_DEFAULT_ROOF_SPEC, shape: RoofShape.GABLE, highSide: 'top', ridgeDirection: 'vertical',
    soffitMaterial: '', soffitBacking: '', soffitOrientation: null, soffitNote: '', note: '主屋根メモ',
  });
  const spec = createRoofZoneSpec(main);
  assert.ok(spec instanceof RoofSpec);
  assert.notEqual(spec, main);
  assert.equal(spec.shape, null);
  assert.equal(spec.highSide, null);
  assert.equal(spec.ridgeDirection, null);
  assert.equal(spec.slope, main.slope);
  assert.equal(spec.eaveOverhangMm, main.eaveOverhangMm);
  assert.equal(spec.sheathingMaterial, main.sheathingMaterial);
  assert.equal(spec.note, '主屋根メモ');
  assert.equal(spec.soffitMaterial, DEFAULT_SOFFIT_MATERIAL);
  assert.equal(spec.soffitBacking, DEFAULT_SOFFIT_BACKING);
  assert.equal(spec.soffitOrientation, SoffitOrientation.SLOPED);
  assert.equal(main.soffitMaterial, '', '主屋根は書き換えない');
});

test('【失敗系】createRoofZoneSpec: 主屋根が null/undefined でも既定の RoofSpec 相当（軒裏は既定で埋まる）', () => {
  for (const v of [null, undefined]) {
    const spec = createRoofZoneSpec(v);
    assert.equal(spec.slope, new RoofSpec().slope);
    assert.equal(spec.shape, null);
    assert.equal(spec.soffitMaterial, DEFAULT_SOFFIT_MATERIAL);
  }
});

test('roofZoneGroupInputs: 建物範囲内のセルを持つ区画は empty:false・範囲外だけの区画は empty:true。並び順は維持。【失敗系】0件なら []', () => {
  const { graph, a, c } = layout();
  assert.deepEqual(roofZoneGroupInputs(graph), []);
  const f = ids();
  let zones = createRoofZone([], [c], new RoofSpec(), f).zones;   // 範囲外だけ
  zones = createRoofZone(zones, [a], new RoofSpec(), f).zones;    // 範囲内
  graph.setRoofZones(zones);
  assert.deepEqual(roofZoneGroupInputs(graph), [{ id: 'id1', empty: true }, { id: 'id2', empty: false }]);
});

test('createRoofZoneSpec: 軒裏が埋まっている主屋根の値は上書きしない', () => {
  const main = new RoofSpec({ soffitMaterial: 'X', soffitBacking: 'Y', soffitOrientation: SoffitOrientation.LEVEL, soffitNote: 'N' });
  const spec = createRoofZoneSpec(main);
  assert.deepEqual([spec.soffitMaterial, spec.soffitBacking, spec.soffitOrientation, spec.soffitNote], ['X', 'Y', SoffitOrientation.LEVEL, 'N']);
});
