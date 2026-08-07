// core.jsリファクタStep9（重複走査ロジック統合）の事前テスト。
// 統合対象（_teardownCenterLine / hasExternalCenterLineReferences の構造材マップ走査、
// removeExteriorRow系3関数）の削除挙動を固定し、統合前後で同値であることを保証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph } from './planGraph.js';
import { Plane } from './plane.js';
import { CenterLineType, Discipline, StructuralMaterialType } from './constants.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// 柱・梁・耐力壁・基礎・スリーブが1本のCL（verticalCL）を参照する共通フィクスチャ。
// スラブ（StructuralSlab）はcellKeyのみのCL非依存アンカーのため意図的に含めない
// （_teardownCenterLine のコメント「Room/StructuralSlabと同様にteardown不要という設計」の通り）。
function setupStructuralRefsFixture() {
  const graph = makeGraph();
  const vCL  = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
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

  return { graph, vCL, hCL1, hCL2, column, beam, wall, footing, sleeve, slab };
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

test('hasExternalCenterLineReferences: 構造材（柱・梁・耐力壁・基礎・スリーブ）のいずれかがCLを参照していればtrue', () => {
  const { graph, vCL } = setupStructuralRefsFixture();
  assert.equal(graph.hasExternalCenterLineReferences(vCL.id), true);
});

test('hasExternalCenterLineReferences: どの構造材からも参照されないCLはfalse', () => {
  const graph = makeGraph();
  const freeCL = graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  assert.equal(graph.hasExternalCenterLineReferences(freeCL.id), false);
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
