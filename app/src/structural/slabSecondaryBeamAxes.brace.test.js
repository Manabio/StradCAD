// ブレースのベイの子梁割付け（S7・2026-10-29）の単体テスト。
// 規則: ブレース指定のベイは、対角線長が上限（丸鋼7000・L型鋼12000）以下になる最小の n で割る。
// 座標はフランジ間のまま（n だけが変わる）。記録のあるベイは n 固定（裁定U1）。
// フィクスチャは 5000×12000 のベイ2つ（x:[0,5000] と x:[5000,10000]、y:[-12000,0]）。
//   デッキ（従来の2500ピッチ）  n=ceil(12000/2500)=5 → 内部4本
//   丸鋼（上限7000）           n=ceil(12000/√(7000²−5000²))=ceil(12000/4899)=3 → 内部2本
//   L型鋼（上限12000）         n=ceil(12000/√(12000²−5000²))=ceil(12000/10909)=2 → 内部1本
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { SlabBayFillSkip, SteelSlabKind, BraceMemberType } from '../core/constants.js';
import {
  reconcileSlabSecondaryBeamAxes, planSlabSecondaryBeamAxes, listSlabBays, slabBeamSlotKey, bayChildDepthMm, bayChildDepthsMm,
} from './slabSecondaryBeamAxes.js';
import { autoFillSecondaryBeams } from './structuralAutoFill.js';
import { rulesFor } from './structureRules.js';
import { findSectionEntry } from './sectionCatalog.js';
import { defaultSteelSlabSpec, normalizeSteelSlabSpec } from './steelSlabSpec.js';
import { steelSlabBraceHeightInfo } from './steelSlabBays.js';

const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const INDIVIDUAL = { mode: 'individual' };
const makeProject = () => ({ planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎', steelSlabSpec: defaultSteelSlabSpec() }, memberGroupLedger: new Map() });

// 幅 widths の連続ベイ（高さ height）。各ベイの4辺を primary 梁で囲む。
function buildBays(widths, height = 12000) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = 'S造';
  const rules = rulesFor('S造');
  const xs = [0]; widths.forEach(w => xs.push(xs[xs.length - 1] + w));
  const xCLs = xs.map(x => graph.addCenterLine(CenterLineType.VERTICAL, x, STRUCT));
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, -height, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const add = (cl, isV, a, b) => graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, cl, isV, a, b, { role: 'primary' });
  for (let i = 0; i < widths.length; i++) { add(y0, false, xCLs[i], xCLs[i + 1]); add(y1, false, xCLs[i], xCLs[i + 1]); }
  xCLs.forEach(x => add(x, true, y0, y1));
  return { graph, xCLs, y0, y1 };
}

const braceSpec = (braceMemberType) => normalizeSteelSlabSpec({ kind: SteelSlabKind.BRACE, braceMemberType }, INDIVIDUAL);
const bayAt = (graph, project, x1) => listSlabBays(graph, project).find(b => b.cell.x1 === x1);
function assignBrace(graph, project, bayKey, spec) {
  return graph.addSlab(StructuralMaterialType.STEEL, null, new Set([bayKey]), { steelSpec: spec });
}
// ベイ（左端の通り芯 leftClId）に属する梁芯の本数。
const axesOfBay = (graph, leftClId) => graph.centerLines.filter(cl => cl.extentLoRef?.clId === leftClId && cl.beamAxisOrigin === BeamAxisOrigin.SLAB_BEAM);

test('【S7】planSlabSecondaryBeamAxes: 4番目の引数なし／null／全ベイ pitch 方針は結果が完全に同一（ブレースが無い階は不変）', () => {
  const lines = [
    ...[0, 5000, 10000].map((c, i) => ({ isVertical: true, coord: c, lo: -12000, hi: 0, id: `v${i}` })),
    { isVertical: false, coord: -12000, lo: 0, hi: 10000, id: 'top' },
    { isVertical: false, coord: 0, lo: 0, hi: 10000, id: 'bottom' },
  ];
  const base = planSlabSecondaryBeamAxes(lines, [], 2500);
  assert.equal(base.length, 2);
  assert.deepEqual(planSlabSecondaryBeamAxes(lines, [], 2500, null), base);
  assert.deepEqual(planSlabSecondaryBeamAxes(lines, [], 2500, () => null), base);
  assert.deepEqual(planSlabSecondaryBeamAxes(lines, [], 2500, () => ({ kind: 'pitch' })), base);
});

test('【S7】planSlabSecondaryBeamAxes: 方針が diagonal のベイだけ n が変わる（デッキ n=5 → 丸鋼 n=3。隣は不変）', () => {
  const lines = [
    ...[0, 5000, 10000].map((c, i) => ({ isVertical: true, coord: c, lo: -12000, hi: 0, id: `v${i}` })),
    { isVertical: false, coord: -12000, lo: 0, hi: 10000, id: 'top' },
    { isVertical: false, coord: 0, lo: 0, hi: 10000, id: 'bottom' },
  ];
  const base = planSlabSecondaryBeamAxes(lines, [], 2500);
  const plan = planSlabSecondaryBeamAxes(lines, [], 2500, c => (c.x1 === 0 ? { kind: 'diagonal', maxDiagonalMm: 7000 } : null));
  assert.equal(base[0].coords.length, 4);
  assert.equal(plan[0].coords.length, 2);
  assert.deepEqual(plan[1], base[1]);
});

test('【S7】reconcile: 丸鋼のベイは n=3（内部2本）、隣のデッキのベイは従来どおり n=5（内部4本）', () => {
  const project = makeProject();
  const { graph, xCLs } = buildBays([5000, 5000]);
  assignBrace(graph, project, bayAt(graph, project, 0).key, braceSpec(BraceMemberType.ROUND_BAR));
  reconcileSlabSecondaryBeamAxes(graph, project);
  assert.equal(axesOfBay(graph, xCLs[0].id).length, 2, '丸鋼 n=3');
  assert.equal(axesOfBay(graph, xCLs[1].id).length, 4, 'デッキ n=5');
});

test('【S7】reconcile: 仕様を 丸鋼→L型鋼→デッキ に替えると再割付けで本数が 2→1→4（同じ呼び出しで収束）', () => {
  const project = makeProject();
  const { graph, xCLs } = buildBays([5000]);
  const slab = assignBrace(graph, project, bayAt(graph, project, 0).key, braceSpec(BraceMemberType.ROUND_BAR));
  reconcileSlabSecondaryBeamAxes(graph, project);
  assert.equal(axesOfBay(graph, xCLs[0].id).length, 2);
  runInAction(() => slab.setSteelSpec(braceSpec(BraceMemberType.ANGLE)));
  reconcileSlabSecondaryBeamAxes(graph, project);
  assert.equal(axesOfBay(graph, xCLs[0].id).length, 1, 'L型鋼 n=2');
  runInAction(() => slab.setSteelSpec(normalizeSteelSlabSpec({ kind: SteelSlabKind.DECK }, INDIVIDUAL)));
  reconcileSlabSecondaryBeamAxes(graph, project);
  assert.equal(axesOfBay(graph, xCLs[0].id).length, 4, 'デッキは 2500 ピッチ規則へ戻る');
});

test('【S7・失敗系】割らなくても対角線長が上限以内のベイは BRACE_NO_DIVISION（デッキなら割るベイでも梁芯を作らない）', () => {
  // 5000×4000: 丸鋼の対角線長 √(4000²+5000²)=6403≤7000。デッキは短辺4000>2500 なので n=2 で割る。
  const deck = buildBays([5000], 4000);
  const dp = makeProject();
  assert.equal(reconcileSlabSecondaryBeamAxes(deck.graph, dp).created.length, 1);
  const brace = buildBays([5000], 4000);
  const project = makeProject();
  assignBrace(brace.graph, project, bayAt(brace.graph, project, 0).key, braceSpec(BraceMemberType.ROUND_BAR));
  const r = reconcileSlabSecondaryBeamAxes(brace.graph, project);
  assert.equal(r.created.length, 0);
  assert.deepEqual(r.skipped.map(s => s.reason), [SlabBayFillSkip.BRACE_NO_DIVISION]);
});

test('【S7・失敗系】短辺が上限以上（7200×20000 の丸鋼）は割付け不能 → 2500 ピッチ規則へ戻す（n=8 → 内部7本）', () => {
  const project = makeProject();
  const { graph, xCLs } = buildBays([7200], 20000);
  assignBrace(graph, project, bayAt(graph, project, 0).key, braceSpec(BraceMemberType.ROUND_BAR));
  reconcileSlabSecondaryBeamAxes(graph, project);
  assert.equal(axesOfBay(graph, xCLs[0].id).length, 7, 'ceil(20000/2500)=8');
});

test('【S7・U1】枠の記録のあるベイは種別が変わっても記録の n に固定（記録 n=5 のベイを丸鋼にしても n=5。記録の1本は作らない）', () => {
  const project = makeProject();
  const { graph, xCLs } = buildBays([5000]);
  const bay = bayAt(graph, project, 0);
  graph.excludedSlabBeamSlots.add(slabBeamSlotKey({ ...bay.ids, dir: CenterLineType.HORIZONTAL, n: 5, i: 2 }));
  assignBrace(graph, project, bay.key, braceSpec(BraceMemberType.ROUND_BAR));
  reconcileSlabSecondaryBeamAxes(graph, project);
  assert.equal(axesOfBay(graph, xCLs[0].id).length, 3, 'n=5 の内部4本から記録の i=2 を除いた3本（丸鋼の自動なら2本）');
});

test('【S7】bayChildDepthMm: 子梁が無ければ主構造の既定の梁断面の成、ベイでないキーは null、子梁があればその最大', () => {
  const project = makeProject();
  const { graph } = buildBays([5000]);
  const key = bayAt(graph, project, 0).key;
  const defaultDepth = findSectionEntry(rulesFor('S造').defaultSections.beam).height;
  assert.equal(bayChildDepthMm(graph, project, key), defaultDepth);
  assert.equal(bayChildDepthMm(graph, project, 'no:such:bay:key'), null);
  // 子梁を生成し、1本だけ成の大きい断面にする（H-300×150 の成は300）。
  reconcileSlabSecondaryBeamAxes(graph, project);
  const children = autoFillSecondaryBeams(graph, project).created;
  assert.ok(children.length >= 2);
  assert.ok(defaultDepth < 300, '前提: 既定の梁成が300未満');
  runInAction(() => { children[0].sectionDefId = 'STEEL-H300x150'; });
  assert.equal(bayChildDepthMm(graph, project, key), 300);
});

test('【S7】steelSlabBraceHeightInfo: 自動（null）は子梁成の1/2、指定が子梁成を超えれば丸め（clamped）、指定が収まれば clamped=false', () => {
  const project = makeProject();
  const { graph } = buildBays([5000]);
  const key = bayAt(graph, project, 0).key;
  const depth = findSectionEntry(rulesFor('S造').defaultSections.beam).height;
  const auto = assignBrace(graph, project, key, braceSpec(BraceMemberType.ROUND_BAR));
  assert.deepEqual(steelSlabBraceHeightInfo(graph, project, auto), { childDepthMm: depth, resolvedMm: depth / 2, clamped: false, exceededBays: 0 });
  runInAction(() => auto.setSteelSpec(normalizeSteelSlabSpec({ kind: SteelSlabKind.BRACE, braceHeightMm: depth + 100 }, INDIVIDUAL)));
  assert.deepEqual(steelSlabBraceHeightInfo(graph, project, auto), { childDepthMm: depth, resolvedMm: depth, clamped: true, exceededBays: 0 });
  runInAction(() => auto.setSteelSpec(normalizeSteelSlabSpec({ kind: SteelSlabKind.BRACE, braceHeightMm: 50 }, INDIVIDUAL)));
  assert.deepEqual(steelSlabBraceHeightInfo(graph, project, auto), { childDepthMm: depth, resolvedMm: 50, clamped: false, exceededBays: 0 });
});

test('【S7・失敗系】steelSlabBraceHeightInfo: ベイが現況に無いスラブは既定の梁成で解決する（例外にしない）', () => {
  const project = makeProject();
  const { graph } = buildBays([5000]);
  const slab = assignBrace(graph, project, 'gone:gone:gone:gone', braceSpec(BraceMemberType.ROUND_BAR));
  const depth = findSectionEntry(rulesFor('S造').defaultSections.beam).height;
  assert.deepEqual(steelSlabBraceHeightInfo(graph, project, slab), { childDepthMm: depth, resolvedMm: depth / 2, clamped: false, exceededBays: 0 });
});

test('【S7・QA】U1 が優先: 記録のあるベイをブレースにして n=1 でも梁芯は撤去されない（3000×6000・記録 n=3 i=1・L型鋼）。対照: 記録が無ければ 0 本・BRACE_NO_DIVISION', () => {
  // 3000×6000: L型鋼の対角線長 √(3000²+6000²)=6708≤12000 → 自動なら n=1（割らない）。デッキは n=ceil(6000/2500)=3。
  const mk = (withRecord) => {
    const project = makeProject();
    const b = buildBays([3000], 6000);
    const bay = bayAt(b.graph, project, 0);
    if (withRecord) b.graph.excludedSlabBeamSlots.add(slabBeamSlotKey({ ...bay.ids, dir: CenterLineType.HORIZONTAL, n: 3, i: 1 }));
    assignBrace(b.graph, project, bay.key, braceSpec(BraceMemberType.ANGLE));
    return { ...b, project };
  };
  const rec = mk(true);
  const r1 = reconcileSlabSecondaryBeamAxes(rec.graph, rec.project);
  assert.equal(axesOfBay(rec.graph, rec.xCLs[0].id).length, 1, '記録 n=3 の内部2本から i=1 を除いた1本');
  assert.ok(!r1.skipped.some(s => s.reason === SlabBayFillSkip.BRACE_NO_DIVISION));
  const ctl = mk(false);
  const r2 = reconcileSlabSecondaryBeamAxes(ctl.graph, ctl.project);
  assert.equal(axesOfBay(ctl.graph, ctl.xCLs[0].id).length, 0);
  assert.deepEqual(r2.skipped.map(s => s.reason), [SlabBayFillSkip.BRACE_NO_DIVISION]);
});

test('【S7・QA】exceededBays: 短辺が上限以上のベイ・U1 で n 固定のため対角線長が上限超過のベイを数える。収まるベイは数えない', () => {
  const project = makeProject();
  // 7200×20000 の丸鋼: 短辺 7200 ≥ 7000 → 2500 ピッチへ戻る（超過）。
  const wide = buildBays([7200], 20000);
  const ws = assignBrace(wide.graph, project, bayAt(wide.graph, project, 0).key, braceSpec(BraceMemberType.ROUND_BAR));
  assert.equal(steelSlabBraceHeightInfo(wide.graph, project, ws).exceededBays, 1);
  // 5000×12000 の丸鋼に記録 n=2 → 6000 ピッチの対角線長 7810>7000（超過）。記録 n=3 なら収まる。
  for (const [n, expected] of [[2, 1], [3, 0]]) {
    const b = buildBays([5000]);
    const bay = bayAt(b.graph, project, 0);
    b.graph.excludedSlabBeamSlots.add(slabBeamSlotKey({ ...bay.ids, dir: CenterLineType.HORIZONTAL, n, i: 1 }));
    const s = assignBrace(b.graph, project, bay.key, braceSpec(BraceMemberType.ROUND_BAR));
    assert.equal(steelSlabBraceHeightInfo(b.graph, project, s).exceededBays, expected, `記録 n=${n}`);
  }
});

test('【S7・QA】bayChildDepthsMm: 複数キーを 1 回で解決し、単体の bayChildDepthMm と一致。現況に無いキーは含めない', () => {
  const project = makeProject();
  const { graph } = buildBays([5000, 5000]);
  const keys = listSlabBays(graph, project).map(b => b.key);
  assert.equal(keys.length, 2);
  const map = bayChildDepthsMm(graph, project, [...keys, 'no:such:bay:key']);
  assert.equal(map.size, 2);
  for (const k of keys) assert.equal(map.get(k), bayChildDepthMm(graph, project, k));
  assert.ok(!map.has('no:such:bay:key'));
});
