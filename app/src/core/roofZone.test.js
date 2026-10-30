// 屋根区画（RoofZone）の値クラス・復元のテスト。ceilingZone.test.js と同じ方針。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoofSpec, ROOF_SPEC_KEYS } from './roofSpec.js';
import { RoofZone, ROOF_ZONE_KEYS, restoreRoofZones } from './roofZone.js';
import { NON_DEFAULT_ROOF_SPEC } from '../finish/roofTestFixtures.js';

const zoneData = (id, cells, spec = new RoofSpec().toData()) => ({ id, cells, spec });

test('toData のキー集合は ROOF_ZONE_KEYS と一致し、cells は昇順・重複なし、spec は RoofSpec.toData', () => {
  const z = new RoofZone({ id: 'z1', cells: ['b', 'a', 'b', '', 3], spec: RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC) });
  const d = z.toData();
  assert.deepEqual(Object.keys(d).sort(), [...ROOF_ZONE_KEYS].sort());
  assert.deepEqual(d.cells, ['a', 'b']);
  assert.deepEqual(Object.keys(d.spec).sort(), [...ROOF_SPEC_KEYS].sort());
  assert.deepEqual(d.spec, NON_DEFAULT_ROOF_SPEC);
});

test('殻は凍結されるが spec は可変（setField で編集できる）', () => {
  const z = new RoofZone({ id: 'z1', cells: ['a'] });
  assert.ok(Object.isFrozen(z));
  assert.ok(Object.isFrozen(z.cells));
  z.spec.setField('slope', 4);
  assert.equal(z.spec.slope, 4);
  assert.throws(() => { 'use strict'; z.id = 'x'; }, TypeError);
});

test('toData → fromData の往復で id・cells・非既定の spec が保たれる', () => {
  const z = new RoofZone({ id: 'z1', cells: ['a', 'b'], spec: RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC) });
  const r = RoofZone.fromData(z.toData());
  assert.deepEqual(r.toData(), z.toData());
  assert.ok(r.spec instanceof RoofSpec);
});

test('【失敗系】fromData: id が非文字列・空・入力が null/非オブジェクトなら null。spec 欠落は既定の RoofSpec、cells が配列でなければ空', () => {
  assert.equal(RoofZone.fromData(null), null);
  assert.equal(RoofZone.fromData({ id: 1, cells: ['a'] }), null);
  assert.equal(RoofZone.fromData({ id: '', cells: ['a'] }), null);
  const z = RoofZone.fromData({ id: 'z', cells: 'abc' });
  assert.deepEqual(z.cells, []);
  assert.deepEqual(z.spec.toData(), new RoofSpec().toData());
});

test('【失敗系】fromData: 壊れた spec は RoofSpec.fromData で正規化される', () => {
  const z = RoofZone.fromData(zoneData('z', ['a'], { ...NON_DEFAULT_ROOF_SPEC, slope: -1, shape: 'dome' }));
  assert.equal(z.spec.slope, 3);
  assert.equal(z.spec.shape, null);
});

test('restoreRoofZones: 正常な配列は順序そのまま・凍結配列で返る', () => {
  const out = restoreRoofZones([zoneData('z1', ['a']), zoneData('z2', ['b'])]);
  assert.deepEqual(out.map(z => z.id), ['z1', 'z2']);
  assert.ok(Object.isFrozen(out));
});

test('【失敗系】restoreRoofZones: null・非配列・欠落は空の凍結配列', () => {
  for (const v of [null, undefined, {}, 'x', 3]) {
    const out = restoreRoofZones(v);
    assert.deepEqual(out, []);
    assert.ok(Object.isFrozen(out));
  }
});

test('【失敗系】restoreRoofZones: 不正な id・空 cells（正規化後に空も）の区画を捨てる', () => {
  const out = restoreRoofZones([
    zoneData(null, ['a']), zoneData('', ['a']), null, zoneData('e1', []), zoneData('e2', ['', 7]), zoneData('ok', ['a']),
  ]);
  assert.deepEqual(out.map(z => z.id), ['ok']);
});

test('【失敗系】restoreRoofZones: 同じ id は先勝ち（後のものを捨てる）', () => {
  const out = restoreRoofZones([zoneData('z', ['a']), zoneData('z', ['b'])]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].cells, ['a']);
});

test('【失敗系】restoreRoofZones: 他の区画と重なるセルは先勝ちで後の区画から除き、空になった区画は捨てる', () => {
  const out = restoreRoofZones([
    zoneData('z1', ['a', 'b']), zoneData('z2', ['b', 'c']), zoneData('z3', ['a', 'b']),
  ]);
  assert.deepEqual(out.map(z => [z.id, [...z.cells]]), [['z1', ['a', 'b']], ['z2', ['c']]]);
});

test('restoreRoofZones: spec 欠落の区画は既定の RoofSpec で復元される', () => {
  const out = restoreRoofZones([{ id: 'z', cells: ['a'] }]);
  assert.deepEqual(out[0].spec.toData(), new RoofSpec().toData());
});

test('【失敗系】new RoofZone: spec が null・plain object でも必ず RoofSpec になり、toData が例外にならない（QA 指摘: null のままだと保存で落ちる）', () => {
  const nul = new RoofZone({ id: 'z', cells: ['a'], spec: null });
  assert.ok(nul.spec instanceof RoofSpec);
  assert.deepEqual(nul.toData().spec, new RoofSpec().toData());
  const plain = new RoofZone({ id: 'z', cells: ['a'], spec: { slope: 7 } });
  assert.ok(plain.spec instanceof RoofSpec);
  assert.equal(plain.toData().spec.slope, 7);
});
