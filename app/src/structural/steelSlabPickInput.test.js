// steelSlabPickInput.js（S造スラブ指定のベイ一覧と openingRects の組み立て）と、
// steelSlabPickModel.js（見出しUIの出し分け）の単体テスト。
// フィクスチャは steelSlabBays.test.js の buildBay と同じ（4辺を primary 梁で囲んだ1ベイ。y 下向き正）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, RoomFeature, StairType, StructuralMaterialType } from '../core.js';
import { getAllCells } from '../finish/gridCells.js';
import { rulesFor } from './structureRules.js';
import { defaultSteelSlabSpec } from './steelSlabSpec.js';
import { assignSteelSlabBays } from './steelSlabBays.js';
import { prepareSteelSlabPick } from './steelSlabPickInput.js';
import { slabPickHeader } from './steelSlabPickModel.js';

const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎', steelSlabSpec: defaultSteelSlabSpec() }, memberGroupLedger: new Map() };
const STRUCT = { labeled: true, discipline: Discipline.STRUCT };

function buildBay(structure, { width = 5000, height = 7000 } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const rules = rulesFor(structure);
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, width, STRUCT);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, -height, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const add = (cl, isV, a, b) => graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, cl, isV, a, b, { role: 'primary' });
  add(y0, false, x0, x1); add(y1, false, x0, x1); add(x0, true, y0, y1); add(x1, true, y0, y1);
  return { graph, x0, x1, y0, y1 };
}

test('prepareSteelSlabPick: 開口の無い階（belowGraph なし）はベイを返し、openingRects は [] で assignSteelSlabBays にそのまま渡せる', () => {
  const { graph, x0, x1, y0, y1 } = buildBay('S造');
  const { bays, openingRects } = prepareSteelSlabPick({ graph, project: PROJECT });
  assert.deepEqual(bays.map(b => b.key), [`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]);
  assert.deepEqual(bays[0].cell && [bays[0].cell.x1, bays[0].cell.x2], [0, 5000]);
  assert.deepEqual(openingRects, []);
  const r = assignSteelSlabBays(graph, PROJECT, [bays[0].key], { openingRects });
  assert.equal(graph.slabs.length, 1);
  assert.equal(graph.slabs[0].id, r.slabId);
});

test('【失敗系】prepareSteelSlabPick: 床開口（吹抜け）と重なるベイは bays から除かれ、openingRects に開口が載る', () => {
  const { graph } = buildBay('S造');
  const cell = getAllCells(graph)[0];
  graph.addRoom(new Set([cell.key])).setFeature(RoomFeature.VOID);
  const { bays, openingRects } = prepareSteelSlabPick({ graph, project: PROJECT });
  assert.deepEqual(bays, [], '開口のベイは選べない');
  assert.equal(openingRects.length, 1);
  assert.throws(() => assignSteelSlabBays(graph, PROJECT, ['x:y:z:w'], { openingRects }), /現在のベイではありません/);
});

// 鉄骨 SWITCHBACK 階段（踊り場 x[0,2000] y[0,1500]／往路 x[0,1000] y[1500,4500]／復路＝破れ先 x[1000,2000] y[1500,4500]）を置く
// （openingBeamAxes.test.js addSteelSwitchbackStair と同形）。
function addSwitchbackStair(g) {
  const cl = (type, v) => g.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), xm = cl(CenterLineType.VERTICAL, 1000), x1 = cl(CenterLineType.VERTICAL, 2000);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), ym = cl(CenterLineType.HORIZONTAL, 1500), y1 = cl(CenterLineType.HORIZONTAL, 4500);
  const landing = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outbound = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const ret = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const room = g.addRoom(new Set([landing, outbound]), '階段');
  return g.addStair({
    type: StairType.SWITCHBACK, cells: new Set([landing, outbound, ret]), roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false, structure: StructuralMaterialType.STEEL,
  });
}

// 2階（S造・x[-1000,3500] y[-1000,5000] を大梁で囲んだ1ベイ）に階段、1階にも同じ足元の階段（到達元）。
function buildStairBayProject() {
  const project = new Project('proj-pick-stair', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  g1.structureOverride = 'S造'; g2.structureOverride = 'S造';
  addSwitchbackStair(g1);
  addSwitchbackStair(g2);
  const rules = rulesFor('S造');
  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, -1000, STRUCT), x1 = g2.addCenterLine(CenterLineType.VERTICAL, 3500, STRUCT);
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, -1000, STRUCT), y1 = g2.addCenterLine(CenterLineType.HORIZONTAL, 5000, STRUCT);
  const add = (cl, isV, a, b) => g2.addBeam(rules.baseMaterial, rules.defaultSections.beam, cl, isV, a, b, { role: 'primary' });
  add(y0, false, x0, x1); add(y1, false, x0, x1); add(x0, true, y0, y1); add(x1, true, y0, y1);
  return { project, g1, g2 };
}

test('prepareSteelSlabPick: 自階の階段の破れ先がベイに掛かり、belowGraph に到達元の階段があるとき、そのベイは bays に無く openingRects に入る（belowGraph なしでは bays にある）', () => {
  const { project, g1, g2 } = buildStairBayProject();
  const withBelow = prepareSteelSlabPick({ graph: g2, project, belowGraph: g1 });
  assert.ok(withBelow.openingRects.length > 0, '破れ先が開口になる');
  assert.deepEqual(withBelow.bays, [], '開口のベイは選べない');
  const without = prepareSteelSlabPick({ graph: g2, project, belowGraph: null });
  assert.deepEqual(without.openingRects, [], '到達元が無ければ破れ先は設置階の開口ではない');
  assert.equal(without.bays.length, 1, '対照: belowGraph なしでは同じベイが選べる');
});

test('【失敗系】prepareSteelSlabPick: 主題階自身を belowGraph に渡しても自階の階段を到達元とみなさない（StructuralLayer の belowGraph !== graph と同じ）', () => {
  const { project, g2 } = buildStairBayProject();
  const r = prepareSteelSlabPick({ graph: g2, project, belowGraph: g2 });
  assert.deepEqual(r.openingRects, []);
  assert.equal(r.bays.length, 1);
});

test('【失敗系】prepareSteelSlabPick: S造でない主構造（ベイ計算の対象外）は bays が空', () => {
  const { graph } = buildBay('RC造(ラーメン)');
  assert.deepEqual(prepareSteelSlabPick({ graph, project: PROJECT }).bays, []);
});

test('slabPickHeader: S造の階で選択中でなければトグルだけ。選択中は件数ラベルとボタン群', () => {
  assert.deepEqual(slabPickHeader({ active: false, selectedCount: 0, canAssign: true }),
    { showToggle: true, showActions: false, label: 'スラブ指定', canCommit: false, canRelease: false });
  assert.deepEqual(slabPickHeader({ active: true, selectedCount: 0, canAssign: true }),
    { showToggle: false, showActions: true, label: '0 ベイ選択中', canCommit: false, canRelease: false });
  assert.deepEqual(slabPickHeader({ active: true, selectedCount: 3, canAssign: true }),
    { showToggle: false, showActions: true, label: '3 ベイ選択中', canCommit: true, canRelease: true });
});

test('【失敗系】slabPickHeader: S造でない階（canAssign=false）はトグルを出さず、選択中でも「スラブにする」は不可', () => {
  assert.equal(slabPickHeader({ active: false, selectedCount: 0, canAssign: false }).showToggle, false);
  const stale = slabPickHeader({ active: true, selectedCount: 2, canAssign: false });
  assert.equal(stale.canCommit, false);
  assert.equal(stale.showActions, true, '取消の手段は残す');
});
