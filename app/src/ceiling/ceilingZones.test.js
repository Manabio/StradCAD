// ceilingZones.js（天井区画の書込みの組み立て）の単体テスト。実物の PlanGraph / Room で組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CeilingZone } from '@core';
import { assignZoneHeight, clearZoneCells, zoneStateOfCells, normalizeZones } from './ceilingZones.js';
import { makeGrid } from '../plan/planTestFixtures.js';

// 3セル（c0 c1 c2）が1部屋の階
function setup() {
  const g = makeGrid([0, 1000, 2000, 3000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0], [2, 0]]);
  const [c0, c1, c2] = [g.cell(0, 0), g.cell(1, 0), g.cell(2, 0)];
  return { g, graph: g.graph, room, c0, c1, c2 };
}
const zoneData = zones => zones.map(z => ({ cells: [...z.cells], heightMm: z.heightMm }));

test('assignZoneHeight: 区画の無い部屋へ新しい区画（uuid の id・flat・寸法なし）を足す。部屋の区画は書き換えない（純関数）', () => {
  const { graph, room, c0, c1 } = setup();
  const zones = assignZoneHeight(graph, room, new Set([c1, c0]), 2400);
  assert.equal(zones.length, 1);
  assert.deepEqual(zones[0].cells, [c0, c1].sort());
  assert.equal(zones[0].heightMm, 2400);
  assert.equal(zones[0].shape, 'flat');
  assert.deepEqual([...zones[0].dims], []);
  assert.match(zones[0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([...room.ceilingZones], [], '入力の部屋は変えない');
});

test('assignZoneHeight: 新区画は既存区画のセルを奪う（Z2）。奪われて空になった区画は消える', () => {
  const { graph, room, c0, c1, c2 } = setup();
  room.setCeilingZones(assignZoneHeight(graph, room, [c0, c1], 2400));
  room.setCeilingZones(assignZoneHeight(graph, room, [c1, c2], 2600));
  assert.deepEqual(zoneData(room.ceilingZones), [
    { cells: [c0], heightMm: 2400 },
    { cells: [c1, c2].sort(), heightMm: 2600 },
  ]);
  room.setCeilingZones(assignZoneHeight(graph, room, [c0], 3000));
  assert.deepEqual(zoneData(room.ceilingZones), [
    { cells: [c1, c2].sort(), heightMm: 2600 },
    { cells: [c0], heightMm: 3000 },
  ], '2400 の区画は全セルを奪われて消える');
});

test('assignZoneHeight: 同じ高さの flat 区画があればそこへセルを足す（新規作成しない）', () => {
  const { graph, room, c0, c1, c2 } = setup();
  room.setCeilingZones(assignZoneHeight(graph, room, [c0], 2400));
  const id = room.ceilingZones[0].id;
  room.setCeilingZones(assignZoneHeight(graph, room, [c1], 2600));
  room.setCeilingZones(assignZoneHeight(graph, room, [c2], 2400));
  assert.equal(room.ceilingZones.length, 2);
  const merged = room.ceilingZones.find(z => z.id === id);
  assert.deepEqual(merged.cells, [c0, c2].sort());
});

test('assignZoneHeight: 部屋の CH と同じ高さでも区画として残す', () => {
  const { graph, room, c0 } = setup();
  room.setOverride('ceilingHeight', '2400');
  room.setCeilingZones(assignZoneHeight(graph, room, [c0], 2400));
  assert.equal(room.ceilingZones.length, 1);
});

test('clearZoneCells: 区画のセルから差し引く（完全一致に限らない）。空になった区画は消える', () => {
  const { graph, room, c0, c1, c2 } = setup();
  room.setCeilingZones(assignZoneHeight(graph, room, [c0, c1], 2400));
  room.setCeilingZones(assignZoneHeight(graph, room, [c2], 2600));
  const cleared = clearZoneCells(graph, room, [c1, c2]);
  assert.deepEqual(zoneData(cleared), [{ cells: [c0], heightMm: 2400 }], '2400 は一部だけ解除、2600 は全部解除で消える');
  assert.deepEqual(zoneData(clearZoneCells(graph, room, [])), zoneData(room.ceilingZones), '空の選択は変えない');
});

test('【失敗系】解けないキーは書くときに捨てる（解除・指定の両方）。解けるセルが無い区画は消える', () => {
  const { graph, room, c0, c1, c2 } = setup();
  const GONE = 'gone:gone:gone:gone';
  room.setCeilingZones([
    new CeilingZone({ id: 'old', cells: [GONE, c0], heightMm: 2500 }),
    new CeilingZone({ id: 'dead', cells: [GONE], heightMm: 2700 }),
  ]);
  assert.deepEqual(normalizeZones(graph, room).map(z => [z.id, z.cells]), [['old', [c0]]]);
  const zones = assignZoneHeight(graph, room, [c2, GONE], 2900);
  assert.deepEqual(zones.map(z => [z.id === 'old' ? 'old' : 'new', z.cells]), [['old', [c0]], ['new', [c2]]]);
  assert.deepEqual(zoneData(assignZoneHeight(graph, room, [GONE], 2900)), [{ cells: [c0], heightMm: 2500 }], '解けるキーが無ければ何も足さない');
  assert.deepEqual(zoneData(clearZoneCells(graph, room, [GONE])), [{ cells: [c0], heightMm: 2500 }]);
  void c1;
});

test('【失敗系】部屋 null は [] を返し何もしない。高さが 0・負・NaN・非数なら足さない（正規化した現在の区画のまま）', () => {
  const { graph, room, c0, c1 } = setup();
  assert.deepEqual(assignZoneHeight(graph, null, [c0], 2400), []);
  assert.deepEqual(clearZoneCells(graph, null, [c0]), []);
  assert.deepEqual(zoneStateOfCells(graph, null, [c0]), { state: 'none', heightMm: null });
  room.setCeilingZones(assignZoneHeight(graph, room, [c0], 2400));
  for (const bad of [0, -100, NaN, Infinity, '2400', null, undefined]) {
    assert.deepEqual(zoneData(assignZoneHeight(graph, room, [c1], bad)), [{ cells: [c0], heightMm: 2400 }], String(bad));
  }
});

test('zoneStateOfCells: none（区画なし）／uniform（同じ高さ。heightMm）／mixed（区画あり・なしの混在、または違う高さ）', () => {
  const { graph, room, c0, c1, c2 } = setup();
  assert.deepEqual(zoneStateOfCells(graph, room, [c0, c1]), { state: 'none', heightMm: null });
  room.setCeilingZones(assignZoneHeight(graph, room, [c0], 2400));
  room.setCeilingZones(assignZoneHeight(graph, room, [c1], 2600));
  assert.deepEqual(zoneStateOfCells(graph, room, [c0]), { state: 'uniform', heightMm: 2400 });
  assert.deepEqual(zoneStateOfCells(graph, room, [c0, c1]), { state: 'mixed', heightMm: null }, '違う高さ');
  assert.deepEqual(zoneStateOfCells(graph, room, [c1, c2]), { state: 'mixed', heightMm: null }, '区画あり・なし');
  assert.deepEqual(zoneStateOfCells(graph, room, [c2]), { state: 'none', heightMm: null });
  assert.deepEqual(zoneStateOfCells(graph, room, []), { state: 'none', heightMm: null });
});
