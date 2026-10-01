// 手動追加材サイレント撤去回避（dev直下 260929_手動追加材サイレント撤去回避.md）ステップ1。
// structural/manualMemberAdd.js の addManualColumn/addManualFooting/addManualBeam を検証する。
// フィクスチャはstructural/structuralAutoFill.test.jsのmakeGridGraph・GRID_PROJECTと同一構成。
// .jsx/store.js/snap.jsはimportしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { addManualColumn, addManualFooting, addManualBeam } from './manualMemberAdd.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { autoFillWoodWallBeams, autoFillWoodBeamDepths } from './woodAutoFill.js';
import { selfWallSegments } from './wallBeamAxes.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';

function makeGridGraph(structure, xs = [0, 4000], ys = [0, 4000]) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const xCLs = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  const yCLs = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  return { graph, xCLs, yCLs };
}
const GRID_PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };

// ---- (a) 追加直後がlockedであること（柱・基礎・梁） ----
test('【手動追加】柱を追加すると直後にdimensionStatusがlockedになる（S造）', () => {
  const { graph, xCLs: [, x2], yCLs: [y1] } = makeGridGraph('S造');
  const column = addManualColumn(graph, GRID_PROJECT, { vCL: x2, hCL: y1 });
  assert.equal(column.dimensionStatus, 'locked');
  assert.equal(graph.columnMap.has(column.id), true);
});

test('【手動追加】独立基礎を追加すると直後にdimensionStatusがlockedになる（S造）', () => {
  const { graph, xCLs: [, x2], yCLs: [y1] } = makeGridGraph('S造');
  const footing = addManualFooting(graph, GRID_PROJECT, { kind: 'independent', vCL: x2, hCL: y1 });
  assert.equal(footing.dimensionStatus, 'locked');
  assert.equal(graph.footingMap.has(footing.id), true);
});

test('【手動追加】梁を追加すると直後にdimensionStatusがlockedになる（S造）', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  const beam = addManualBeam(graph, GRID_PROJECT, { axisCL: y1, isVertical: false, clStart: x1, clEnd: x2 });
  assert.equal(beam.dimensionStatus, 'locked');
  assert.equal(graph.beamMap.has(beam.id), true);
});

// ---- (d) 在来木造の柱も従来どおりlocked（columnSizing:'fixed'。壁交点方式） ----
test('【手動追加】在来木造の柱も追加直後にdimensionStatusがlockedになる', () => {
  const { graph, xCLs: [, x2], yCLs: [y1] } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE);
  const column = addManualColumn(graph, GRID_PROJECT, { vCL: x2, hCL: y1 });
  assert.equal(column.dimensionStatus, 'locked');
});

// ---- (b) 順序=「追加→初期値の自動算定→locked」であること ----
// S造（columnSizing:'tributary'）の柱はautoFillColumnSizesの対象——先にlockedにすると
// dimensionStatus!=='auto'でスキップされ、tributaryWidthが既定のnullのまま残る
// （structuralAutoFill.js:915 `if (column.dimensionStatus !== 'auto') continue;`）。
test('【手動追加】柱の初期値算定（tributaryWidth）はlockedにする前に行われる（S造）', () => {
  const { graph, xCLs: [, x2], yCLs: [y1] } = makeGridGraph('S造');
  const column = addManualColumn(graph, GRID_PROJECT, { vCL: x2, hCL: y1 });
  assert.equal(column.dimensionStatus, 'locked');
  assert.notEqual(column.tributaryWidth, null, 'tributaryWidthの初期値算定が行われていない');
});

// 独立基礎（IndependentFooting）はpedestalDepthを持たないため対象外——autoFillColumnBaseSizesは
// 'pedestalDepth' in footing の柱脚のみを見る（structuralAutoFill.js:933）。柱脚（kind:'base'）で確認する。
test('【手動追加】柱脚の初期値算定（widthX/widthY/pedestalDepth）はlockedにする前に行われる（S造）', () => {
  const { graph, xCLs: [, x2], yCLs: [y1] } = makeGridGraph('S造');
  const footing = addManualFooting(graph, GRID_PROJECT, { kind: 'base', vCL: x2, hCL: y1 });
  assert.equal(footing.dimensionStatus, 'locked');
  assert.notEqual(footing.pedestalDepth, null, '柱脚の初期値算定が行われていない');
});

// ---- (c) 失敗経路: CL欠落・clStart===clEndで例外を投げ、graphに何も追加されない ----
test('【手動追加・失敗経路】柱の追加でvCL/hCLが欠けていると例外を投げ、何も追加されない', () => {
  const { graph, xCLs: [, x2], yCLs: [y1] } = makeGridGraph('S造');
  assert.throws(() => addManualColumn(graph, GRID_PROJECT, { vCL: null, hCL: y1 }), /vCL.*hCL|必須/);
  assert.throws(() => addManualColumn(graph, GRID_PROJECT, { vCL: x2, hCL: null }), /vCL.*hCL|必須/);
  assert.equal(graph.columns.length, 0);
});

test('【手動追加・失敗経路】基礎の追加でvCL/hCLが欠けていると例外を投げ、何も追加されない', () => {
  const { graph, yCLs: [y1] } = makeGridGraph('S造');
  assert.throws(() => addManualFooting(graph, GRID_PROJECT, { kind: 'independent', vCL: null, hCL: y1 }), /必須/);
  assert.equal(graph.footings.length, 0);
});

test('【手動追加・失敗経路】梁の追加でaxisCL/clStart/clEndが欠けていると例外を投げ、何も追加されない', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  assert.throws(() => addManualBeam(graph, GRID_PROJECT, { axisCL: null, isVertical: false, clStart: x1, clEnd: x2 }), /必須/);
  assert.throws(() => addManualBeam(graph, GRID_PROJECT, { axisCL: y1, isVertical: false, clStart: null, clEnd: x2 }), /必須/);
  assert.equal(graph.beams.length, 0);
});

test('【手動追加・失敗経路】梁の追加でclStart===clEndだと例外を投げ、何も追加されない', () => {
  const { graph, xCLs: [x1], yCLs: [y1] } = makeGridGraph('S造');
  assert.throws(() => addManualBeam(graph, GRID_PROJECT, { axisCL: y1, isVertical: false, clStart: x1, clEnd: x1 }), /異なるCL/);
  assert.equal(graph.beams.length, 0);
});

// ---- (e) 在来木造の梁は追加直後に梁成を算定してから locked になる ----
// フィクスチャはwoodAutoFill.test.jsのB1（通り芯間3640・荷重なし→成300）と同一条件——
// 既定断面(WOOD-105x105)のままなら成105、算定されればWOOD-120x300になる（columnWidth=120は
// 未設定時の在来木造の既定値。structureRules.js woodColumnWidthMm）。
test('【手動追加】在来木造の梁は追加直後に梁成が算定されてからlockedになる', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE, [0, 3640]);
  const beam = addManualBeam(graph, GRID_PROJECT, { axisCL: y1, isVertical: false, clStart: x1, clEnd: x2 });
  assert.equal(beam.dimensionStatus, 'locked');
  assert.equal(beam.sectionDefId, 'WOOD-120x300', '梁成算定（autoFillWoodBeamDepths）が行われていない');
});

// ---- (f) 失敗経路: 成の算定条件が無ければ既定断面のまま locked になり例外を投げない ----
// S造はrules.framingを持たないためautoFillWoodBeamDepthsは[]を返し何もしない
// （structureRules.js:470、B7テストと同じ理由）。
test('【手動追加・失敗経路】S造（framing無し）の梁は成の算定条件が無いため既定断面のままlockedになる', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造', [0, 3640]);
  const beam = addManualBeam(graph, GRID_PROJECT, { axisCL: y1, isVertical: false, clStart: x1, clEnd: x2 });
  assert.equal(beam.dimensionStatus, 'locked');
  assert.equal(beam.sectionDefId, 'STEEL-H200x100');
});

// ---- (g) 在来木造の手動追加は追加した梁だけに、その梁自身の表値で書き戻す（リード裁定2026-10-01） ----
// 3640×1820の矩形の壁線上の梁を下階柱込み（四隅＋(1820,0)）で収束させた後、belowColumns=[]固定の手動追加を行う。
// 旧実装（全auto梁へ伝播込みで書き戻す）では、下階柱を渡せないためF1のスキップが効かず、隅の相互hostを通って
// 最大の成が連結した梁すべてへ回り、追加梁自身もふくらんだ成のままlockedになっていた。
function makeConvergedRectGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const cl = (t, v) => graph.addCenterLine(t, v, { labeled: true, discipline: Discipline.STRUCT });
  const x0 = cl(CenterLineType.VERTICAL, 0), xm = cl(CenterLineType.VERTICAL, 1820), x1 = cl(CenterLineType.VERTICAL, 3640);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), y1 = cl(CenterLineType.HORIZONTAL, 1820);
  generateRoomWallsFromOutline(graph, graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A'));
  const below = [[1820, 0], [0, 0], [3640, 0], [0, 1820], [3640, 1820]].map(([x, y]) => ({ x, y, axisX: x, axisY: y, role: 'standard' }));
  autoFillWoodWallBeams(graph, GRID_PROJECT, selfWallSegments(graph), null, below);
  autoFillWoodBeamDepths(graph, GRID_PROJECT, below);
  return { graph, xm, y0, y1 };
}

test('【手動追加】在来木造: 追加梁以外のauto梁の成は1本も変わらず、追加梁は自身の表値(120)でlockedになる', () => {
  const { graph, xm, y0, y1 } = makeConvergedRectGraph();
  const pre = new Map(graph.beams.map(b => [b.id, b.sectionDefId]));
  assert.equal(pre.size, 5, '前提: 上辺の半梁2本・下辺・左右の縦梁');
  const beam = addManualBeam(graph, GRID_PROJECT, { axisCL: xm, isVertical: true, clStart: y0, clEnd: y1 });
  const changed = graph.beams.filter(b => b !== beam && pre.get(b.id) !== b.sectionDefId);
  assert.equal(changed.length, 0, `他のauto梁の成が変わっている: ${changed.map(b => `${b.axisValue}:${pre.get(b.id)}->${b.sectionDefId}`)}`);
  assert.equal(beam.dimensionStatus, 'locked');
  assert.equal(beam.sectionDefId, 'WOOD-120x120', '長さ1820・荷重なしの自身の表値。関係のない梁から伝わった成ではない');
});

test('【手動追加】在来木造: 追加梁へ端を乗せる既存の梁は荷重点として数えられる（表値330）が、既存の梁の成は変わらない', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const cl = (t, v) => graph.addCenterLine(t, v, { labeled: true, discipline: Discipline.STRUCT });
  const x0 = cl(CenterLineType.VERTICAL, 0), xm = cl(CenterLineType.VERTICAL, 1820), x1 = cl(CenterLineType.VERTICAL, 3640);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), y1 = cl(CenterLineType.HORIZONTAL, 1820);
  const existing = graph.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, true, y0, y1, { role: 'primary' }); // 始端が追加梁へT
  const beam = addManualBeam(graph, GRID_PROJECT, { axisCL: y0, isVertical: false, clStart: x0, clEnd: x1 });
  assert.equal(beam.sectionDefId, 'WOOD-120x330', '3640・荷重1か所の表値');
  assert.equal(existing.sectionDefId, 'WOOD-120x120', '既存のauto梁は手動追加では書き換えない');
});
