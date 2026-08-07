// core.jsリファクタStep9（重複走査ロジック統合）の事前テスト。
// 統合対象（_teardownCenterLine / hasExternalCenterLineReferences の構造材マップ走査、
// removeExteriorRow系3関数）の削除挙動を固定し、統合前後で同値であることを保証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph } from './planGraph.js';
import { Plane } from './plane.js';
import { Project } from './project.js';
import { CenterLineType, Discipline, StructuralMaterialType } from './constants.js';

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
