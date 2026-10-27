// autoFillSecondaryBeams の撤去段（別課題 k4。prune）の単体・統合テスト。
// host 連続ペアの spanKey に無い auto の小梁（同じ梁芯）を、生成の直前に撤去する。
// 重なって残る古い全長の小梁・host を失った小梁を残さない／locked・calculated・excludedBeamSlots・在来木造・prune 無しの呼び出しは触らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { autoFillSecondaryBeams, autoFillStructuralGrid } from './structuralAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';

const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
const GRID = { labeled: true, discipline: Discipline.STRUCT };
const FUSE = { labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.USER };

// 通り芯 X: 0・4000・8000／Y: 0・6000。横の梁芯 y=3000（範囲 0〜8000）。直交の大梁（primary）は引数の x にだけ置く。
function makeScene({ structure = 'S造', primaryXs = [0, 8000] } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const rules = rulesFor(structure);
  const xs = [0, 4000, 8000].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, GRID));
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, GRID);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 6000, GRID);
  const axis = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { ...FUSE, extentLo: 0, extentHi: 8000 });
  const primaries = new Map();
  const addPrimary = (x) => {
    const b = graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, x, true, y0, y1, { role: 'primary' });
    primaries.set(x.value, b);
    return b;
  };
  for (const x of xs) if (primaryXs.includes(x.value)) addPrimary(x);
  return { graph, xs, axis, addPrimary, primaries, rules };
}
const secondariesOf = (graph, axis) => graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === axis.id);
const spansOf = (graph, axis) => secondariesOf(graph, axis)
  .map(b => [b.clStart.effectiveValue, b.clEnd.effectiveValue].sort((a, c) => a - c)).sort((a, b) => a[0] - b[0]);
const overlaps = (spans) => spans.some((s, i) => i > 0 && s[0] < spans[i - 1][1] - 1);
const addSecondary = (scene, a, b) =>
  scene.graph.addBeam(scene.rules.baseMaterial, scene.rules.defaultSections.beam, scene.axis, false, a, b, { role: 'secondary' });

test('【k4・受け入れ】途中に大梁が入ると、再計算（prune）で全長の古い小梁が撤去され、分割した小梁だけが残る（重なり0）。繰り返しても不変（冪等）', () => {
  const sc = makeScene();
  const first = autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.equal(first.created.length, 1, '前提: host が両端の2本だけなので全長の小梁1本');
  const stale = first.created[0];
  assert.deepEqual(spansOf(sc.graph, sc.axis), [[0, 8000]]);

  sc.addPrimary(sc.xs[1]); // 梁芯の範囲の途中に大梁が入った
  const r = autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.deepEqual(r.removed, [stale.id], '全長の古い小梁だけが撤去される');
  assert.equal(r.created.length, 2);
  assert.equal(sc.graph.beamMap.has(stale.id), false);
  const spans = spansOf(sc.graph, sc.axis);
  assert.deepEqual(spans, [[0, 4000], [4000, 8000]]);
  assert.equal(overlaps(spans), false, '重なり0');

  const ids = sc.graph.beams.map(b => b.id).sort();
  const again = autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.equal(again.created.length + again.removed.length, 0, '2回目は変化なし（冪等）');
  assert.deepEqual(sc.graph.beams.map(b => b.id).sort(), ids, '梁の id も不変');
});

test('【k4・受け入れ・対照】prune を渡さない呼び出し（梁芯の追加 centerLineOps）では撤去しない＝古い全長の小梁が残って重なる', () => {
  const sc = makeScene();
  autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  sc.addPrimary(sc.xs[1]);
  const r = autoFillSecondaryBeams(sc.graph, PROJECT);
  assert.deepEqual(r.removed, [], 'prune 無しでは撤去しない');
  assert.equal(overlaps(spansOf(sc.graph, sc.axis)), true, '従来どおり古い全長の小梁が残り、分割した小梁と重なる');
});

test('【k4・受け入れ】通り芯の移動で host の並びが変わった型（途中の通り芯が梁芯の範囲の外へ出る）でも、重なりが残らない', () => {
  const sc = makeScene({ primaryXs: [0, 4000, 8000] });
  autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.deepEqual(spansOf(sc.graph, sc.axis), [[0, 4000], [4000, 8000]]);

  runInAction(() => { sc.xs[1].value = 9000; }); // 中間の通り芯が範囲（〜8000）の外へ出て、host は両端の2本だけになる
  const r = autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.equal(r.removed.length, 2, '合わなくなった分割の小梁2本が撤去される');
  assert.equal(r.created.length, 1);
  const spans = spansOf(sc.graph, sc.axis);
  assert.deepEqual(spans, [[0, 8000]]);
  assert.equal(overlaps(spans), false);
});

test('【k4・保護】locked／calculated の小梁は host の区間に合わなくても残る。excludedBeamSlots は撤去で増えない', () => {
  const sc = makeScene({ primaryXs: [0, 4000, 8000] });
  const locked = addSecondary(sc, sc.xs[0], sc.xs[2]);
  locked.setDimensionStatus('locked');
  const calculated = addSecondary(sc, sc.xs[0], sc.xs[2]);
  calculated.setDimensionStatus('calculated');
  const auto = addSecondary(sc, sc.xs[0], sc.xs[2]); // 同じ区間だが auto ＝ 合わない区間
  const excludedBefore = [...sc.graph.excludedBeamSlots];

  const r = autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.equal(sc.graph.beamMap.has(locked.id), true, 'locked は残る');
  assert.equal(sc.graph.beamMap.has(calculated.id), true, 'calculated は残る');
  assert.equal(sc.graph.beamMap.has(auto.id), false, 'auto は撤去');
  assert.deepEqual(r.removed, [auto.id]);
  assert.deepEqual([...sc.graph.excludedBeamSlots], excludedBefore, '撤去は除外スロットを記録しない（再生成を妨げない）');
  assert.equal(r.created.length, 2, '撤去した後も正しい区間は生成される');
});

test('【k4・保護】撤去した小梁のスリーブは道連れで消え、残す小梁（host の区間に合う・別の梁芯の小梁）とそのスリーブ・primary は触らない', () => {
  const sc = makeScene({ primaryXs: [0, 4000, 8000] });
  const other = sc.graph.addCenterLine(CenterLineType.HORIZONTAL, 5000, { ...FUSE, extentLo: 0, extentHi: 4000 });
  const keep = sc.graph.addBeam(sc.rules.baseMaterial, sc.rules.defaultSections.beam, other, false, sc.xs[0], sc.xs[1], { role: 'secondary' });
  const stale = addSecondary(sc, sc.xs[0], sc.xs[2]);
  const mkSleeve = (b) => sc.graph.addSleeve('beam', { hostBeamId: b.id, hostAxisCL: b.axisCL, hostClStart: b.clStart, hostClEnd: b.clEnd });
  const staleSleeve = mkSleeve(stale), keepSleeve = mkSleeve(keep);

  const r = autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.equal(r.removed.includes(stale.id), true);
  assert.equal(r.removed.includes(keep.id), false, '区間に合う別の梁芯の小梁は残る');
  assert.equal(sc.graph.sleeveMap.has(staleSleeve.id), false, '撤去した小梁のスリーブは道連れ');
  assert.equal(sc.graph.sleeveMap.has(keepSleeve.id), true);
  assert.equal(sc.graph.beams.filter(b => b.role === 'primary').length, 3, 'primary は触らない');
});

test('【k4・失敗系】host が無くなった梁芯の auto 小梁は撤去される（宙に浮いた小梁を残さない）', () => {
  const sc = makeScene();
  const { created } = autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.equal(created.length, 1);
  for (const b of [...sc.primaries.values()]) sc.graph.beamMap.delete(b.id); // 支えの大梁が全て無くなった

  const r = autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.deepEqual(r.removed, [created[0].id]);
  assert.equal(r.created.length, 0);
  assert.equal(secondariesOf(sc.graph, sc.axis).length, 0);
  assert.equal(sc.graph.excludedBeamSlots.size, 0, '除外スロットは増えない');
});

test('【k4・失敗系】主構造が未定の階では prune を渡しても何も撤去・生成しない（空の結果を返す）', () => {
  const sc = makeScene();
  const stale = addSecondary(sc, sc.xs[0], sc.xs[2]);
  sc.graph.structureOverride = null; // 階の上書きなし＋建物全体も未定
  const r = autoFillSecondaryBeams(sc.graph, PROJECT, { prune: true });
  assert.deepEqual(r, { created: [], removed: [] }, '主構造未定は何もしない');
  assert.equal(sc.graph.beamMap.has(stale.id), true);
});

test('【k4・在来木造】autoFillStructuralGrid は在来木造（wallRuns）の階で prune しない: host の無い梁芯の auto 小梁が再計算で消えない', () => {
  const sc = makeScene({ structure: TRADITIONAL_WOOD_STRUCTURE, primaryXs: [] });
  const wood = addSecondary(sc, sc.xs[0], sc.xs[2]); // 在来木造の小梁（吹抜けの辺など）に見立てた auto の小梁。host の大梁は無い
  const r = autoFillStructuralGrid(sc.graph, PROJECT, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(sc.graph.beamMap.has(wood.id), true, '在来木造では撤去段が走らない');
  assert.equal(r.removedBeams.includes(wood.id), false);
});

test('【k4・配線】autoFillStructuralGrid（S造）の再計算で撤去した小梁の id が removedBeams に載る', () => {
  const sc = makeScene({ primaryXs: [0, 4000, 8000] });
  const stale = addSecondary(sc, sc.xs[0], sc.xs[2]);
  const r = autoFillStructuralGrid(sc.graph, PROJECT, 'S造');
  assert.equal(r.removedBeams.includes(stale.id), true);
  assert.equal(sc.graph.beamMap.has(stale.id), false);
});
