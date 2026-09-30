// 手動追加材サイレント撤去回避（dev直下 260929_手動追加材サイレント撤去回避.md）ステップ0。
// 指示書§2.3の5場面を再現し、「手動追加した構造材が黙って消える」現状を失敗するテストとして固定する。
// 本ファイルの手動追加ヘルパー（addManualColumnLikeUi/addManualFootingLikeUi/addManualBeamLikeUi）は
// structural/MemberListTab.jsx:1697-1759の「＋追加」呼び出しと同じく props={}（dimensionStatus が既定の
// 'auto' になる点）で構造材を作るラッパーにすぎない。断面 id と追加後の初期値算定（autoFillColumnSizes 等）は
// 撤去段の判定に関与しないため省く——ステップ1（本指示書§5）で製品側が dimensionStatus:'locked' を渡す
// 純関数に置き換わったら、このファイルの呼び出しもそれに合わせて更新する想定。
// フィクスチャはstructural/structuralAutoFill.test.js・structural/woodAutoFill.test.jsのmakeGridGraph・
// addBackingWallと同一構成（コメントも参照）。.jsx/store.js/snap.jsはimportしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { autoFillColumns, autoFillFootings, autoFillBeams, autoFillColumnsForStructure } from './structuralAutoFill.js';
import { autoFillWoodWallBeams } from './woodAutoFill.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { selfWallSegments, autoFillWallBeamAxes } from './wallBeamAxes.js';

// TODOメッセージ（指示書§5ステップ1/2で解消予定）を一箇所にまとめる。
const TODO_MSG = 'ステップ1/2で解消予定（手動追加材サイレント撤去回避）';

// MemberListTab.jsx:1697-1700（柱）と同じ呼び出し。propsは{}のまま——現状はdimensionStatusが
// 'auto'のままになる（ステップ1で'locked'化される予定の箇所）。
function addManualColumnLikeUi(graph, materialType, sectionDefId, vCL, hCL) {
  return graph.addColumn(materialType, sectionDefId, vCL, hCL, {});
}

// MemberListTab.jsx:1705（独立基礎・柱脚）と同じ呼び出し。
function addManualFootingLikeUi(graph, kind, sectionDefId, vCL, hCL, materialType) {
  return graph.addFooting(kind, sectionDefId, vCL, hCL, { materialType });
}

// MemberListTab.jsx:1759（梁）と同じ呼び出し。roleは既定'primary'。
function addManualBeamLikeUi(graph, materialType, sectionDefId, axisCL, isVertical, clStart, clEnd) {
  return graph.addBeam(materialType, sectionDefId, axisCL, isVertical, clStart, clEnd, {});
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
test('【手動材サイレント撤去・場面1】通り芯X2の降格で、手動固定していない手動柱・手動基礎・手動梁が撤去段で消える', { todo: TODO_MSG }, () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  const col = addManualColumnLikeUi(graph, StructuralMaterialType.STEEL, 'S-C-400x400', x2, y1);
  const footing = addManualFootingLikeUi(graph, 'independent', 'RC-FT-1000', x2, y1, StructuralMaterialType.RC);
  const beam = addManualBeamLikeUi(graph, StructuralMaterialType.STEEL, 'S-H-300x150', y1, false, x1, x2);

  runInAction(() => { x2.discipline = Discipline.ARCH; x2.labeled = false; }); // 通り芯→中心線への降格を模す

  autoFillColumns(graph, GRID_PROJECT, null);
  autoFillFootings(graph, null);
  autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  // 実測（現状）: 3件とも撤去される（columnMap/footingMap/beamMapから消える）。
  assert.equal(graph.columnMap.has(col.id), true, '手動柱が撤去段で消えてはいけない');
  assert.equal(graph.footingMap.has(footing.id), true, '手動基礎が撤去段で消えてはいけない');
  assert.equal(graph.beamMap.has(beam.id), true, '手動梁が撤去段で消えてはいけない');
});

// ---- 場面2: 通り芯の追加（既存スパンの間）（指示書§2.3 2行目） ----
test('【手動材サイレント撤去・場面2】既存スパンX1〜X2の間にX1.5を追加すると、そのスパンの手動梁が撤去段で消える', { todo: TODO_MSG }, () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  const beam = addManualBeamLikeUi(graph, StructuralMaterialType.STEEL, 'S-H-300x150', y1, false, x1, x2);

  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // X1.5を追加

  autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  // 実測（現状）: スパンが分割され、X1〜X2の通し手動梁は候補キーから外れて撤去される。
  assert.equal(graph.beamMap.has(beam.id), true, '通り芯追加で候補キーから外れた手動梁が撤去段で消えてはいけない');
});

// ---- 場面3: 操作なし・2スパン以上をまたぐ手動梁（指示書§2.3 3行目） ----
test('【手動材サイレント撤去・場面3】2スパン(X1〜X3)をまたぐ手動梁は、何も操作しなくても最初のautoFillBeamsで消える', { todo: TODO_MSG }, () => {
  const { graph, xCLs: [x1, , x3], yCLs: [y1] } = makeGridGraph('S造', [0, 4000, 8000], [0]);
  const beam = addManualBeamLikeUi(graph, StructuralMaterialType.STEEL, 'S-H-300x150', y1, false, x1, x3);

  autoFillBeams(graph, GRID_PROJECT, 'primary', null); // 操作なし（通り芯の追加・降格を一切していない）

  // 実測（現状）: computeGridSpansは隣接ペアのみを候補にするため、2スパンをまたぐ手動梁は
  // 一度もvalidKeysに入らず、最初の呼び出しで即撤去される。
  assert.equal(graph.beamMap.has(beam.id), true, '2スパンをまたぐ手動梁が操作なしで消えてはいけない');
});

// ---- 場面2b・3b: 固定梁と重なる自動梁の二重（指示書§2.5・裁定Q1。ステップ2で解消） ----
// 場面2・3は「手動梁が残るか」だけを見るため、ステップ1（手動追加を locked に）だけで緑になる。
// 残った固定梁の下に各スパンの auto 梁が二重に生成されない（＝ステップ2）ことは、ここで別に固定する。
// 固定梁は setDimensionStatus('locked') で明示的に作る（ステップ1後の手動追加、および現状でも数値欄の
// 編集後の手動材と同じ状態）。現状は locked 梁が残ったまま各スパンの auto 梁が生成され、二重になる。
test('【手動材サイレント撤去・場面2b】固定梁X1〜X2の間にX1.5を追加しても、分割後の2区間に auto 梁が二重生成されない', { todo: TODO_MSG }, () => {
  const { graph, xCLs: [x1, x2], yCLs: [y1] } = makeGridGraph('S造');
  const beam = addManualBeamLikeUi(graph, StructuralMaterialType.STEEL, 'S-H-300x150', y1, false, x1, x2);
  beam.setDimensionStatus('locked');

  graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: true, discipline: Discipline.STRUCT }); // X1.5を追加
  autoFillBeams(graph, GRID_PROJECT, 'primary', null);

  assert.equal(graph.beamMap.has(beam.id), true, '固定梁は残る（前提）');
  const dup = overlappingAutoPrimaryBeams(graph, beam);
  // 実測（現状）: [0,2000]・[2000,4000] の auto 梁2本が固定梁 [0,4000] の下に生成される。
  assert.equal(dup.length, 0, `固定梁と区間が重なる auto 梁が ${dup.length} 本ある（二重生成）`);
});

test('【手動材サイレント撤去・場面3b】2スパン(X1〜X3)をまたぐ固定梁の下に、各スパンの auto 梁が二重生成されない', { todo: TODO_MSG }, () => {
  const { graph, xCLs: [x1, , x3], yCLs: [y1] } = makeGridGraph('S造', [0, 4000, 8000], [0]);
  const beam = addManualBeamLikeUi(graph, StructuralMaterialType.STEEL, 'S-H-300x150', y1, false, x1, x3);
  beam.setDimensionStatus('locked');

  autoFillBeams(graph, GRID_PROJECT, 'primary', null); // 操作なし

  assert.equal(graph.beamMap.has(beam.id), true, '固定梁は残る（前提）');
  const dup = overlappingAutoPrimaryBeams(graph, beam);
  // 実測（現状）: [0,4000]・[4000,8000] の auto 梁2本が固定梁 [0,8000] の下に生成される。
  assert.equal(dup.length, 0, `固定梁と区間が重なる auto 梁が ${dup.length} 本ある（二重生成）`);
});

// ---- 場面4: 操作なし・在来木造で壁線の候補に無い位置の手動梁（指示書§2.3 4行目） ----
test('【手動材サイレント撤去・場面4】在来木造で壁線の候補に無い位置の手動梁は、何も操作しなくても最初のautoFillWoodWallBeamsで消える', { todo: TODO_MSG }, () => {
  const { graph, xCLs: [x0, x1], yCLs: [y0, y1] } = makeGridGraph(TRADITIONAL_WOOD_STRUCTURE, [0, 3640], [0, 3640]);
  addBackingWall(graph, { axisValue: 0, clStart: y0, clEnd: y1, isVertical: true }); // 縦壁 x=0（候補になる位置）
  // 壁の無い位置（y=3640の水平梁）に手動梁を置く——壁線runの候補に含まれない。
  const beam = addManualBeamLikeUi(graph, StructuralMaterialType.WOOD, 'WOOD-120x120', y1, false, x0, x1);

  const wallSegments = selfWallSegments(graph);
  autoFillWallBeamAxes(graph, wallSegments);
  autoFillWoodWallBeams(graph, GRID_PROJECT, wallSegments); // 操作なし（壁の追加・削除をしていない）

  // 実測（現状）: 壁線runの候補キーに無いauto梁（role:'primary'）として撤去ループに巻き込まれる。
  assert.equal(graph.beamMap.has(beam.id), true, '壁線の候補に無い手動梁が操作なしで消えてはいけない');
});

// ---- 場面5: 主構造の変更（指示書§2.3 5行目） ----
test('【手動材サイレント撤去・場面5】S造の通り芯交点に置いた手動柱は、主構造を在来木造へ変えて再計算すると消える', { todo: TODO_MSG }, () => {
  // 在来木造は壁交点方式（columnPlacement:'wallIntersections'）へ切り替わり、通り芯グリッド交点は
  // 候補から外れる。在来木造の手動柱はUIがlockedを付ける（壁交点方式）ため、対象外になる組合せ
  // （S造の通り芯交点の手動柱→在来木造へ変更）を選ぶ——指示書§2.3の「主構造の変更」に該当する
  // もう一方の具体例。壁が1本も無い階は既存柱を保全する特例（woodAutoFill.js:250。ユーザー裁定
  // 2026-09-14）があるため、手動柱と無関係な位置に壁を1本置いて撤去ループ自体は走らせる。
  const { graph, xCLs: [x1, x2], yCLs: [y1, y2] } = makeGridGraph('S造');
  const col = addManualColumnLikeUi(graph, StructuralMaterialType.STEEL, 'S-C-400x400', x2, y1);
  addBackingWall(graph, { axisValue: x1.value, clStart: y1, clEnd: y2, isVertical: true }); // 手動柱(x2,y1)とは無関係な壁

  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE; // 主構造の変更

  autoFillColumnsForStructure(graph, GRID_PROJECT, null); // 手動柱の位置(x2,y1)は壁交点ではないため候補に入らない

  // 実測（現状）: 壁交点方式の候補に無いauto柱として撤去される。
  assert.equal(graph.columnMap.has(col.id), true, '主構造の変更で候補が入れ替わっても手動柱が消えてはいけない');
});
