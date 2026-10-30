import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph, Project, Room, RoomKind, RoomFeature, RoofSpec, RoofZone } from '@core';
import { createRoofZoneSpec, createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { MATERIALS } from '../finish/materials/materialData.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { ceilingExteriorRows } from './ceilingExteriorRows.js';

const materialMap = new Map(MATERIALS.map(m => [m.code, m]));

function projectWithFloors(count) {
  const project = new Project('p1', 'test');
  const planes = [];
  for (let i = 0; i < count; i++) planes.push(project.addPlane(i * 3000, `${i + 1}階`, `f${i + 1}`, i + 1).plane);
  return { project, planes };
}

function addRoof(graph, id, spec = createLeanToRoofSpec()) {
  const room = new Room(id, '屋根', new Set(), new Set(), RoomKind.EXTERIOR, null, RoomFeature.ROOF);
  room.setRoofSpec(spec);
  graph.roomMap.set(id, room);
  graph.roomOrder.push(id);
  return room;
}

test('下屋 1 件: 名前「軒裏」・表示のみ・id soffit:<roomId>。既定の軒裏は略称（けい酸カルシウム板 ア)8）で出る', () => {
  const { project, planes } = projectWithFloors(3);
  const graph = new PlanGraph(planes[0]);
  const above = new PlanGraph(planes[1]);
  addRoof(above, 'rf1', new RoofSpec()); // 空 spec＝既定へ読み替え
  const rows = ceilingExteriorRows({ graph, aboveGraph: above, project, materialMap });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual([r.id, r.kind, r.name, r.roomId, r.editable], ['soffit:rf1', 'leanTo', '軒裏', 'rf1', false]);
  assert.equal(r.material, '301000000015');
  assert.equal(r.materialLabel, 'けい酸カルシウム板 ア)8');
  assert.equal(r.orientation, 'sloped');
  assert.equal(r.note, '');
});

test('下屋 2 件: 「軒裏1」「軒裏2」を graph.rooms の順に。note は原文', () => {
  const { project, planes } = projectWithFloors(3);
  const graph = new PlanGraph(planes[0]);
  const above = new PlanGraph(planes[1]);
  addRoof(above, 'a');
  addRoof(above, 'b');
  const rows = ceilingExteriorRows({ graph, aboveGraph: above, project, materialMap });
  assert.deepEqual(rows.map(r => [r.id, r.name]), [['soffit:a', '軒裏1'], ['soffit:b', '軒裏2']]);
  assert.equal(rows[0].note, '目透かし貼り');
});

test('下地の表示は上階の主構造が木造のときだけ（下屋）。S造・未指定は backingShown=false', () => {
  const { project, planes } = projectWithFloors(3);
  const graph = new PlanGraph(planes[0]);
  const above = new PlanGraph(planes[1]);
  addRoof(above, 'a');
  above.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(ceilingExteriorRows({ graph, aboveGraph: above, project, materialMap })[0].backingShown, true);
  above.setStructureOverride('S造');
  assert.equal(ceilingExteriorRows({ graph, aboveGraph: above, project, materialMap })[0].backingShown, false);
  above.setStructureOverride(null);
  assert.equal(ceilingExteriorRows({ graph, aboveGraph: above, project, materialMap })[0].backingShown, false);
});

test('主屋根の行は最上階だけ・末尾・編集可。中間階・最下階には出ない。検討案は最上階の参照なら出る', () => {
  const { project, planes } = projectWithFloors(3);
  const top = new PlanGraph(planes[2]);
  top.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE);
  const rows = ceilingExteriorRows({ graph: top, aboveGraph: null, project, materialMap });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].id, rows[0].kind, rows[0].name, rows[0].editable, rows[0].backingShown], ['soffit:main', 'main', '軒裏（主屋根）', true, true]);
  assert.equal(rows[0].spec, top.mainRoofSpec);
  assert.equal(ceilingExteriorRows({ graph: new PlanGraph(planes[1]), aboveGraph: top, project, materialMap }).every(r => r.id !== 'soffit:main'), true);
  assert.equal(ceilingExteriorRows({ graph: new PlanGraph(planes[0]), aboveGraph: null, project, materialMap }).length, 0);
  const alt = project.addPlane(6000, '3階検討', 'alt-top', 3, 1, true, planes[2].id, 1).plane;
  assert.equal(ceilingExteriorRows({ graph: new PlanGraph(alt), aboveGraph: null, project, materialMap }).length, 1, '検討案の平面も最上階扱い');
  const altMid = project.addPlane(3000, '2階検討', 'alt-mid', 2, 1, true, planes[1].id, 1).plane;
  assert.equal(ceilingExteriorRows({ graph: new PlanGraph(altMid), aboveGraph: null, project, materialMap }).length, 0);
});

test('下屋の行（上階）と主屋根の行は並ぶ（下屋が先、主屋根が末尾）（組み立て順の確認。実データでは同時に出ない）', () => {
  const { project, planes } = projectWithFloors(2);
  const graph = new PlanGraph(planes[1]);
  const above = new PlanGraph(planes[1]);
  addRoof(above, 'a');
  assert.deepEqual(ceilingExteriorRows({ graph, aboveGraph: above, project, materialMap }).map(r => r.id), ['soffit:a', 'soffit:main']);
});

test('【失敗系】aboveGraph が null/undefined・屋根でない部屋・roofSpec なしの屋根部屋・rooms なし・project null でも例外にならず下屋の行 0 件', () => {
  const { project, planes } = projectWithFloors(3);
  const graph = new PlanGraph(planes[0]);
  assert.deepEqual(ceilingExteriorRows({ graph, aboveGraph: null, project, materialMap }), []);
  assert.deepEqual(ceilingExteriorRows({ graph, aboveGraph: undefined, project, materialMap }), []);
  assert.deepEqual(ceilingExteriorRows({ graph, aboveGraph: {}, project, materialMap }), []);
  const above = new PlanGraph(planes[1]);
  above.roomMap.set('p', new Room('p', '居室', new Set()));
  above.roomOrder.push('p');
  const bare = addRoof(above, 'x');
  bare.roofSpec = null; // I1 が崩れた状態でも落ちない
  assert.deepEqual(ceilingExteriorRows({ graph, aboveGraph: above, project, materialMap }), []);
  assert.deepEqual(ceilingExteriorRows({ graph, aboveGraph: above, project: null, materialMap }), []);
  assert.deepEqual(ceilingExteriorRows({ graph: null, aboveGraph: null, project: null }), []);
});

test('【失敗系】project が null なら主屋根の行は出さず、下屋の行は出る（主構造は未指定扱い）', () => {
  const { planes } = projectWithFloors(2);
  const graph = new PlanGraph(planes[1]);
  const above = new PlanGraph(planes[1]);
  addRoof(above, 'a');
  const rows = ceilingExteriorRows({ graph, aboveGraph: above, project: null, materialMap });
  assert.deepEqual(rows.map(r => r.id), ['soffit:a']);
  assert.equal(rows[0].backingShown, false);
});

function addZones(graph, ids) {
  const zones = ids.map(id => new RoofZone({ id, cells: [`c-${id}`], spec: createRoofZoneSpec(graph.mainRoofSpec) }));
  graph.setRoofZones(Object.freeze(zones));
  return zones;
}

test('【屋根区画 S2】最上階は主屋根の行の次に区画の行（id soffit:zone:<id>・kind zone・「軒裏（屋根区画N）」・zoneId・編集可・spec は区画の spec）', () => {
  const { project, planes } = projectWithFloors(3);
  const top = new PlanGraph(planes[2]);
  top.setStructureOverride(TRADITIONAL_WOOD_STRUCTURE);
  const zones = addZones(top, ['za', 'zb']);
  const rows = ceilingExteriorRows({ graph: top, aboveGraph: null, project, materialMap });
  assert.deepEqual(rows.map(r => r.id), ['soffit:main', 'soffit:zone:za', 'soffit:zone:zb']);
  assert.deepEqual(rows.slice(1).map(r => [r.kind, r.name, r.zoneId, r.roomId, r.editable, r.backingShown]),
    [['zone', '軒裏（屋根区画1）', 'za', null, true, true], ['zone', '軒裏（屋根区画2）', 'zb', null, true, true]]);
  assert.equal(rows[1].spec, zones[0].spec);
  assert.notEqual(rows[1].spec, top.mainRoofSpec, '区画の spec は主屋根の spec と別実体');
  assert.equal(rows[0].zoneId, null, '主屋根の行は zoneId を持たない（null）');
  assert.equal(rows[1].materialLabel, 'けい酸カルシウム板 ア)8', 'createRoofZoneSpec が軒裏の既定を埋めている');
});

test('【屋根区画 S2・失敗系】最上階でない階・project なしでは区画の行を出さない（休眠）。区画 0 件は従来どおり主屋根の行だけ', () => {
  const { project, planes } = projectWithFloors(3);
  const mid = new PlanGraph(planes[1]);
  addZones(mid, ['za']);
  assert.deepEqual(ceilingExteriorRows({ graph: mid, aboveGraph: null, project, materialMap }), []);
  const top = new PlanGraph(planes[2]);
  assert.deepEqual(ceilingExteriorRows({ graph: top, aboveGraph: null, project, materialMap }).map(r => r.id), ['soffit:main']);
  addZones(top, ['zb']);
  assert.deepEqual(ceilingExteriorRows({ graph: top, aboveGraph: null, project: null, materialMap }), []);
});

test('materialMap が無い・コードが解けないときは表示名がコードのまま', () => {
  const { project, planes } = projectWithFloors(3);
  const above = new PlanGraph(planes[1]);
  addRoof(above, 'a');
  const rows = ceilingExteriorRows({ graph: new PlanGraph(planes[0]), aboveGraph: above, project });
  assert.equal(rows[0].materialLabel, '301000000015');
});
