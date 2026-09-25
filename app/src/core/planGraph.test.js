// core.jsリファクタStep9（重複走査ロジック統合）の事前テスト。
// 統合対象（_teardownCenterLine / hasExternalCenterLineReferences の構造材マップ走査、
// removeExteriorRow系3関数）の削除挙動を固定し、統合前後で同値であることを保証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph } from './planGraph.js';
import { Plane } from './plane.js';
import { Project } from './project.js';
import { CenterLineType, Discipline, StructuralMaterialType, OpeningCategory } from './constants.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// 柱・梁・耐力壁・基礎・スリーブ・一般Shape（線・壁）が1本のCL（verticalCL）を参照する共通フィクスチャ。
// スラブ（StructuralSlab）はcellKeyのみのCL非依存アンカーのため意図的に含めない
// （_teardownCenterLine のコメント「Room/StructuralSlabと同様にteardown不要という設計」の通り）。
function setupStructuralRefsFixture() {
  const graph = makeGraph();
  const vCL  = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const vCL2 = graph.addCenterLine(CenterLineType.VERTICAL,   8000, { labeled: true, discipline: Discipline.STRUCT }); // vCLを参照しない対照群用
  const hCL1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const hCL2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  const column = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', vCL, hCL1);
  const beam   = graph.addBeam(StructuralMaterialType.WOOD, 'SEC-BEAM', vCL, true, hCL1, hCL2);
  const wall   = graph.addBearingWall(StructuralMaterialType.RC, 'SEC-WALL', vCL, true, hCL1, hCL2);
  const footing = graph.addFooting('independent', 'SEC-FTG', vCL, hCL1);
  const sleeve = graph.addSleeve('beam', {
    hostBeamId: beam.id, hostAxisCL: beam.axisCL, hostClStart: beam.clStart, hostClEnd: beam.clEnd,
  });
  // 参照しないスラブ（cells集合のみ。CLを一切持たない）— 削除経路の対象外であることの対照群。
  const slab = graph.addSlab(StructuralMaterialType.RC, 'SEC-SLAB', new Set(['dummy-cell']));

  // 一般Shape（意匠）: vCLを参照する垂直線・壁と、vCL2を参照し無関係な垂直線（対照群）。
  const line       = graph.addVerticalLine(vCL, hCL1, hCL2, {});
  const archWall   = graph.addWall(vCL, 0, true, hCL1, 0, hCL2, 0, {});
  const unrelatedLine = graph.addVerticalLine(vCL2, hCL1, hCL2, {});

  return { graph, vCL, vCL2, hCL1, hCL2, column, beam, wall, footing, sleeve, slab, line, archWall, unrelatedLine };
}

test('removeCenterLine: CL削除は参照する柱・梁・耐力壁・基礎・スリーブを道連れ削除する（スラブはcellKey基準のため対象外）', () => {
  const { graph, vCL, column, beam, wall, footing, sleeve, slab } = setupStructuralRefsFixture();

  assert.equal(graph.columnMap.size, 1);
  assert.equal(graph.beamMap.size, 1);
  assert.equal(graph.wallMap.size, 1);
  assert.equal(graph.footingMap.size, 1);
  assert.equal(graph.sleeveMap.size, 1);
  assert.equal(graph.slabMap.size, 1);

  graph.removeCenterLine(vCL.id);

  assert.equal(graph.columnMap.has(column.id), false, '柱は道連れ削除されるはず');
  assert.equal(graph.beamMap.has(beam.id), false, '梁は道連れ削除されるはず');
  assert.equal(graph.wallMap.has(wall.id), false, '耐力壁は道連れ削除されるはず');
  assert.equal(graph.footingMap.has(footing.id), false, '基礎は道連れ削除されるはず');
  assert.equal(graph.sleeveMap.has(sleeve.id), false, 'CL参照する梁ホストのスリーブは道連れ削除されるはず');
  assert.equal(graph.slabMap.has(slab.id), true, 'スラブはCLを参照しないため削除されないはず');
});

test('removeCenterLine: CL削除は参照する一般Shape（線・壁）も道連れ削除する', () => {
  const { graph, vCL, line, archWall, unrelatedLine } = setupStructuralRefsFixture();

  assert.equal(graph.shapeMap.has(line.id), true);
  assert.equal(graph.shapeMap.has(archWall.id), true);
  assert.equal(graph.shapeMap.has(unrelatedLine.id), true);

  graph.removeCenterLine(vCL.id);

  // _teardownCenterLine の refs.shapes 経路（_shapeUsesCenterLine 経由）で削除される一般Shape。
  assert.equal(graph.shapeMap.has(line.id), false, 'vCLを参照する垂直線は道連れ削除されるはず');
  assert.equal(graph.shapeMap.has(archWall.id), false, 'vCLを参照する壁は道連れ削除されるはず');
  // vCLを参照しない別Shapeは残存する。
  assert.equal(graph.shapeMap.has(unrelatedLine.id), true, 'vCLを参照しない垂直線は残るはず');
});

// ---- removeDependentsOfCenterLine（段階(a)・案P。_teardownCenterLineから抽出した公開action）----
// 通り芯削除（transform/centerLineOps.js deleteCenterLineWithUndo）が structGraph 側の削除の前に
// 階グラフ側で呼ぶ（structGraph の teardown は階グラフの部材に届かないため）。

test('removeDependentsOfCenterLine: 参照する構造材・columnAxisOffsets・clEccentricitiesは撤去するが、Intersection・CL本体には触れない（_teardownCenterLineから抽出した本体）', () => {
  const { graph, vCL, hCL1, column, beam, wall, footing, sleeve, line, archWall } = setupStructuralRefsFixture();
  graph.setColumnAxisOffset(vCL.id, 15);
  graph.setCLEccentricity(vCL.id, { mode: 'value', value: 50, side: 1, backing: '' });

  const ixKey = `${vCL.id}:${hCL1.id}`;
  assert.equal(graph.intersectionMap.has(ixKey), true, '前提: vCL×hCL1のIntersectionが存在する');

  graph.removeDependentsOfCenterLine(vCL.id);

  assert.equal(graph.columnMap.has(column.id), false, '柱は撤去されるはず');
  assert.equal(graph.beamMap.has(beam.id), false, '梁は撤去されるはず');
  assert.equal(graph.wallMap.has(wall.id), false, '耐力壁は撤去されるはず');
  assert.equal(graph.footingMap.has(footing.id), false, '基礎は撤去されるはず');
  assert.equal(graph.sleeveMap.has(sleeve.id), false, 'CL参照する梁ホストのスリーブは撤去されるはず');
  assert.equal(graph.shapeMap.has(line.id), false, 'vCLを参照する垂直線は撤去されるはず');
  assert.equal(graph.shapeMap.has(archWall.id), false, 'vCLを参照する壁は撤去されるはず');
  assert.equal(graph.columnAxisOffsets.has(vCL.id), false, '柱芯オフセットのキーも撤去されるはず');
  assert.equal(graph.clEccentricities.has(vCL.id), false, 'CL偏芯のキーも撤去されるはず');

  // Intersectionには触れない（_removeIntersectionsForは呼ばない——_teardownCenterLineが続けて呼ぶ）。
  assert.equal(graph.intersectionMap.has(ixKey), true, 'removeDependentsOfCenterLineはIntersectionを撤去しないはず');
  // CL本体（CenterLine実体）もこのメソッドでは削除されない。
  assert.equal(graph.shapeMap.has(vCL.id), true, 'CL本体はremoveDependentsOfCenterLineでは削除されない');
});

test('removeCenterLine: removeDependentsOfCenterLine抽出後もCL削除の結果は分割前と同一（Intersection・CL本体も道連れ削除される）', () => {
  const { graph, vCL, hCL1, hCL2 } = setupStructuralRefsFixture();
  const ixKey1 = `${vCL.id}:${hCL1.id}`;
  const ixKey2 = `${vCL.id}:${hCL2.id}`;
  assert.equal(graph.intersectionMap.has(ixKey1), true);
  assert.equal(graph.intersectionMap.has(ixKey2), true);

  graph.removeCenterLine(vCL.id);

  assert.equal(graph.intersectionMap.has(ixKey1), false, 'removeCenterLineは従来どおりIntersectionも道連れ削除するはず');
  assert.equal(graph.intersectionMap.has(ixKey2), false);
  assert.equal(graph.shapeMap.has(vCL.id), false, 'CL本体も削除される');
});

// ---- isReferencedByOtherCL（QA指摘m-3: isReferencedByCLをcore/centerLineKindPolicy.jsから移設・
// hasExternalCenterLineReferencesのextentRef判定と統合。2026-09-25） ----

test('isReferencedByOtherCL: 他CLのextentLoRef/extentHiRefがこのCLを指していればtrue', () => {
  const graph = makeGraph();
  const vCL = graph.addCenterLine(CenterLineType.VERTICAL,   0, { labeled: true, discipline: Discipline.STRUCT });
  const hCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  graph.setCenterLineExtentRef(hCL, 'lo', { clId: vCL.id });
  assert.equal(graph.isReferencedByOtherCL(vCL.id), true);
});

test('isReferencedByOtherCL: 既定（includeRefId省略）では他CLのrefIdがこのCLを指していればtrue', () => {
  const graph = makeGraph();
  const parent = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1100, { labeled: false, discipline: Discipline.ARCH, refId: parent.id, refOffset: 100 });
  assert.equal(graph.isReferencedByOtherCL(parent.id), true);
});

test('【失敗系】isReferencedByOtherCL: includeRefId:falseなら他CLのrefIdだけの参照はfalse扱いになる（hasExternalCenterLineReferencesが使う形）', () => {
  const graph = makeGraph();
  const parent = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1100, { labeled: false, discipline: Discipline.ARCH, refId: parent.id, refOffset: 100 });
  assert.equal(graph.isReferencedByOtherCL(parent.id, { includeRefId: false }), false);
});

test('【失敗系】isReferencedByOtherCL: どのCLからも参照されていなければfalse', () => {
  const graph = makeGraph();
  const freeCL = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(graph.isReferencedByOtherCL(freeCL.id), false);
});

// ---- referencingCenterLines（段階(d)・2026-09-25。isReferencedByOtherCLの真偽値版が使う「参照して
// いるCLの一覧」を公開し、core/centerLineKindPolicy.jsのstructuralSyncScopeForCenterLineが
// 参照元の種別を辿るのに使う） ----

test('referencingCenterLines: extentLoRef/extentHiRef・refIdで参照している他CLをすべて返す（自分自身は含まない）', () => {
  const graph = makeGraph();
  const target = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const hCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  graph.setCenterLineExtentRef(hCL, 'lo', { clId: target.id });
  const child = graph.addCenterLine(CenterLineType.HORIZONTAL, 100, { labeled: false, discipline: Discipline.ARCH, refId: target.id, refOffset: 100 });

  const refs = graph.referencingCenterLines(target.id);
  assert.deepEqual(refs.map(r => r.id).sort(), [hCL.id, child.id].sort());
});

test('referencingCenterLines: includeRefId:falseならrefId単体の参照は含まない', () => {
  const graph = makeGraph();
  const parent = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1100, { labeled: false, discipline: Discipline.ARCH, refId: parent.id, refOffset: 100 });
  assert.deepEqual(graph.referencingCenterLines(parent.id, { includeRefId: false }), []);
});

test('【失敗系】referencingCenterLines: どのCLからも参照されていなければ空配列', () => {
  const graph = makeGraph();
  const freeCL = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  assert.deepEqual(graph.referencingCenterLines(freeCL.id), []);
});

test('hasExternalCenterLineReferences: 構造材（柱・梁・耐力壁・基礎・スリーブ）のいずれかがCLを参照していればtrue', () => {
  const { graph, vCL } = setupStructuralRefsFixture();
  assert.equal(graph.hasExternalCenterLineReferences(vCL.id), true);
});

test('hasExternalCenterLineReferences: どの構造材からも参照されないCLはfalse', () => {
  const graph = makeGraph();
  const freeCL = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(graph.hasExternalCenterLineReferences(freeCL.id), false);
});

test('hasExternalCenterLineReferences: 他CLのextentRefが指しているCLはtrue（構造材参照ゼロでも）', () => {
  const graph = makeGraph();
  const vCL = graph.addCenterLine(CenterLineType.VERTICAL,   0, { labeled: true, discipline: Discipline.STRUCT });
  const hCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  // 構造材は一切参照させず、hCLのextentLoRefだけがvCLを指す状態を作る
  // （planGraph.js の hasExternalCenterLineReferences 内、_structuralRefsToCL 外に残した分岐を固定する）。
  graph.setCenterLineExtentRef(hCL, 'lo', { clId: vCL.id });

  assert.equal(graph.hasExternalCenterLineReferences(vCL.id), true);
});

// m-3統合後の回帰固定: isReferencedByOtherCL(id, {includeRefId:false})経由になっても、
// refId単体の参照はhasExternalCenterLineReferencesでは「壊れる外部参照」に数えない
// （_reparentChildCenterLinesで繰り上がるため安全。コメントどおりの既存挙動）。
test('【失敗系】hasExternalCenterLineReferences: 他CLのrefId単体の参照はfalse（_reparentChildCenterLinesで繰り上がるため対象外）', () => {
  const graph = makeGraph();
  const parent = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1100, { labeled: false, discipline: Discipline.ARCH, refId: parent.id, refOffset: 100 });
  assert.equal(graph.hasExternalCenterLineReferences(parent.id), false);
});

// ---- 外部仕上げ行の削除3経路 ----

function addRow(graph, category, part, roomId = null) {
  return graph.addExteriorRow(category, part, roomId);
}

test('removeExteriorRow: idが一致する行だけを1件削除する', () => {
  const graph = makeGraph();
  const a = addRow(graph, 'exteriorRows', '外壁');
  const b = addRow(graph, 'exteriorRows', '軒天');
  assert.equal(graph.exteriorRows.length, 2);

  graph.removeExteriorRow('exteriorRows', a.id);

  assert.equal(graph.exteriorRows.length, 1);
  assert.equal(graph.exteriorRows[0].id, b.id);
});

test('removeExteriorRow: 存在しないidを渡しても配列は一切変化しない', () => {
  const graph = makeGraph();
  addRow(graph, 'exteriorRows', '外壁');
  addRow(graph, 'exteriorRows', '軒天');
  const idsBefore = graph.exteriorRows.map(r => r.id);

  graph.removeExteriorRow('exteriorRows', 'no-such-id');

  assert.equal(graph.exteriorRows.length, 2);
  assert.deepEqual(graph.exteriorRows.map(r => r.id), idsBefore);
});

test('removeExteriorRowGroup: 同じpartを持つ行をすべて削除する（他partは残る）', () => {
  const graph = makeGraph();
  addRow(graph, 'exteriorRows', '外壁');
  addRow(graph, 'exteriorRows', '外壁');
  const kept = addRow(graph, 'exteriorRows', '軒天');
  assert.equal(graph.exteriorRows.length, 3);

  graph.removeExteriorRowGroup('exteriorRows', '外壁');

  assert.equal(graph.exteriorRows.length, 1);
  assert.equal(graph.exteriorRows[0].id, kept.id);
});

test('removeExteriorRowsByRoomId: roomIdが一致する行をすべて削除する（exteriorRowsのみ対象）', () => {
  const graph = makeGraph();
  addRow(graph, 'exteriorRows', '階段側壁', 'room-1');
  addRow(graph, 'exteriorRows', '階段側壁', 'room-1');
  const other = addRow(graph, 'exteriorRows', '外壁', 'room-2');
  const manual = addRow(graph, 'exteriorRows', '手入力'); // roomId=null（連動行ではない）
  assert.equal(graph.exteriorRows.length, 4);

  graph.removeExteriorRowsByRoomId('room-1');

  assert.equal(graph.exteriorRows.length, 2);
  const remainingIds = graph.exteriorRows.map(r => r.id).sort();
  assert.deepEqual(remainingIds, [manual.id, other.id].sort());
});

test('removeExteriorRowGroup: categoryを変えればexteriorFittingRows/structureRowsも同じ述語で削除できる', () => {
  const graph = makeGraph();
  addRow(graph, 'exteriorFittingRows', '窓');
  const keptFitting = addRow(graph, 'exteriorFittingRows', '戸');
  addRow(graph, 'structureRows', '基礎');
  const keptStructure = addRow(graph, 'structureRows', '軸組');

  graph.removeExteriorRowGroup('exteriorFittingRows', '窓');
  graph.removeExteriorRowGroup('structureRows', '基礎');

  assert.equal(graph.exteriorFittingRows.length, 1);
  assert.equal(graph.exteriorFittingRows[0].id, keptFitting.id);
  assert.equal(graph.structureRows.length, 1);
  assert.equal(graph.structureRows[0].id, keptStructure.id);
});

test('removeExteriorRowGroup: 同じpartの手入力行を削除しても、同名partのroomId連動行は残る', () => {
  const graph = makeGraph();
  const manual = addRow(graph, 'exteriorRows', 'テラス'); // roomId=null（手入力）
  const linked = addRow(graph, 'exteriorRows', 'テラス', 'room-1'); // roomId連動（屋外部屋）
  assert.equal(graph.exteriorRows.length, 2);

  graph.removeExteriorRowGroup('exteriorRows', 'テラス');

  assert.equal(graph.exteriorRows.length, 1);
  assert.equal(graph.exteriorRows[0].id, linked.id, '連動行は巻き込まれず残るはず');
  assert.notEqual(graph.exteriorRows.some(r => r.id === manual.id), true, '手入力行は削除されるはず');
});

// ---- structGraphマージ順（_mergeWithStructGraph）----

test('centerLines/gridXs: _structGraphがあれば[...struct, ...own]順でマージ、無ければ自グラフのみ', () => {
  const project = new Project('proj1', 'テスト物件');
  const { graph } = project.addPlane(0, '1階'); // _structGraph = project.structGraph が自動配線される

  // struct側（通り芯専用グラフ）にX3000、自グラフ側にX1000を追加
  const structCL = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3000, {
    labeled: true, discipline: Discipline.STRUCT,
  });
  const ownCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: true, discipline: Discipline.STRUCT,
  });

  // centerLines は生の [...struct, ...own] 順（ソートなし）
  assert.deepEqual(graph.centerLines.map(cl => cl.id), [structCL.id, ownCL.id]);
  // gridXs はマージ後に value 昇順ソートされる
  assert.deepEqual(graph.gridXs.map(cl => cl.value), [1000, 3000]);

  // _structGraph 自身（null）は自グラフのみを返す
  assert.equal(project.structGraph._structGraph, null);
  assert.deepEqual(project.structGraph.centerLines.map(cl => cl.id), [structCL.id]);
  assert.deepEqual(project.structGraph.gridXs.map(cl => cl.value), [3000]);
});

// ---- 段階(f)・案A（2026-09-26裁定）: 平面の交点長押しメニュー'del'はngraphにリンクされた
// 一般図形しか消せない（構造・壁・建具は対象外）という事実のピン留め ----

// 交点に壁・建具・柱・梁が「同じ座標で」乗っていても、getShapesAtNodeはngraphのリンク（_registerShape
// を呼ぶaddVerticalLine/addHorizontalLine/addDiagonalLine/addArc/addCircleの5種）だけを辿るため、
// それらは一切返らず、その交点を端点に持つ斜線・垂直線・水平線だけが返る。
// これがApp.jsxの'del'ハンドラ（graph.getShapesAtNode(menu.snap).forEach(s => graph.removeShape(s.id))）
// の「一般図形しか消えない」の直接の根拠——壁・建具・柱・梁・基礎・耐力壁・スラブ・スリーブは
// _registerShapeを呼ばない（addWall/addOpening/addColumn/addBeam/addFooting/addBearingWall/addSlab/
// addSleeveはshapeMap・各専用Mapへ格納するだけでngraphには一切触れない）ため、そもそもngraphの
// 交点からたどり着けない。
// 【不変条件・将来の変更検知】もし将来getShapesAtNodeが壁・柱・梁等まで返すよう変更されたら、
// このテストが落ちることで段階(f)（`.claude/structural-model.md`「トポロジー自動補完は『除外集合』で
// 手動削除を尊重する」節）の前提が崩れたと分かり、'del'に構造同期を配線するかどうかの再検討が要る。
test('【不変条件・段階(f)・案A】getShapesAtNode: 交点に壁・建具・柱・梁が同座標で乗っていてもそれらは返らず、斜線だけが返る', () => {
  const graph = makeGraph();
  const vCL  = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const vCL2 = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
  const hCL1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const hCL2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  // 交点（vCL, hCL1）に、壁・建具・柱・梁を同座標で配置する（一般図形とは別経路のMap／shapeMapへ
  // 格納されるだけで、ngraphのノード・リンクは一切作らない）。
  graph.addWall(vCL, 0, true, hCL1, 0, hCL2, 0, {});
  graph.addOpening(vCL, 1, true, hCL1, 500, 800, OpeningCategory.FITTING, 'singleSwing', {});
  graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', vCL, hCL1);
  graph.addBeam(StructuralMaterialType.WOOD, 'SEC-BEAM', vCL, true, hCL1, hCL2);

  // 同じ交点を端点に持つ斜線（ngraphにリンクされる一般図形）を1本だけ配置する。
  const nodeAtVclHcl1 = graph.getOrCreateIntersection(vCL, hCL1);
  const nodeAtVcl2Hcl1 = graph.getOrCreateIntersection(vCL2, hCL1);
  const diagonal = graph.addDiagonalLine(nodeAtVclHcl1, nodeAtVcl2Hcl1, {});

  const shapes = graph.getShapesAtNode(nodeAtVclHcl1);
  assert.deepEqual(shapes.map(s => s.id), [diagonal.id],
    '壁・建具・柱・梁は返らず、ngraphにリンクされた斜線だけが返るはず');
});
