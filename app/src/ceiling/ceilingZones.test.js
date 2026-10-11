// ceilingZones.js（天井区画の書込みの組み立て）の単体テスト。実物の PlanGraph / Room で組む。
// 旧 assignZoneShape（同じ spec へ統合）・clearZoneCells・zoneStateOfCells は S12c で削除した（区画は createZone／updateZoneSpec／removeZone）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CeilingZone, CenterLineType, Discipline } from '@core';
import { normalizeZones, createZone, updateZoneSpec, removeZone } from './ceilingZones.js';
import { ceilingGroupsOf, roomGroupId, zoneGroupId } from './ceilingGroups.js';
import { buildCeilingCellOwners } from './ceilingOwners.js';
import { worldToCell, CEILING_CELL_GRID } from '../finish/gridCells.js';
import { makeGrid, assignZoneHeight } from '../plan/planTestFixtures.js';

// 3セル（c0 c1 c2）が1部屋の階
function setup() {
  const g = makeGrid([0, 1000, 2000, 3000], [0, 1000]);
  const room = g.interior([[0, 0], [1, 0], [2, 0]]);
  const [c0, c1, c2] = [g.cell(0, 0), g.cell(1, 0), g.cell(2, 0)];
  return { g, graph: g.graph, room, c0, c1, c2 };
}
const zoneData = zones => zones.map(z => ({ cells: [...z.cells], heightMm: z.heightMm }));

test('assignZoneHeight（フィクスチャ＝createZone の平面版）: 区画の無い部屋へ新しい区画（uuid の id・flat・寸法なし）を足す。部屋の区画は書き換えない（純関数）', () => {
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

test('assignZoneHeight: 同じ高さの区画があっても統合せず別の区画になる。部屋の CH と同じ高さでも区画として残す', () => {
  const { graph, room, c0, c1, c2 } = setup();
  room.setOverride('ceilingHeight', '2400');
  room.setCeilingZones(assignZoneHeight(graph, room, [c0], 2400));
  const id = room.ceilingZones[0].id;
  room.setCeilingZones(assignZoneHeight(graph, room, [c1], 2600));
  room.setCeilingZones(assignZoneHeight(graph, room, [c2], 2400));
  assert.equal(room.ceilingZones.length, 3, '同じ高さ 2400 の区画も別');
  assert.deepEqual(room.ceilingZones.find(z => z.id === id).cells, [c0]);
});

test('【失敗系】解けないキーは書くときに捨てる。解けるセルが無い区画は消える', () => {
  const { graph, room, c0, c2 } = setup();
  const GONE = 'gone:gone:gone:gone';
  room.setCeilingZones([
    new CeilingZone({ id: 'old', cells: [GONE, c0], heightMm: 2500 }),
    new CeilingZone({ id: 'dead', cells: [GONE], heightMm: 2700 }),
  ]);
  assert.deepEqual(normalizeZones(graph, room).map(z => [z.id, z.cells]), [['old', [c0]]]);
  const zones = assignZoneHeight(graph, room, [c2, GONE], 2900);
  assert.deepEqual(zones.map(z => [z.id === 'old' ? 'old' : 'new', z.cells]), [['old', [c0]], ['new', [c2]]]);
  assert.deepEqual(zoneData(assignZoneHeight(graph, room, [GONE], 2900)), [{ cells: [c0], heightMm: 2500 }], '解けるキーが無ければ何も足さない');
});

test('【失敗系】部屋 null は [] を返し何もしない。高さが 0・負・NaN・非数なら足さない（正規化した現在の区画のまま）', () => {
  const { graph, room, c0, c1 } = setup();
  assert.deepEqual(assignZoneHeight(graph, null, [c0], 2400), []);
  room.setCeilingZones(assignZoneHeight(graph, room, [c0], 2400));
  for (const bad of [0, -100, NaN, Infinity, '2400', null, undefined]) {
    assert.deepEqual(zoneData(assignZoneHeight(graph, room, [c1], bad)), [{ cells: [c0], heightMm: 2400 }], String(bad));
  }
});

// ---- 区画単位の書込み（S12b）: createZone / updateZoneSpec / removeZone ----
const FLAT = h => ({ heightMm: h, shape: 'flat', dims: [] });

test('createZone: 新しい区画（uuid）を末尾に足し zoneId を返す。部屋は書き換えない（純関数）', () => {
  const { graph, room, c0, c1 } = setup();
  const r = createZone(graph, room, new Set([c1, c0]), FLAT(2400));
  assert.equal(r.zones.length, 1);
  assert.equal(r.zones[0].id, r.zoneId);
  assert.match(r.zoneId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(r.zones[0].cells, [c0, c1].sort());
  assert.deepEqual([...room.ceilingZones], [], '入力の部屋は変えない');
});

test('createZone: 同じ spec の区画があっても統合せず、新しい id の区画になる', () => {
  const { graph, room, c0, c1 } = setup();
  room.setCeilingZones(createZone(graph, room, [c0], FLAT(2400)).zones);
  const firstId = room.ceilingZones[0].id;
  const r = createZone(graph, room, [c1], FLAT(2400));
  assert.equal(r.zones.length, 2, '同じ高さ・形状でも別の区画');
  assert.equal(r.zones[0].id, firstId);
  assert.notEqual(r.zoneId, firstId);
  assert.deepEqual(r.zones[0].cells, [c0], '既存の区画のセルは増えない');
});

test('createZone: 他の区画からセルを奪う（Z2）。奪われて空になった区画は消える', () => {
  const { graph, room, c0, c1, c2 } = setup();
  room.setCeilingZones(createZone(graph, room, [c0, c1], FLAT(2400)).zones);
  room.setCeilingZones(createZone(graph, room, [c1, c2], FLAT(2600)).zones);
  assert.deepEqual(zoneData(room.ceilingZones), [{ cells: [c0], heightMm: 2400 }, { cells: [c1, c2].sort(), heightMm: 2600 }]);
  const r = createZone(graph, room, [c0], FLAT(3000));
  assert.deepEqual(zoneData(r.zones), [{ cells: [c1, c2].sort(), heightMm: 2600 }, { cells: [c0], heightMm: 3000 }]);
});

test('createZone: 形状つき（傾斜・基準高 null）も作れる。平面で基準高 null は区画にならない', () => {
  const { graph, room, c0, c1 } = setup();
  const r = createZone(graph, room, [c0], { heightMm: null, shape: 'slope', dims: [800, 0] });
  assert.equal(r.zones[0].shape, 'slope');
  assert.equal(r.zones[0].heightMm, null);
  const flatNull = createZone(graph, room, [c1], { heightMm: null, shape: 'flat', dims: [] });
  assert.deepEqual([flatNull.zones.length, flatNull.zoneId], [0, null]);
});

test('createZone: 形状に合わない寸法は平面に落とす（区画は作る）', () => {
  const { graph, room, c0 } = setup();
  const r = createZone(graph, room, [c0], { heightMm: 2600, shape: 'slope', dims: [0, 45] });
  assert.equal(r.zones[0].shape, 'flat');
  assert.deepEqual([...r.zones[0].dims], []);
  assert.equal(r.zones[0].heightMm, 2600);
});

test('【失敗系】createZone: 部屋 null は { zones: [], zoneId: null }。cellKeys 空・解けないキー・不正な基準高は変化なし（zoneId null）', () => {
  const { graph, room, c0, c1 } = setup();
  assert.deepEqual(createZone(graph, null, [c0], FLAT(2400)), { zones: [], zoneId: null });
  room.setCeilingZones(createZone(graph, room, [c0], FLAT(2400)).zones);
  const before = zoneData(room.ceilingZones);
  for (const keys of [[], ['gone:gone:gone:gone'], null, undefined]) {
    const r = createZone(graph, room, keys, FLAT(2600));
    assert.equal(r.zoneId, null);
    assert.deepEqual(zoneData(r.zones), before);
  }
  for (const bad of [0, -100, NaN, Infinity, '2400', undefined]) {
    const r = createZone(graph, room, [c1], FLAT(bad));
    assert.equal(r.zoneId, null, String(bad));
    assert.deepEqual(zoneData(r.zones), before, String(bad));
  }
  const SLOPE = { heightMm: 2400, shape: 'slope', dims: [800, 0] };
  for (const bad of [0, -100, NaN, Infinity, '2400', undefined]) {
    assert.deepEqual(zoneData(createZone(graph, room, [c1], { ...SLOPE, heightMm: bad }).zones), before, `傾斜 ${String(bad)}`);
  }
});

test('updateZoneSpec: id とセルを保ち、形状・基準高・寸法だけ差し替える。同じ spec の別区画とも統合しない', () => {
  const { graph, room, c0, c1, c2 } = setup();
  room.setCeilingZones(createZone(graph, room, [c0], FLAT(2400)).zones);
  room.setCeilingZones(createZone(graph, room, [c1, c2], FLAT(2600)).zones);
  const [z0, z1] = room.ceilingZones;
  const next = updateZoneSpec(graph, room, z1.id, { heightMm: 2400, shape: 'slope', dims: [800, 270] });
  assert.equal(next.length, 2);
  assert.deepEqual(next.map(z => z.id), [z0.id, z1.id], 'id と順序を保つ');
  assert.deepEqual(next[1].cells, [c1, c2].sort(), 'セルを保つ');
  assert.deepEqual([next[1].shape, next[1].heightMm, [...next[1].dims]], ['slope', 2400, [800, 270]]);
  const same = updateZoneSpec(graph, room, z1.id, FLAT(2400));
  assert.equal(same.length, 2, '高さ 2400 の flat になっても z0 と統合しない');
  assert.deepEqual(same[0].cells, [c0]);
  assert.deepEqual([...room.ceilingZones].map(z => z.toData()), [z0, z1].map(z => z.toData()), '部屋は書き換えない');
});

test('【失敗系】updateZoneSpec: 未知の id・不正な基準高・平面で null（区画を空にする指定）は変化なし。部屋 null は []', () => {
  const { graph, room, c0 } = setup();
  assert.deepEqual(updateZoneSpec(graph, null, 'x', FLAT(2400)), []);
  room.setCeilingZones(createZone(graph, room, [c0], FLAT(2400)).zones);
  const before = room.ceilingZones.map(z => z.toData());
  const id = room.ceilingZones[0].id;
  assert.deepEqual(updateZoneSpec(graph, room, 'unknown', FLAT(2600)).map(z => z.toData()), before);
  for (const bad of [0, -1, NaN, '2600', undefined]) {
    assert.deepEqual(updateZoneSpec(graph, room, id, FLAT(bad)).map(z => z.toData()), before, String(bad));
  }
  assert.deepEqual(updateZoneSpec(graph, room, id, { heightMm: null, shape: 'flat', dims: [] }).map(z => z.toData()), before);
  // 形状に合わない寸法は平面に落ちる（区画は残る）
  const dropped = updateZoneSpec(graph, room, id, { heightMm: 2700, shape: 'slope', dims: [0, 45] });
  assert.deepEqual([dropped[0].shape, dropped[0].heightMm], ['flat', 2700]);
});

test('removeZone: 指定の区画だけを消す（セルは部屋の残りへ戻る）。【失敗系】未知の id は変化なし・部屋 null は []', () => {
  const { graph, room, c0, c1 } = setup();
  room.setCeilingZones(createZone(graph, room, [c0], FLAT(2400)).zones);
  room.setCeilingZones(createZone(graph, room, [c1], FLAT(2400)).zones);
  const [z0, z1] = room.ceilingZones;
  assert.deepEqual(removeZone(graph, room, z0.id).map(z => z.id), [z1.id]);
  assert.deepEqual(removeZone(graph, room, 'unknown').map(z => z.id), [z0.id, z1.id]);
  assert.deepEqual(room.ceilingZones.map(z => z.id), [z0.id, z1.id], '部屋は書き換えない');
  assert.deepEqual(removeZone(graph, null, z0.id), []);
});

// ---- 天井芯（S8a）: 区画のセルは天井セル（天井芯で割れた格子）の key ----
function ceilingSetup() {
  const g = makeGrid([0, 2000, 4000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0]]);
  const cc = g.graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.CEILING }, 'cc');
  const half = x => worldToCell(x, 1500, g.graph, CEILING_CELL_GRID).key;
  return { g, graph: g.graph, room, cc, left: half(500), right: half(1500), whole: g.cell(1, 0) };
}

test('天井芯: 天井セルの片側だけに高さを指定できる。反対側は区画の外（部屋の残りの群）', () => {
  const { graph, room, left, right } = ceilingSetup();
  room.setCeilingZones(assignZoneHeight(graph, room, [left], 2800));
  assert.deepEqual(room.ceilingZones[0].cells, [left]);
  const { groupOfCell } = ceilingGroupsOf(graph, buildCeilingCellOwners(graph));
  assert.equal(groupOfCell.get(left), zoneGroupId(room.id, room.ceilingZones[0].id));
  assert.equal(groupOfCell.get(right), roomGroupId(room.id), '天井芯の反対側は区画の外');
});

test('天井芯: 仕上げの key（割れる前のセル）を指定すると天井芯の両側の2つの天井セルへ展開されて区画になる', () => {
  const { graph, room, g, left, right } = ceilingSetup();
  room.setCeilingZones(assignZoneHeight(graph, room, [g.cell(0, 0)], 2800));
  assert.deepEqual([...room.ceilingZones[0].cells].sort(), [left, right].sort());
});

test('【失敗系】天井芯を削除すると、天井 key の区画は解けず normalizeZones が捨てる（空の区画は消える）。解けない key の指定は何も足さない', () => {
  const { graph, room, cc, left, right } = ceilingSetup();
  room.setCeilingZones(assignZoneHeight(graph, room, [left, right], 2800));
  assert.equal(room.ceilingZones.length, 1);
  graph.removeCenterLine(cc.id);
  assert.deepEqual(normalizeZones(graph, room), [], '解けた key が無く区画が消える');
  assert.deepEqual(assignZoneHeight(graph, room, [left], 3000).length, 0, '解けない key へは区画を足さない');
});
