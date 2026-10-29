// ブレースの×（braceCrossSegments・S8・2026-10-29）の単体テスト。
// フィクスチャは slabSecondaryBeamAxes.brace.test.js と同じ 5000×12000 のベイ（丸鋼 n=3 → 子梁の梁芯 2 本 → 小区画 3）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autorun, runInAction } from 'mobx';
import { StructuralInfo } from '../core/structuralInfo.js';
import { graphComputed } from '../renderer/graphDerived.js';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { SteelSlabKind, BraceMemberType } from '../core/constants.js';
import { reconcileSlabSecondaryBeamAxes, listSlabBays } from './slabSecondaryBeamAxes.js';
import { autoFillSecondaryBeams } from './structuralAutoFill.js';
import { rulesFor } from './structureRules.js';
import { defaultSteelSlabSpec, normalizeSteelSlabSpec } from './steelSlabSpec.js';
import { braceCrossSegments } from './braceFigure.js';

const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const INDIVIDUAL = { mode: 'individual' };
const makeProject = () => ({ planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎', steelSlabSpec: defaultSteelSlabSpec() }, memberGroupLedger: new Map() });

// 幅 w・高さ h の 1 ベイ（x:[0,w]、y:[-h,0]）。4 辺を primary 梁で囲む。
function buildBay(w, h, structure = 'S造') {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const rules = rulesFor(structure);
  const xCLs = [0, w].map(x => graph.addCenterLine(CenterLineType.VERTICAL, x, STRUCT));
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, -h, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const add = (cl, isV, a, b) => graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, cl, isV, a, b, { role: 'primary' });
  add(y0, false, xCLs[0], xCLs[1]); add(y1, false, xCLs[0], xCLs[1]);
  xCLs.forEach(x => add(x, true, y0, y1));
  return graph;
}

const braceSpec = (braceMemberType) => normalizeSteelSlabSpec({ kind: SteelSlabKind.BRACE, braceMemberType }, INDIVIDUAL);
const assign = (graph, project, spec) =>
  graph.addSlab(StructuralMaterialType.STEEL, null, new Set([listSlabBays(graph, project)[0].key]), { steelSpec: spec });
const slabAxisValues = (graph, type) =>
  graph.centerLines.filter(cl => cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM && cl.centerLineType === type)
    .map(cl => cl.value).sort((a, b) => a - b);
// 子梁（SECONDARY）まで生成した状態にする（bayChildAxisCoords は梁を読む）。
function settle(graph, project) {
  reconcileSlabSecondaryBeamAxes(graph, project);
  autoFillSecondaryBeams(graph, project);
}

test('【S8】丸鋼の縦長ベイ（5000×12000）: 子梁の梁芯 2 本で小区画 3 → 対角線 6 本（座標は梁芯の値）', () => {
  const project = makeProject();
  const graph = buildBay(5000, 12000);
  assign(graph, project, braceSpec(BraceMemberType.ROUND_BAR));
  settle(graph, project);
  const ys = slabAxisValues(graph, CenterLineType.HORIZONTAL);
  assert.equal(ys.length, 2);
  const cuts = [-12000, ...ys, 0];
  const expected = [];
  for (let i = 0; i < 3; i++) {
    expected.push({ x1: 0, y1: cuts[i], x2: 5000, y2: cuts[i + 1] });
    expected.push({ x1: 0, y1: cuts[i + 1], x2: 5000, y2: cuts[i] });
  }
  assert.deepEqual(braceCrossSegments(graph, project), expected);
});

test('【S8】横長ベイ（12000×5000）: 分割線は x 座標（縦の梁芯）で小区画 3 → 対角線 6 本', () => {
  const project = makeProject();
  const graph = buildBay(12000, 5000);
  assign(graph, project, braceSpec(BraceMemberType.ROUND_BAR));
  settle(graph, project);
  const xs = slabAxisValues(graph, CenterLineType.VERTICAL).filter(x => x !== 0 && x !== 12000);
  assert.equal(xs.length, 2);
  const segs = braceCrossSegments(graph, project);
  assert.equal(segs.length, 6);
  const cuts = [0, ...xs, 12000];
  assert.deepEqual(segs[0], { x1: cuts[0], y1: -5000, x2: cuts[1], y2: 0 });
  assert.deepEqual(segs[1], { x1: cuts[0], y1: 0, x2: cuts[1], y2: -5000 });
  assert.deepEqual(segs[5], { x1: cuts[2], y1: 0, x2: cuts[3], y2: -5000 });
});

test('【S8】子梁がまだ無い（梁芯の再計算前）ブレースのベイは 1 小区画＝対角線 2 本', () => {
  const project = makeProject();
  const graph = buildBay(5000, 12000);
  assign(graph, project, braceSpec(BraceMemberType.ROUND_BAR));
  assert.deepEqual(braceCrossSegments(graph, project), [
    { x1: 0, y1: -12000, x2: 5000, y2: 0 },
    { x1: 0, y1: 0, x2: 5000, y2: -12000 },
  ]);
});

test('【S8】固定キーの graphComputed＋autorun: 共通仕様・割り直し・個別仕様の変化ごとに本数が変わる（キーに仕様を入れなくても追跡される）', () => {
  const info = new StructuralInfo();
  const project = { planes: [], structuralInfo: info, memberGroupLedger: new Map() };
  const graph = buildBay(5000, 12000);
  const slab = graph.addSlab(StructuralMaterialType.STEEL, null, new Set([listSlabBays(graph, project)[0].key]), {});
  let count = -1;
  const dispose = autorun(() => { count = graphComputed(graph, 'braceCross', () => braceCrossSegments(graph, project)).length; });
  try {
    assert.equal(count, 0, '共通仕様が既定（ブレースでない）なら 0');
    runInAction(() => info.setSteelSlabSpec({ kind: SteelSlabKind.BRACE, braceMemberType: BraceMemberType.ROUND_BAR }));
    assert.equal(count, 2, '共通仕様をブレースにすると 1 小区画＝2 本');
    runInAction(() => settle(graph, project));
    assert.equal(count, 6, '割り直しで子梁の梁芯が 2 本できると 3 小区画＝6 本');
    runInAction(() => slab.setSteelSpec(normalizeSteelSlabSpec({ kind: SteelSlabKind.DECK }, INDIVIDUAL)));
    assert.equal(count, 0, '個別仕様がデッキなら共通がブレースでも 0');
  } finally { dispose(); }
});

test('【S8・失敗系】ブレースでないスラブ（デッキ）・スラブ無し・S造でない階は線分 0', () => {
  const project = makeProject();
  const deck = buildBay(5000, 12000);
  assign(deck, project, normalizeSteelSlabSpec({ kind: SteelSlabKind.DECK }, INDIVIDUAL));
  settle(deck, project);
  assert.deepEqual(braceCrossSegments(deck, project), []);

  const none = buildBay(5000, 12000);
  settle(none, project);
  assert.deepEqual(braceCrossSegments(none, project), []);

  const rc = buildBay(5000, 12000, 'RC造');
  assert.deepEqual(braceCrossSegments(rc, project), [], 'S造でない階は早期に空（ベイを計算しない）');
  assert.deepEqual(braceCrossSegments(null, project), []);
});
