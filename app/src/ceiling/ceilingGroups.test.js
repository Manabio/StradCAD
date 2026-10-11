// 天井セルの群（ceilingGroups.js。S12b）。どの所有セルもちょうど1つの群／群のセルが ceilingSurfacesOf の面と一致／部屋の並び順に依存しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature, StairType } from '@core';
import { makeGrid, assignZoneHeight } from '../plan/planTestFixtures.js';
import { buildCeilingCellOwners } from './ceilingOwners.js';
import { ceilingSurfacesOf } from './ceilingSurfaces.js';
import { ceilingGroupsOf, roomGroupId, zoneGroupId, stairGroupId } from './ceilingGroups.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { normalizeRect } from '../plan/planGeometry.js';

const XS = [0, 1000, 2000, 3000, 4000, 5000, 6000];
const YS = [0, 1000, 2000];

/**
 * A（親 3 セル。(1,0) に区画）・子（A の部分指定。(2,0)）・階段の対の部屋 P（STAIR。(3,0),(4,0)。(4,0) に区画）・階段 S（P のセル）・B（(5,0)）・吹抜け（(0,1)）・
 * 階段吹抜け sv（STAIR_VOID。(1,1)。索引外で群を持たない平らな面だけを持つ）。
 */
function setup() {
  const g = makeGrid(XS, YS);
  const a = g.interior([[0, 0], [1, 0], [2, 0]]);
  const child = g.graph.addRoom(new Set([g.cell(2, 0)]), '子', 'child-1', new Set([a.id]));
  const pair = g.feature([[3, 0], [4, 0]], RoomFeature.STAIR);
  const stair = g.graph.addStair({ type: StairType.STRAIGHT, roomId: pair.id, cells: new Set([g.cell(3, 0), g.cell(4, 0)]) });
  const b = g.interior([[5, 0]]);
  g.feature([[0, 1]], RoomFeature.VOID);
  const sv = g.feature([[1, 1]], RoomFeature.STAIR_VOID);
  a.setCeilingZones(assignZoneHeight(g.graph, a, [g.cell(1, 0)], 2600));
  pair.setCeilingZones(assignZoneHeight(g.graph, pair, [g.cell(4, 0)], 2500));
  return { g, graph: g.graph, a, child, pair, stair, b, sv };
}

const groupsOf = graph => ceilingGroupsOf(graph, buildCeilingCellOwners(graph));
const sortedCells = grp => [...grp.cells].sort();
const rectKey = r => `${r.x1},${r.y1},${r.x2},${r.y2}`;
const rectsOfCells = (graph, cells) => [...cells].map(k => rectKey(normalizeRect(cellBoundsFromKey(k, graph)))).sort();
const signature = ({ groups }) => JSON.stringify([...groups].map(([id, grp]) => [id, sortedCells(grp)]).sort());

test('群の id: roomGroupId / zoneGroupId / stairGroupId の形（S12c のパネルと共用）', () => {
  assert.equal(roomGroupId('r1'), 'room:r1');
  assert.equal(zoneGroupId('r1', 'z9'), 'zone:r1#z9');
  assert.equal(stairGroupId('s1'), 'stair:s1');
});

test('群: 区画の群・部屋の残り・階段の残りに分かれ、どの所有セルもちょうど1つの群に属す（互いに素・和は所属索引）', () => {
  const { graph, g, a, child, pair, stair, b } = setup();
  const owners = buildCeilingCellOwners(graph);
  const { groupOfCell, groups } = ceilingGroupsOf(graph, owners);
  const zoneA = a.ceilingZones[0], zonePair = pair.ceilingZones[0];
  assert.deepEqual([...groups.keys()].sort(), [
    roomGroupId(a.id), roomGroupId(child.id), roomGroupId(b.id),
    zoneGroupId(a.id, zoneA.id), zoneGroupId(pair.id, zonePair.id), stairGroupId(stair.id),
  ].sort());
  assert.deepEqual(sortedCells(groups.get(roomGroupId(a.id))), [g.cell(0, 0)], '親の残り（区画と子のセルを除く）');
  assert.deepEqual(sortedCells(groups.get(roomGroupId(child.id))), [g.cell(2, 0)], '部分指定の子の残り');
  assert.deepEqual(sortedCells(groups.get(zoneGroupId(a.id, zoneA.id))), [g.cell(1, 0)]);
  assert.deepEqual(sortedCells(groups.get(stairGroupId(stair.id))), [g.cell(3, 0)], '階段の残り（区画のセルを除く）');
  assert.deepEqual(sortedCells(groups.get(zoneGroupId(pair.id, zonePair.id))), [g.cell(4, 0)], '階段所属のセルも対の部屋の区画の群');
  const all = [];
  for (const grp of groups.values()) all.push(...grp.cells);
  assert.equal(new Set(all).size, all.length, '群のセルは互いに素');
  assert.deepEqual([...all].sort(), [...owners.keys()].sort(), '群の和は所属索引');
  for (const [key, gid] of groupOfCell) assert.ok(groups.get(gid).cells.has(key), `groupOfCell と群が一致: ${key}`);
  assert.equal(groupOfCell.size, owners.size);
  const g1 = groups.get(roomGroupId(a.id));
  assert.deepEqual([g1.kind, g1.roomId], ['room', a.id]);
  const g2 = groups.get(zoneGroupId(a.id, zoneA.id));
  assert.deepEqual([g2.kind, g2.roomId, g2.zoneId], ['zone', a.id, zoneA.id]);
  const g3 = groups.get(stairGroupId(stair.id));
  assert.deepEqual([g3.kind, g3.roomId, g3.stairId], ['stair', pair.id, stair.id]);
  assert.deepEqual(g3.owner, { kind: 'stair', id: stair.id, rowId: pair.id });
});

test('不変条件: ceilingSurfacesOf の各面は対応する群のセルと一致（区画の面⇔zone 群、残りの面⇔room 群）。階段の残りは面にならない', () => {
  const { graph, sv } = setup();
  const { groups } = groupsOf(graph);
  const allSurfaces = ceilingSurfacesOf(graph);
  assert.ok(allSurfaces.some(s => s.roomId === sv.id), '前提: STAIR_VOID の面はある（群を持たない）');
  const surfaces = allSurfaces.filter(s => s.roomId !== sv.id); // STAIR_VOID の面（索引外。stairVoidFace）は群を持たないので除く
  for (const s of surfaces) {
    const gid = s.zoneId ? zoneGroupId(s.roomId, s.zoneId) : roomGroupId(s.roomId);
    const grp = groups.get(gid);
    assert.ok(grp, `面に対応する群が無い: ${gid}`);
    assert.deepEqual(s.rects.map(rectKey).sort(), rectsOfCells(graph, grp.cells), gid);
  }
  const faceGroups = [...groups.values()].filter(x => x.kind !== 'stair');
  assert.equal(surfaces.length, faceGroups.length, '面の数 = zone 群 + room 群の数');
  assert.ok(![...groups.values()].some(x => x.kind === 'stair' && surfaces.some(s => s.roomId === x.roomId && !s.zoneId)));
});

test('不変条件（S12c 持ち越し4）: 階段の roomId が天井を持つ屋内部屋を指し、階段のセルが部屋の外にあっても、階段の残りのセルは部屋の「残り」の面に混ざらず、面と群が一致する', () => {
  const g = makeGrid(XS, YS);
  const r = g.interior([[0, 0], [1, 0]]);
  const stair = g.graph.addStair({ type: StairType.STRAIGHT, roomId: r.id, cells: new Set([g.cell(2, 0), g.cell(3, 0)]) });
  r.setCeilingZones(assignZoneHeight(g.graph, r, [g.cell(3, 0)], 2500)); // 階段所属のセル(3,0) は区画に入る。(2,0) は階段の残り
  const { groups } = groupsOf(g.graph);
  assert.deepEqual(sortedCells(groups.get(stairGroupId(stair.id))), [g.cell(2, 0)], '階段の残り');
  assert.deepEqual(sortedCells(groups.get(roomGroupId(r.id))), [g.cell(0, 0), g.cell(1, 0)].sort(), '部屋の残りは部屋所属のセルだけ');
  const surfaces = ceilingSurfacesOf(g.graph);
  const rest = surfaces.find(s => s.roomId === r.id && !s.zoneId);
  assert.deepEqual(rest.rects.map(rectKey).sort(), rectsOfCells(g.graph, groups.get(roomGroupId(r.id)).cells), '残りの面は部屋の残りの群と一致（階段のセルを含まない）');
  const zone = surfaces.find(s => s.zoneId);
  assert.deepEqual(zone.rects.map(rectKey).sort(), rectsOfCells(g.graph, groups.get(zoneGroupId(r.id, r.ceilingZones[0].id)).cells), '階段所属のセルの区画は区画の面');
  assert.equal(surfaces.length, 2, '階段の残りは面にならない');
});

test('群は部屋の並び順に依存しない（reorderRooms の全順列で同じ群）', () => {
  const { graph, a, child, pair, b } = setup();
  const ids = [a.id, child.id, pair.id, b.id];
  const base = signature(groupsOf(graph));
  const perms = list => (list.length <= 1 ? [list] : list.flatMap((x, i) => perms([...list.slice(0, i), ...list.slice(i + 1)]).map(p => [x, ...p])));
  const all = perms(ids);
  assert.equal(all.length, 24);
  for (const order of all) {
    graph.reorderRooms(order);
    assert.equal(signature(groupsOf(graph)), base, `順序 ${order.join(',')}`);
  }
});

test('区画が複数セルにまたがり、部屋のセルが区画より減ったら群も減る（区画のセルは部屋の所属の交差）', () => {
  const g = makeGrid(XS, YS);
  const r = g.interior([[0, 0], [1, 0], [2, 0]]);
  r.setCeilingZones(assignZoneHeight(g.graph, r, [g.cell(0, 0), g.cell(1, 0)], 2600));
  const z = r.ceilingZones[0];
  assert.equal(groupsOf(g.graph).groups.get(zoneGroupId(r.id, z.id)).cells.size, 2);
  r.setCells(new Set([g.cell(1, 0), g.cell(2, 0)])); // (0,0) が部屋から外れる
  const after = groupsOf(g.graph).groups;
  assert.deepEqual(sortedCells(after.get(zoneGroupId(r.id, z.id))), [g.cell(1, 0)]);
  assert.deepEqual(sortedCells(after.get(roomGroupId(r.id))), [g.cell(2, 0)]);
});

test('【失敗系】graph が null・owners が空・null なら空の結果（例外にしない）。区画しか無い部屋で所属が無ければ群なし', () => {
  const { graph } = setup();
  for (const [gr, ow] of [[null, new Map()], [graph, new Map()], [graph, null], [null, null]]) {
    const r = ceilingGroupsOf(gr, ow);
    assert.equal(r.groups.size, 0);
    assert.equal(r.groupOfCell.size, 0);
  }
});

test('【失敗系】対の部屋の無い階段の残りは roomId null の stair 群。参照切れの区画（所属が無いセル）は群にならない', () => {
  const g = makeGrid(XS, YS);
  const stair = g.graph.addStair({ type: StairType.STRAIGHT, cells: new Set([g.cell(0, 0), g.cell(1, 0)]) });
  const r = g.interior([[3, 0]]);
  r.setCeilingZones(assignZoneHeight(g.graph, r, [g.cell(3, 0)], 2500));
  r.setCells(new Set([g.cell(4, 0)])); // 区画のセルは部屋の外へ（所属が無い）
  const { groups } = groupsOf(g.graph);
  const sg = groups.get(stairGroupId(stair.id));
  assert.equal(sg.roomId, null);
  assert.equal(sg.cells.size, 2);
  assert.ok(![...groups.values()].some(x => x.kind === 'zone'), '所属の無い区画のセルは群にならない');
  assert.deepEqual(sortedCells(groups.get(roomGroupId(r.id))), [g.cell(4, 0)]);
});
