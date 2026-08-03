import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType, spanKey } from '../core.js';
import { beamAxisMoveRange, resolveSecondaryBeamsForAxis } from './beamAxisMove.js';
import { DEFAULT_BEAM_SECTION_BY_MATERIAL } from './memberCatalog.js';

// memberTestFixtures.js のダックタイピングでは effectiveValue・gridXs/gridYs・findHostPrimaryBeam 連携の
// 実挙動を再現できないため、本ファイルは実 core.js（Plane/PlanGraph）を使う
// （structural/beamAxisMove.js 自体が @core ではなく相対 import '../core.js' を使う流儀に揃える）。

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

test('beamAxisMoveRange: 両隣の障害物（通り芯・他の梁芯）の内側へ CL_OVERLAP_TOL_MM だけ内寄せする', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.VERTICAL, 10000,  { labeled: true, discipline: Discipline.STRUCT });
  const a = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  const b = graph.addCenterLine(CenterLineType.VERTICAL, 6000, { labeled: false, discipline: Discipline.FUSE });

  const rangeA = beamAxisMoveRange(graph, a);
  assert.equal(rangeA.min, 0.5);
  assert.equal(rangeA.max, 5999.5); // 隣の梁芯 b(6000) が障害物になる

  const rangeB = beamAxisMoveRange(graph, b);
  assert.equal(rangeB.min, 3000.5); // 隣の梁芯 a(3000) が障害物になる
  assert.equal(rangeB.max, 9999.5);
});

test('beamAxisMoveRange: 片側に障害物が無ければ Infinity', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 8000, { labeled: false, discipline: Discipline.FUSE });
  const range = beamAxisMoveRange(graph, cl);
  assert.equal(range.min, 5000.5);
  assert.equal(range.max, Infinity);
});

// ---- resolveSecondaryBeamsForAxis 共通セットアップ ----
// 縦グリッド X0=0, X5000=5000, X10000=10000 / 横グリッド Y1=0, Y2=4000, Y3=8000。
// 大梁(role:'primary')は Y1・Y2 が全幅(X0~X10000)、Y3 は右半分(X5000~X10000)だけをカバーする。
// 梁芯CL（垂直、extentLo=0/Hi=8000）を X=2000（Y3非host）→X=6000（Y3がhostになる）へ動かすと
// host が Y1,Y2(2本) → Y1,Y2,Y3(3本) に増え、区間が1→2に増える（host出現・本数再構成）。
function setupHostGainFixture() {
  const graph = makeGraph();
  const x0     = graph.addCenterLine(CenterLineType.VERTICAL, 0,     { labeled: true, discipline: Discipline.STRUCT });
  const x5000  = graph.addCenterLine(CenterLineType.VERTICAL, 5000,  { labeled: true, discipline: Discipline.STRUCT }); // 大梁Y3の始端
  const x10000 = graph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y3 = graph.addCenterLine(CenterLineType.HORIZONTAL, 8000, { labeled: true, discipline: Discipline.STRUCT });

  const sec = DEFAULT_BEAM_SECTION_BY_MATERIAL[StructuralMaterialType.STEEL];
  graph.addBeam(StructuralMaterialType.STEEL, sec, y1, false, x0, x10000, { role: 'primary' });
  graph.addBeam(StructuralMaterialType.STEEL, sec, y2, false, x0, x10000, { role: 'primary' });
  graph.addBeam(StructuralMaterialType.STEEL, sec, y3, false, x5000, x10000, { role: 'primary' });

  const beamAxisCL = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 8000,
  });
  const project = { structuralInfo: { mainStructure: 'S造' } };
  return { graph, beamAxisCL, project, y1, y2, y3 };
}

test('resolveSecondaryBeamsForAxis: host不足時は既定材料・断面で新規小梁を生成する（本数0→1）', () => {
  const { graph, beamAxisCL, project } = setupHostGainFixture();
  const result = resolveSecondaryBeamsForAxis(graph, beamAxisCL, project);
  assert.deepEqual(result, { before: 0, after: 1 });

  const secondaries = graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === beamAxisCL.id);
  assert.equal(secondaries.length, 1);
  assert.equal(secondaries[0].materialType, StructuralMaterialType.STEEL);
  assert.equal(secondaries[0].sectionDefId, DEFAULT_BEAM_SECTION_BY_MATERIAL[StructuralMaterialType.STEEL]);
});

test('resolveSecondaryBeamsForAxis: host出現で本数が増え、既存の対応区間は張り替え（id・断面・グループ維持）、新規は既存小梁の材寸を継承する', () => {
  const { graph, beamAxisCL, project, y1, y2, y3 } = setupHostGainFixture();

  // 初回解決（value=2000, host=Y1,Y2 の2本→1区間）。カスタム材寸・番号グループ・寸法状態を付与する。
  resolveSecondaryBeamsForAxis(graph, beamAxisCL, project);
  const original = graph.beams.find(b => b.role === 'secondary' && b.axisCL.id === beamAxisCL.id);
  const originalId = original.id;
  original.setField('sectionDefId', 'STEEL-H300x150');
  original.setField('numberGroupId', 'B#1');
  original.setField('dimensionStatus', 'locked');

  // Y3 がhostになる位置へ移動（beamAxisMoveの確定処理が行うのと同じ: value直接更新）。
  beamAxisCL.value = 6000;
  const result = resolveSecondaryBeamsForAxis(graph, beamAxisCL, project);
  assert.deepEqual(result, { before: 1, after: 2 });

  const secondaries = graph.beams
    .filter(b => b.role === 'secondary' && b.axisCL.id === beamAxisCL.id)
    .sort((a, b) => Math.min(a.clStart.effectiveValue, a.clEnd.effectiveValue) - Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue));
  assert.equal(secondaries.length, 2);

  // 既存区間（Y1-Y2）: id・断面・番号グループ・寸法状態を維持したまま張り替えられる（削除→再生成ではない）
  const kept = secondaries.find(b => b.id === originalId);
  assert.ok(kept, '既存の小梁が削除→再生成されず維持されているはず');
  assert.equal(kept.sectionDefId, 'STEEL-H300x150');
  assert.equal(kept.numberGroupId, 'B#1');
  assert.equal(kept.dimensionStatus, 'locked');
  assert.equal(kept.clStart.id, y1.id);
  assert.equal(kept.clEnd.id, y2.id);

  // 新規区間（Y2-Y3）: 同一CL上の既存小梁からsectionDefIdを継承する（既定値ではない）
  const added = secondaries.find(b => b.id !== originalId);
  assert.ok(added);
  assert.equal(added.sectionDefId, 'STEEL-H300x150');
  assert.equal(added.clStart.id, y2.id);
  assert.equal(added.clEnd.id, y3.id);
});

test('resolveSecondaryBeamsForAxis: host喪失で余剰小梁を削除する（graph.removeBeamは使わずexcludedBeamSlotsを汚さない）', () => {
  const { graph, beamAxisCL, project } = setupHostGainFixture();

  beamAxisCL.value = 6000; // host=Y1,Y2,Y3（2区間）
  resolveSecondaryBeamsForAxis(graph, beamAxisCL, project);
  assert.equal(graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === beamAxisCL.id).length, 2);

  beamAxisCL.value = 2000; // host=Y1,Y2のみ（1区間）に戻す
  const result = resolveSecondaryBeamsForAxis(graph, beamAxisCL, project);
  assert.deepEqual(result, { before: 2, after: 1 });
  assert.equal(graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === beamAxisCL.id).length, 1);

  // graph.removeBeam を使っていれば excludedBeamSlots に削除したスパンが記録されるはず——
  // 張り替え方式（beamMap.delete直接）ではそれが起きない（自動再解決を手動削除として誤記録しない）。
  assert.equal(graph.excludedBeamSlots.size, 0, '局所再解決による削除はexcludedBeamSlotsを汚してはいけない');
});

test('resolveSecondaryBeamsForAxis: host喪失で消える小梁の子スリーブだけ連鎖削除され、残る小梁のスリーブは残る', () => {
  const { graph, beamAxisCL, project } = setupHostGainFixture();

  beamAxisCL.value = 6000; // host=Y1,Y2,Y3（2区間: Y1-Y2 と Y2-Y3）
  resolveSecondaryBeamsForAxis(graph, beamAxisCL, project);
  const [kept, surplus] = graph.beams
    .filter(b => b.role === 'secondary' && b.axisCL.id === beamAxisCL.id)
    .sort((a, b) => Math.min(a.clStart.effectiveValue, a.clEnd.effectiveValue) - Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue));
  // 位置順（olds のソートと同じ）: 先頭(Y1-Y2)が張り替えで残る側、末尾(Y2-Y3)が2000へ戻すと消える側。
  const keptSleeve = graph.addSleeve('beam', { hostBeamId: kept.id });
  const surplusSleeve = graph.addSleeve('beam', { hostBeamId: surplus.id });
  assert.equal(graph.sleeveMap.size, 2);

  beamAxisCL.value = 2000; // host=Y1,Y2のみに戻す → surplus(Y2-Y3)が削除される
  const result = resolveSecondaryBeamsForAxis(graph, beamAxisCL, project);
  assert.deepEqual(result, { before: 2, after: 1 });

  assert.equal(graph.sleeveMap.has(surplusSleeve.id), false, '削除された小梁の子スリーブは連鎖削除されるはず');
  assert.equal(graph.sleeveMap.has(keptSleeve.id), true, '張り替えで残った小梁の子スリーブは削除されてはいけない');
  assert.equal(graph.sleeveMap.size, 1);
});

test('resolveSecondaryBeamsForAxis: excludedBeamSlots にあるスロットは host があっても再生成しない（手動削除の尊重）', () => {
  const { graph, beamAxisCL, project, y2, y3 } = setupHostGainFixture();

  beamAxisCL.value = 6000; // host=Y1,Y2,Y3（本来2区間: Y1-Y2, Y2-Y3）
  graph.excludedBeamSlots.add(spanKey(beamAxisCL, y2, y3));

  const result = resolveSecondaryBeamsForAxis(graph, beamAxisCL, project);
  assert.deepEqual(result, { before: 0, after: 1 }, 'Y2-Y3は除外集合にあるため生成されず1区間のまま');
  const secondaries = graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === beamAxisCL.id);
  assert.equal(secondaries.length, 1);
  assert.equal(secondaries[0].clEnd.id, y2.id);
});

test('resolveSecondaryBeamsForAxis: 変化が無ければno-op（回数呼んでも本数・idが安定する）', () => {
  const { graph, beamAxisCL, project } = setupHostGainFixture();
  resolveSecondaryBeamsForAxis(graph, beamAxisCL, project);
  const idBefore = graph.beams.find(b => b.role === 'secondary').id;

  const result = resolveSecondaryBeamsForAxis(graph, beamAxisCL, project); // 位置据え置きで再度呼ぶ
  assert.deepEqual(result, { before: 1, after: 1 });
  const secondaries = graph.beams.filter(b => b.role === 'secondary' && b.axisCL.id === beamAxisCL.id);
  assert.equal(secondaries.length, 1);
  assert.equal(secondaries[0].id, idBefore);
});
