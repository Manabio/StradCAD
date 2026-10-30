// structural/roofSpecTabModel.js（構造パネルの外部タブに出す屋根の群と編集対象の graph）の単体テスト。
// 純モジュールのため node:test から直接 import できる（finish/exteriorGroups.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, RoomKind, RoomFeature, RoofSpec } from '@core';
import { roofSpecTabGroups, ROOF_SPEC_TAB_EMPTY } from './roofSpecTabModel.js';

// 1階・2階（最上階）・屋根専用平面（R。最上階に紐づく）の建物。
function makeProject() {
  const project = new Project('prj', 'test');
  project.addPlane(0, '1階', 'p1');
  project.addPlane(3000, '2階', 'p2');
  project.addPlane(6000, 'R', 'pr', 1, 1, false, null, 0, true, 'p2');
  return project;
}

// 下屋（feature===ROOF の屋外部屋。I1: roofSpec を持つ）を1つ足す。
function addRoofRoom(graph, name = '屋根') {
  const room = graph.addRoom(new Set([`cell-${name}-${Math.random()}`]), name);
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.ROOF);
  room.setRoofSpec(new RoofSpec());
  return room;
}

test('roofSpecTabGroups: 最上階は主屋根の群＋自階の下屋の群。編集対象は自階', () => {
  const project = makeProject();
  const graph = project.graphMap.get('p2');
  const roof = addRoofRoom(graph);
  const { target, groups } = roofSpecTabGroups({ graph, belowGraph: project.graphMap.get('p1'), project });
  assert.equal(target, graph);
  assert.deepEqual(groups.map(g => g.type), ['mainRoof', 'roof']);
  assert.equal(groups[1].roomId, roof.id);
  assert.equal(groups[1].key, `roof:${roof.id}`);
});

test('roofSpecTabGroups: 最上階でない階は下屋の群だけ（主屋根は出さない）。屋外部屋・部位行は出さない', () => {
  const project = makeProject();
  const graph = project.graphMap.get('p1');
  const roof = addRoofRoom(graph);
  const terrace = graph.addRoom(new Set(['t']), 'テラス');
  terrace.setKind(RoomKind.EXTERIOR);
  graph.addExteriorRow('exteriorRows', '外壁');
  const { target, groups } = roofSpecTabGroups({ graph, belowGraph: null, project });
  assert.equal(target, graph);
  assert.deepEqual(groups.map(g => [g.type, g.roomId]), [['roof', roof.id]]);
});

test('roofSpecTabGroups: 屋根専用平面（小屋伏図）は最上階（belowGraph）の主屋根の群だけ。編集対象は belowGraph。最上階の下屋は出さない', () => {
  const project = makeProject();
  const top = project.graphMap.get('p2');
  addRoofRoom(top);
  const roofGraph = project.graphMap.get('pr');
  const { target, groups } = roofSpecTabGroups({ graph: roofGraph, belowGraph: top, project });
  assert.equal(target, top);
  assert.deepEqual(groups.map(g => g.type), ['mainRoof']);
});

test('【失敗系】roofSpecTabGroups: 屋根専用平面で belowGraph が無い／最上階でない階が来たときは空（編集対象 null）', () => {
  const project = makeProject();
  const roofGraph = project.graphMap.get('pr');
  assert.deepEqual(roofSpecTabGroups({ graph: roofGraph, belowGraph: null, project }), { target: null, groups: [] });
  assert.deepEqual(roofSpecTabGroups({ graph: roofGraph, belowGraph: project.graphMap.get('p1'), project }), { target: null, groups: [] });
});

test('【失敗系】roofSpecTabGroups: graph が無い（階切替の途中）は空。project が無ければ主屋根は出さず下屋だけ', () => {
  const project = makeProject();
  assert.deepEqual(roofSpecTabGroups({ graph: null, belowGraph: null, project }), { target: null, groups: [] });
  assert.deepEqual(roofSpecTabGroups({ graph: undefined, belowGraph: null, project }), { target: null, groups: [] });
  const graph = project.graphMap.get('p2');
  addRoofRoom(graph);
  const { groups } = roofSpecTabGroups({ graph, belowGraph: null, project: null });
  assert.deepEqual(groups.map(g => g.type), ['roof']);
  assert.ok(ROOF_SPEC_TAB_EMPTY.length > 0);
});
