// 手動追加材サイレント撤去回避（dev直下 260929_手動追加材サイレント撤去回避.md）ステップ0→ステップ2。
// 指示書§2.3の5場面を再現する。ステップ1で製品側の「＋追加」（MemberListTab.jsx の handleAdd）が
// structural/manualMemberAdd.js の addManualColumn/addManualFooting/addManualBeam（追加→初期値の
// 自動算定→dimensionStatus:'locked'）へ置き換わったため、本ファイルの手動追加ヘルパーもそれをそのまま
// 呼ぶラッパーにする。場面1〜5は緑になる（手動材が locked になり撤去段の対象から外れるため）。
// 場面2b・3b（固定梁と自動梁の二重生成。指示書§2.5・裁定Q1）はステップ2（fixedBeamOverlap.js）で
// 解消済み。
// フィクスチャはstructural/structuralAutoFill.test.js・structural/woodAutoFill.test.jsのmakeGridGraph・
// addBackingWallと同一構成（コメントも参照）。.jsx/store.js/snap.jsはimportしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { autoFillColumns, autoFillFootings, autoFillBeams, autoFillColumnsForStructure, autoFillRoofBeams } from './structuralAutoFill.js';
import { autoFillWoodWallBeams } from './woodAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { selfWallSegments, autoFillWallBeamAxes } from './wallBeamAxes.js';
import { addManualColumn, addManualFooting, addManualBeam } from './manualMemberAdd.js';
import { beamAxisSpan, spansOverlapOnAxis } from './fixedBeamOverlap.js';

// MemberListTab.jsx の柱「＋追加」と同じ呼び出し（addManualColumn。断面idは純関数側が決める）。
function addManualColumnLikeUi(graph, project, vCL, hCL) {
  return addManualColumn(graph, project, { vCL, hCL });
}

// MemberListTab.jsx の独立基礎・柱脚「＋追加」と同じ呼び出し（addManualFooting）。
function addManualFootingLikeUi(graph, project, kind, vCL, hCL) {
  return addManualFooting(graph, project, { kind, vCL, hCL });
}

// MemberListTab.jsx の梁「＋追加」と同じ呼び出し（addManualBeam。roleは既定'primary'）。
function addManualBeamLikeUi(graph, project, axisCL, isVertical, clStart, clEnd) {
  return addManualBeam(graph, project, { axisCL, isVertical, clStart, clEnd });
}

// 指定の梁と同軸（同じ axisCL・同じ向き）で区間が重なる、role:'primary' かつ auto の梁を列挙する。
// 場面2b・3b（固定梁と自動梁の二重。指示書§2.5・裁定Q1）の検出に使う。区間は clStart/clEnd の value の
// 閉区間どうしの重なり（端点で接するだけは重ならない扱い）で見る。
function overlappingAutoPrimaryBeams(graph, ref) {
  const [rLo, rHi] = [ref.clStart.value, ref.clEnd.value].sort((a, b) => a - b);
  return graph.beams.filter(b =>
    b !== ref && b.role === 'primary' && b.dimensionStatus === 'auto' &&
    b.isVertical === ref.isVertical && b.axisCL === ref.axisCL &&
    Math.min(b.clStart.value, b.clEnd.value) < rHi && Math.max(b.clStart.value, b.clEnd.value) > rLo);
}

// S造グリッド用フィクスチャ（structuralAutoFill.test.jsのmakeGridGraphと同一構成）。
function makeGridGraph(structure, xs = [0, 4000], ys = [0, 4000]) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = structure;
  const xCLs = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  const yCLs = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: true, discipline: Discipline.STRUCT }));
  return { graph, xCLs, yCLs };
}
const GRID_PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };

// woodAutoFill.test.jsのaddBackingWallと同一（下地オーナー壁を1本追加。backingOffset=0）。
function addBackingWall(graph, { axisValue, clStart, clEnd, isVertical }) {
  const axisCL = graph.addCenterLine(
    isVertical ? CenterLineType.VERTICAL : CenterLineType.HORIZONTAL, axisValue, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(axisCL, 0, isVertical, clStart, 0, clEnd, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
}

// ---- 場面1: 通り芯の降格（指示書§2.3 1行目） ----
test('【手動材サイレント撤去・場面1】通り芯X2の降格で、手動固定した手動柱・手動基礎・手動梁は撤去段で消えない', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  const col = addManualColumnLikeUi(graph, GRID_PROJECT, x2, y1);
  const footing = addManualFootingLikeUi(graph, GRID_PROJECT, 'independent', x2, y1);
  const beam = addManualBeamLikeUi(graph, GRID_PROJECT, y1, false, x1, x2);

  runInAction(() => { x2.discipline = Discipline.ARCH; x2.labeled = false; }); // 通り芯→中心線への降格を模す

  autoFillColumns(graph, GRID_PROJECT, null);
  autoFillFootings(graph, null);
  autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  assert.equal(graph.columnMap.has(col.id), true, '手動柱が撤去段で消えてはいけない');
  assert.equal(graph.footingMap.has(footing.id), true, '手動基礎が撤去段で消えてはいけない');
  assert.equal(graph.beamMap.has(beam.id), true, '手動梁が撤去段で消えてはいけない');
});

// ---- 場面2: 通り芯の追加（既存スパンの間）（指示書§2.3 2行目） ----
test('【手動材サイレント撤去・場面2】既存スパンX1〜X2の間にX1.5を追加しても、そのスパンの手動梁は撤去段で消えない', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  const beam = addManualBeamLikeUi(graph, GRID_PROJECT, y1, false, x1, x2);

  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // X1.5を追加

  autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  assert.equal(graph.beamMap.has(beam.id), true, '通り芯追加で候補キーから外れた手動梁が撤去段で消えてはいけない');
});

// ---- 場面3: 操作なし・2スパン以上をまたぐ手動梁（指示書§2.3 3行目） ----
test('【手動材サイレント撤去・場面3】2スパン(X1〜X3)をまたぐ手動梁は、何も操作しなくても最初のautoFillBeamsで消えない', () => {
  const { graph, xCLs: [x1, , x3], yCLs: [y1] } = makeGridGraph('S造', [0, 4000, 8000], [0]);
  const beam = addManualBeamLikeUi(graph, GRID_PROJECT, y1, false, x1, x3);

  autoFillBeams(graph, GRID_PROJECT, 'primary', null); // 操作なし（通り芯の追加・降格を一切していない）

  // computeGridSpansは隣接ペアのみを候補にするため、2スパンをまたぐ手動梁は一度もvalidKeysに
  // 入らないが、locked のため撤去ループの対象外。
  assert.equal(graph.beamMap.has(beam.id), true, '2スパンをまたぐ手動梁が操作なしで消えてはいけない');
});

// ---- 場面2b・3b: 固定梁と重なる自動梁の二重（指示書§2.5・裁定Q1。ステップ2で解消済み） ----
// 場面2・3は「手動梁が残るか」だけを見るため、ステップ1（手動追加を locked に）だけで緑になる。
// 残った固定梁の下に各スパンの auto 梁が二重に生成されないこと（＝ステップ2＝fixedBeamOverlap.js）は、
// ここで別に固定する。
test('【手動材サイレント撤去・場面2b】固定梁X1〜X2の間にX1.5を追加しても、分割後の2区間に auto 梁が二重生成されない', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  const beam = addManualBeamLikeUi(graph, GRID_PROJECT, y1, false, x1, x2);

  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // X1.5を追加
  autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  assert.equal(graph.beamMap.has(beam.id), true, '固定梁は残る（前提）');
  const dup = overlappingAutoPrimaryBeams(graph, beam);
  assert.equal(dup.length, 0, `固定梁と区間が重なる auto 梁が ${dup.length} 本ある（二重生成）`);
});

test('【手動材サイレント撤去・場面3b】2スパン(X1〜X3)をまたぐ固定梁の下に、各スパンの auto 梁が二重生成されない', () => {
  const { graph, xCLs: [x1, , x3], yCLs: [y1] } = makeGridGraph('S造', [0, 4000, 8000], [0]);
  const beam = addManualBeamLikeUi(graph, GRID_PROJECT, y1, false, x1, x3);

  autoFillBeams(graph, GRID_PROJECT, 'primary', null); // 操作なし

  assert.equal(graph.beamMap.has(beam.id), true, '固定梁は残る（前提）');
  const dup = overlappingAutoPrimaryBeams(graph, beam);
  assert.equal(dup.length, 0, `固定梁と区間が重なる auto 梁が ${dup.length} 本ある（二重生成）`);
});

// ---- ステップ2 追加場面(a): 既存auto梁の撤去（貫通スリーブも連鎖削除） ----
test('【固定梁と重なる自動梁・場面a】autoFillBeamsで生成済みのauto梁2本が、固定梁の追加＋再autoFillBeamsで撤去される（スリーブも連鎖削除・除外集合は不変）', () => {
  const { graph, xCLs: [x1, , x3], yCLs: [y1] } = makeGridGraph('S造', [0, 4000, 8000], [0]);
  autoFillBeams(graph, GRID_PROJECT, 'primary', null); // [x1,x2]・[x2,x3] の auto 梁2本が生成される
  const autoBeams = graph.beams.filter(b => b.role === 'primary' && b.dimensionStatus === 'auto');
  assert.equal(autoBeams.length, 2, '前提: auto梁が2本生成されている');
  const sleeve = graph.addSleeve('beam', { hostBeamId: autoBeams[0].id, diameter: 100 });

  const beam = graph.addBeam(StructuralMaterialType.STEEL, 'H-300x150x6.5x9', y1, false, x1, x3, { role: 'primary' });
  beam.setDimensionStatus('locked'); // 2スパンをまたぐ固定梁

  const result = autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  assert.deepEqual(result.removed.sort(), autoBeams.map(b => b.id).sort(), '固定梁と重なるauto梁2本が撤去される');
  for (const b of autoBeams) assert.equal(graph.beamMap.has(b.id), false, 'auto梁が消えている');
  assert.equal(graph.sleeveMap.has(sleeve.id), false, 'auto梁に付いたスリーブも連鎖削除される');
  assert.equal(graph.excludedBeamSlots.size, 0, '除外集合は触らない');
});

// ---- ステップ2 追加場面(b): 固定梁が無ければ不変 ----
test('【固定梁と重なる自動梁・場面b】固定梁が無ければ removed は空・created はスパン数と一致する（不変の保証）', () => {
  const { graph } = makeGridGraph('S造', [0, 4000, 8000], [0, 4000]);
  const result = autoFillBeams(graph, GRID_PROJECT, 'primary', null);
  assert.equal(result.removed.length, 0);
  assert.equal(result.created.length, computeExpectedGridSpanCount([0, 4000, 8000], [0, 4000]));

  // 固定梁が無いauto梁だけのグラフに対する2回目のautoFillBeamsは冪等（何も作らず・何も消さない）。
  // fixedBeamSpansがdimensionStatus==='auto'の梁まで「固定」扱いしてしまう退行が起きると、
  // auto梁が自分自身のスパンと重なり判定されて撤去されてしまう（下の変異相当）。
  const result2 = autoFillBeams(graph, GRID_PROJECT, 'primary', null);
  assert.equal(result2.created.length, 0, '2回目は既存auto梁と同じスパンのため生成されない');
  assert.equal(result2.removed.length, 0, '固定梁が無いのでauto梁は自分自身とも重ならず撤去されない');
});

function computeExpectedGridSpanCount(xs, ys) {
  return ys.length * (xs.length - 1) + xs.length * (ys.length - 1);
}

// ---- ステップ2 追加場面(c): 端点で接するだけのautoは残る ----
test('【固定梁と重なる自動梁・場面c】固定梁の端点で接するだけのauto梁は撤去されない', () => {
  const { graph, xCLs: [x1, x2, x3], yCLs: [y1] } = makeGridGraph('S造', [0, 4000, 8000], [0]);
  autoFillBeams(graph, GRID_PROJECT, 'primary', null); // [x1,x2]・[x2,x3] の auto 梁2本
  const auto12 = graph.beams.find(b => (b.clStart === x1 && b.clEnd === x2) || (b.clStart === x2 && b.clEnd === x1));
  graph.beamMap.delete(graph.beams.find(b => (b.clStart === x2 && b.clEnd === x3) || (b.clStart === x3 && b.clEnd === x2)).id); // [x2,x3]は手動固定に差し替える

  const fixed = graph.addBeam(StructuralMaterialType.STEEL, 'H-300x150x6.5x9', y1, false, x2, x3, { role: 'primary' });
  fixed.setDimensionStatus('locked'); // [x2,x3]（auto12=[x1,x2]とはx2で接するだけ・重ならない）

  const result = autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  assert.equal(graph.beamMap.has(auto12.id), true, '端点で接するだけのauto梁は撤去されない');
  assert.equal(result.removed.includes(auto12.id), false);
});

// ---- ステップ2 追加場面(d): role違いは対象外 ----
test('【固定梁と重なる自動梁・場面d】role違い（固定secondaryと同区間のautoのprimary）は撤去されない', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造', [0, 4000], [0]);
  autoFillBeams(graph, GRID_PROJECT, 'primary', null);
  const autoPrimary = graph.beams.find(b => b.role === 'primary' && b.dimensionStatus === 'auto');
  assert.ok(autoPrimary, '前提: auto primary 梁がある');

  const fixedSecondary = graph.addBeam(StructuralMaterialType.STEEL, 'H-300x150x6.5x9', y1, false, x1, x2, { role: 'secondary' });
  fixedSecondary.setDimensionStatus('locked');

  autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  assert.equal(graph.beamMap.has(autoPrimary.id), true, 'role違いのauto梁は撤去対象外');
});

// ---- ステップ2 追加場面(e): 固定foundationのスパン分割はfoundationのみに影響、primaryは止めない ----
// spanKey は role を見ない（core/structuralEntities.js spanKey）ため、同一spanKeyに別roleの固定梁を
// 置くと「既存」判定（autoFillBeamsのexisting）で衝突し、role絞り込みの効果を確かめられない。
// そのため固定foundation(y1軸)・固定primary(y2軸、別軸・別spanKey)を分けて置く。
test('【固定梁と重なる自動梁・場面e】固定foundationのスパンを割っても二重生成しない。固定primaryはauto foundationを止めない', () => {
  const { graph, xCLs: [x1, , x3], yCLs: [y1, y2] } = makeGridGraph('S造', [0, 4000, 8000], [0, 4000]);
  const fixedFoundation = graph.addBeam(StructuralMaterialType.RC, 'RC-BEAM-1', y1, false, x1, x3, { role: 'foundation' }); // y1軸: [x1,x3]（2スパンをまたぐ）
  fixedFoundation.setDimensionStatus('locked');
  const fixedPrimary = graph.addBeam(StructuralMaterialType.STEEL, 'H-300x150x6.5x9', y2, false, x1, x3, { role: 'primary' }); // y2軸: [x1,x3]（同じ範囲だが別軸・別role）
  fixedPrimary.setDimensionStatus('locked');

  const result = autoFillBeams(graph, GRID_PROJECT, 'foundation', null);

  const createdOnY1 = result.created.filter(b => b.axisCL === y1);
  const createdOnY2 = result.created.filter(b => b.axisCL === y2);
  assert.equal(createdOnY1.length, 0, '固定foundation(y1)と重なる[x1,x2]・[x2,x3]は生成されない');
  assert.equal(createdOnY2.length, 2, '固定primary(y2)は別roleのためauto foundationの生成を止めない');
});

// ---- ステップ2 追加場面(f): autoFillRoofBeams（役割eaves） ----
test('【固定梁と重なる自動梁・場面f】固定eavesのスパンを割ってもautoFillRoofBeamsが二重生成しない', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造', [0, 4000], [0]);
  const fixedEaves = graph.addBeam(StructuralMaterialType.STEEL, 'H-300x150x6.5x9', y1, false, x1, x2, { role: 'eaves' });
  fixedEaves.setDimensionStatus('locked');

  const result = autoFillRoofBeams(graph, GRID_PROJECT, 'S造', null);

  assert.equal(result.created.length, 0, '固定eavesと重なるauto eavesは生成されない');
});

// ---- ステップ2 追加場面(g): 偏芯・柱芯オフセットがあっても座標基準（axisValue）ではなくCL effectiveValueで検出される ----
test('【固定梁と重なる自動梁・場面g】偏芯を持つ固定梁でも、軸CLのeffectiveValue基準で重なりが検出される（axisValue基準への退行防止）', () => {
  const { graph, xCLs: [x1, , x3], yCLs: [y1] } = makeGridGraph('S造', [0, 4000, 8000], [0]);
  const fixed = graph.addBeam(StructuralMaterialType.STEEL, 'H-300x150x6.5x9', y1, false, x1, x3, { role: 'primary', eccentricity: 300 });
  fixed.setDimensionStatus('locked'); // axisValue = y1.effectiveValue + 300 だが、CL自体はy1のまま

  const result = autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  assert.equal(result.created.length, 0, '偏芯があってもCL基準の重なりで生成が止まる');
});

// ---- ステップ2 追加場面(h): addManualBeam（S造）はその場で重なるauto梁を撤去する ----
test('【固定梁と重なる自動梁・場面h】S造でaddManualBeamが既存auto梁の上に追加すると、その場でauto梁が消える', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造', [0, 4000], [0]);
  autoFillBeams(graph, GRID_PROJECT, 'primary', null);
  const autoBeam = graph.beams.find(b => b.role === 'primary' && b.dimensionStatus === 'auto');
  assert.ok(autoBeam, '前提: auto梁がある');

  addManualBeamLikeUi(graph, GRID_PROJECT, y1, false, x1, x2);

  assert.equal(graph.beamMap.has(autoBeam.id), false, '追加のその場でauto梁が撤去される');
});

// ---- ステップ2 追加場面(i): 在来木造の床階ではaddManualBeamがauto primaryを消さない ----
test('【固定梁と重なる自動梁・場面i】在来木造（壁線方式）ではaddManualBeamがauto primaryを消さない', () => {
  const { graph, yCLs: [y0, y1] } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE, [0, 3640], [0, 3640]);
  addBackingWall(graph, { axisValue: 0, clStart: y0, clEnd: y1, isVertical: true });
  const wallSegments = selfWallSegments(graph);
  autoFillWallBeamAxes(graph, wallSegments);
  autoFillWoodWallBeams(graph, GRID_PROJECT, wallSegments);
  const autoBeam = graph.beams.find(b => b.role === 'primary' && b.dimensionStatus === 'auto');
  assert.ok(autoBeam, '前提: 在来木造の壁線方式でauto primaryが生成されている');

  // 手動梁はautoBeamと同じ軸・向き・区間に置く（QA指摘: 縦壁由来のauto梁と横向き手動梁は向きが違い
  // そもそも重ならないため、前の実装は偽の緑だった）。
  const manual = addManualBeam(graph, GRID_PROJECT, {
    axisCL: autoBeam.axisCL, isVertical: autoBeam.isVertical, clStart: autoBeam.clStart, clEnd: autoBeam.clEnd,
  });
  assert.equal(spansOverlapOnAxis(beamAxisSpan(autoBeam), beamAxisSpan(manual)), true, '前提: auto梁と手動梁が軸上で重なっている');

  assert.equal(graph.beamMap.has(autoBeam.id), true, '在来木造は対象外のためauto梁は消えない（次の再計算で往復するため）');
});

// ---- ステップ2 追加場面(j): 重なり無しなら1本だけ増える ----
test('【固定梁と重なる自動梁・場面j】重なりが無ければautoFillBeamsで梁が1本だけ増える', () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造', [0, 4000, 8000], [0]);
  const fixed = graph.addBeam(StructuralMaterialType.STEEL, 'H-300x150x6.5x9', y1, false, x1, x2, { role: 'primary' });
  fixed.setDimensionStatus('locked');

  const before = graph.beams.length;
  const result = autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  assert.equal(result.created.length, 1, '重なりの無い[x2,x3]だけ生成される');
  assert.equal(graph.beams.length, before + 1);
});

// ---- 場面4: 操作なし・在来木造で壁線の候補に無い位置の手動梁（指示書§2.3 4行目） ----
test('【手動材サイレント撤去・場面4】在来木造で壁線の候補に無い位置の手動梁は、何も操作しなくても最初のautoFillWoodWallBeamsで消えない', () => {
  const { graph, xCLs: [x0, x1], yCLs: [y0, y1] } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE, [0, 3640], [0, 3640]);
  addBackingWall(graph, { axisValue: 0, clStart: y0, clEnd: y1, isVertical: true }); // 縦壁 x=0（候補になる位置）
  // 壁の無い位置（y=3640の水平梁）に手動梁を置く——壁線runの候補に含まれない。
  const beam = addManualBeamLikeUi(graph, GRID_PROJECT, y1, false, x0, x1);

  const wallSegments = selfWallSegments(graph);
  autoFillWallBeamAxes(graph, wallSegments);
  autoFillWoodWallBeams(graph, GRID_PROJECT, wallSegments); // 操作なし（壁の追加・削除をしていない）

  assert.equal(graph.beamMap.has(beam.id), true, '壁線の候補に無い手動梁が操作なしで消えてはいけない');
});

// ---- 場面5: 主構造の変更（指示書§2.3 5行目） ----
test('【手動材サイレント撤去・場面5】S造の通り芯交点に置いた手動柱は、主構造を在来木造へ変えて再計算しても消えない', () => {
  // 在来木造は壁交点方式（columnPlacement:'wallIntersections'）へ切り替わり、通り芯グリッド交点は
  // 候補から外れる。在来木造の手動柱はUIがlockedを付ける（壁交点方式）ため、対象外になる組合せ
  // （S造の通り芯交点の手動柱→在来木造へ変更）を選ぶ——指示書§2.3の「主構造の変更」に該当する
  // もう一方の具体例。壁が1本も無い階は既存柱を保全する特例（woodAutoFill.js:250。ユーザー裁定
  // 2026-09-14）があるため、手動柱と無関係な位置に壁を1本置いて撤去ループ自体は走らせる。
  const { graph, xCLs: [x1, x2], yCLs: [y1, y2] } = makeGridGraph('S造');
  const col = addManualColumnLikeUi(graph, GRID_PROJECT, x2, y1);
  addBackingWall(graph, { axisValue: x1.value, clStart: y1, clEnd: y2, isVertical: true }); // 手動柱(x2,y1)とは無関係な壁

  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE; // 主構造の変更

  autoFillColumnsForStructure(graph, GRID_PROJECT, null); // 手動柱の位置(x2,y1)は壁交点ではないため候補に入らない

  assert.equal(graph.columnMap.has(col.id), true, '主構造の変更で候補が入れ替わっても手動柱が消えてはいけない');
});
