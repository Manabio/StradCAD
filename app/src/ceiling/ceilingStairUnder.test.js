// 階段下の群（ceilingStairUnder.js ＋ ceilingGroups.js の 'stairUnder'）。選択専用で、所属索引・描画は変えない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomKind, RoomFeature, StairType } from '@core';
import { makeGrid, assignZoneHeight } from '../plan/planTestFixtures.js';
import { buildCeilingCellOwners } from './ceilingOwners.js';
import { ceilingSurfacesOf } from './ceilingSurfaces.js';
import { ceilingGroupsOf, stairGroupId, stairUnderGroupId, zoneGroupId } from './ceilingGroups.js';
import { stairUnderCeilingKeys } from './ceilingStairUnder.js';
import { cellBoundsList } from '../finish/gridCells.js';

/** 4 セルの STAIR ペア部屋 P ＋ 直進階段 S（右へ上る。階高 3200・16 段＝蹴上 200 で、破れ先は右 2 セル = 2,3）。 */
function setup() {
  const g = makeGrid([0, 1000, 2000, 3000, 4000], [0, 1000]);
  const cells = [[0, 0], [1, 0], [2, 0], [3, 0]];
  const pair = g.feature(cells, RoomFeature.STAIR);
  const stair = g.graph.addStair({ type: StairType.STRAIGHT, upDirection: 'right', totalSteps: 16, roomId: pair.id, cells: new Set(cells.map(([i, j]) => g.cell(i, j))) });
  return { g, graph: g.graph, pair, stair, k: i => g.cell(i, 0) };
}
const LOWEST = { lowerStairCellBounds: [], floorHeightMm: 3200 };
const sorted = set => [...set].sort();
const groupsWith = (graph, ctx) => {
  const owners = buildCeilingCellOwners(graph);
  return ceilingGroupsOf(graph, owners, stairUnderCeilingKeys(graph, owners, ctx));
};

test('stairUnderGroupId の形', () => {
  assert.equal(stairUnderGroupId('s1'), 'stairUnder:s1');
});

test('最下階（下階の階段なし）: 階段の群が 階段 ＋ 階段下 に割れ、セルは互いに素で和は従来の階段の群と一致', () => {
  const { graph, stair, pair, k } = setup();
  const before = groupsWith(graph, null).groups.get(stairGroupId(stair.id));
  assert.deepEqual(sorted(before.cells), [0, 1, 2, 3].map(k).sort(), '前提: 従来は階段の群 1 つ');
  const owners = buildCeilingCellOwners(graph);
  const keys = stairUnderCeilingKeys(graph, owners, LOWEST);
  assert.deepEqual(sorted(keys.get(stair.id)), [k(2), k(3)].sort());
  const { groups, groupOfCell } = ceilingGroupsOf(graph, owners, keys);
  const body = groups.get(stairGroupId(stair.id));
  const under = groups.get(stairUnderGroupId(stair.id));
  assert.deepEqual(sorted(body.cells), [k(0), k(1)].sort());
  assert.deepEqual(sorted(under.cells), [k(2), k(3)].sort());
  assert.deepEqual([under.kind, under.roomId, under.stairId], ['stairUnder', pair.id, stair.id]);
  assert.deepEqual(under.owner, { kind: 'stair', id: stair.id, rowId: pair.id }, '所属は階段のまま（書込み先・タブの判定は階段と同じ）');
  assert.deepEqual(sorted(new Set([...body.cells, ...under.cells])), sorted(before.cells));
  assert.equal(groupOfCell.size, owners.size, 'どの所有セルもちょうど 1 つの群');
  assert.equal(groupOfCell.get(k(3)), stairUnderGroupId(stair.id));
});

test('階段下の群は選択専用: 所属索引と天井の面は stairUnderKeys の有無で変わらない', () => {
  const { graph } = setup();
  const owners = buildCeilingCellOwners(graph);
  const surfaces = ceilingSurfacesOf(graph);
  stairUnderCeilingKeys(graph, owners, LOWEST);
  assert.deepEqual(buildCeilingCellOwners(graph), owners);
  assert.deepEqual(ceilingSurfacesOf(graph), surfaces);
});

test('中間階: 破れ先のうち下階の階段に当たるセルは階段下ではなく、階段の群に残る（セル単位）', () => {
  const { graph, stair, k } = setup();
  const lower = { stair: { id: 'lower' }, cellBounds: cellBoundsList(new Set([k(3)]), graph) };
  const keys = stairUnderCeilingKeys(graph, buildCeilingCellOwners(graph), { lowerStairCellBounds: [lower], floorHeightMm: 3200 });
  assert.deepEqual(sorted(keys.get(stair.id)), [k(2)]);
  const { groups } = groupsWith(graph, { lowerStairCellBounds: [lower], floorHeightMm: 3200 });
  assert.deepEqual(sorted(groups.get(stairGroupId(stair.id)).cells), [k(0), k(1), k(3)].sort());
  assert.deepEqual(sorted(groups.get(stairUnderGroupId(stair.id)).cells), [k(2)]);
});

test('階高が引けない（floorHeightMm null・riser 未指定）でも破れ先は既定比率で決まり、階段下に割れる', () => {
  const { graph, stair, k } = setup();
  const keys = stairUnderCeilingKeys(graph, buildCeilingCellOwners(graph), { lowerStairCellBounds: [], floorHeightMm: null });
  assert.deepEqual(sorted(keys.get(stair.id)), [k(3)]);
});

test('【失敗系】ctx が null（下階を判定できない）なら null で、群は割れない', () => {
  const { graph, stair } = setup();
  const owners = buildCeilingCellOwners(graph);
  assert.equal(stairUnderCeilingKeys(graph, owners, null), null);
  assert.equal(stairUnderCeilingKeys(null, owners, LOWEST), null);
  assert.equal(stairUnderCeilingKeys(graph, null, LOWEST), null);
  const { groups } = groupsWith(graph, null);
  assert.equal(groups.has(stairUnderGroupId(stair.id)), false);
  assert.equal(groups.get(stairGroupId(stair.id)).cells.size, 4);
});

test('【失敗系】下階の階段がすべての破れ先を覆うなら階段下は無い（空の群を作らない）', () => {
  const { graph, stair, k } = setup();
  const lower = { stair: { id: 'lower' }, cellBounds: cellBoundsList(new Set([k(2), k(3)]), graph) };
  const keys = stairUnderCeilingKeys(graph, buildCeilingCellOwners(graph), { lowerStairCellBounds: [lower], floorHeightMm: 3200 });
  assert.equal(keys.has(stair.id), false);
  assert.equal(groupsWith(graph, { lowerStairCellBounds: [lower], floorHeightMm: 3200 }).groups.has(stairUnderGroupId(stair.id)), false);
});

test('【失敗系】破れ先が導出できない階段（セルなし）は階段下なし。例外にしない', () => {
  const g = makeGrid([0, 1000, 2000], [0, 1000]);
  const stair = g.graph.addStair({ type: StairType.STRAIGHT, upDirection: 'right', totalSteps: 16, cells: new Set() });
  const owners = buildCeilingCellOwners(g.graph);
  const keys = stairUnderCeilingKeys(g.graph, owners, LOWEST);
  assert.equal(keys.has(stair.id), false);
});

test('【失敗系】屋外階段（stairHasCeiling が偽）は階段下の群を作らない', () => {
  const { graph, pair, stair } = setup();
  pair.setKind(RoomKind.EXTERIOR);
  const owners = buildCeilingCellOwners(graph);
  assert.equal(owners.size, 0, '前提: 屋外階段は所属索引に載らない');
  const keys = stairUnderCeilingKeys(graph, owners, LOWEST);
  assert.equal(keys.has(stair.id), false);
  assert.equal(groupsWith(graph, LOWEST).groups.size, 0);
});

test('【失敗系】2a 部屋（階段下に登録した部屋）があるセルは部屋が勝ち、階段下の群に入らない。全部を覆えば階段下の群は無い', () => {
  const { g, graph, stair, k } = setup();
  const room = g.interior([[3, 0]]); // 破れ先 2,3 のうち 3 を部屋が持つ
  let { groups } = groupsWith(graph, LOWEST);
  assert.deepEqual(sorted(groups.get(stairUnderGroupId(stair.id)).cells), [k(2)]);
  assert.deepEqual(sorted(groups.get(`room:${room.id}`).cells), [k(3)], '部屋が勝つ');
  room.setCells(new Set([k(2), k(3)]));
  ({ groups } = groupsWith(graph, LOWEST));
  assert.equal(groups.has(stairUnderGroupId(stair.id)), false);
  assert.deepEqual(sorted(groups.get(stairGroupId(stair.id)).cells), [k(0), k(1)].sort());
});

test('区画が階段下のセルを覆うと、そのセルは区画の群（先勝ち）。一部だけなら残りが階段下の群', () => {
  const { graph, pair, stair, k } = setup();
  pair.setCeilingZones(assignZoneHeight(graph, pair, [k(3)], 2500));
  const zone = pair.ceilingZones[0];
  let { groups, groupOfCell } = groupsWith(graph, LOWEST);
  assert.deepEqual(sorted(groups.get(zoneGroupId(pair.id, zone.id)).cells), [k(3)]);
  assert.deepEqual(sorted(groups.get(stairUnderGroupId(stair.id)).cells), [k(2)]);
  assert.equal(groupOfCell.get(k(3)), zoneGroupId(pair.id, zone.id));
  pair.setCeilingZones(assignZoneHeight(graph, pair, [k(2), k(3)], 2500));
  ({ groups } = groupsWith(graph, LOWEST));
  assert.equal(groups.has(stairUnderGroupId(stair.id)), false, '全部が区画なら階段下の群は残らない');
  assert.deepEqual(sorted(groups.get(stairGroupId(stair.id)).cells), [k(0), k(1)].sort());
});
