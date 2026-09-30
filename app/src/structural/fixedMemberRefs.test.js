// fixedMemberRefs.js の単体テスト（指示書 dev直下 260929_手動追加材サイレント撤去回避.md §5 ステップ3）。
// 他階 peek のテストスタブは本番同型（`new PlanGraph(plane)` → `_structGraph` → `restoreGraph(g, store)`。
// 前例: transform/centerLineOps.test.js の withProductionPeek）を使う（team-lessons 2026-09-29）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanGraph, Project, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { undoManager } from '../undoManager.js';
import {
  fixedMembersReferencing, collectFixedMembersByFloor, removeFixedMembersReferencing,
  formatFixedMemberConfirm, clDisplayName,
} from './fixedMemberRefs.js';

// 本番同型 peek（IDBの代わりに Map ストアを読む）。centerLineOps.test.js withProductionPeekと同型。
function withProductionPeek(project, store, fn) {
  const originalPeek = floorSwapManager.peek;
  let peekCalls = 0;
  floorSwapManager.peek = async (plane) => {
    peekCalls++;
    const g = new PlanGraph(plane);
    g._structGraph = project.structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
  return (async () => {
    try {
      return await fn(() => peekCalls);
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  })();
}

function makeSingleFloor() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const v = graph.addCenterLine(CenterLineType.VERTICAL, 0,   { labeled: false, discipline: Discipline.ARCH });
  const h = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  return { project, graph, v, h };
}

function makeTwoFloorsWithGridCL() {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  return { project, p1, p2, y0, x0, x1 };
}

// ---- (a) 自階の locked 柱・梁・基礎を数える。auto は数えない。calculated は数える（Q4） ----

test('fixedMembersReferencing: dimensionStatus!==\'auto\'（locked・calculated）の柱・梁・基礎を数え、autoは数えない', () => {
  const { graph, v, h } = makeSingleFloor();
  const v2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });

  graph.addColumn(StructuralMaterialType.WOOD, 'SEC-C', v, h, { dimensionStatus: 'auto' });
  const lockedCol = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-C', v, h, { dimensionStatus: 'locked' });
  const calcCol   = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-C', v, h, { dimensionStatus: 'calculated' });
  graph.addBeam(StructuralMaterialType.WOOD, 'SEC-B', h, false, v, v2, { dimensionStatus: 'auto' });
  const lockedBeam = graph.addBeam(StructuralMaterialType.WOOD, 'SEC-B', h, false, v, v2, { dimensionStatus: 'locked' });
  graph.addFooting('independent', 'SEC-F', v, h, { dimensionStatus: 'auto' });
  const lockedFooting = graph.addFooting('independent', 'SEC-F', v, h, { dimensionStatus: 'locked' });

  const refsV = fixedMembersReferencing(graph, v.id);
  assert.deepEqual(refsV.columns.map(c => c.id).sort(), [calcCol.id, lockedCol.id].sort());
  assert.deepEqual(refsV.beams.map(b => b.id), [lockedBeam.id]);
  assert.deepEqual(refsV.footings.map(f => f.id), [lockedFooting.id]);
});

// 変異: dimensionStatus!=='auto' のフィルタを外すと (a) は赤くなる、を手作業で裏取り済み
// （filter条件を`() => true`に置換して再実行→columns.length不一致で失敗を確認・元に戻した）。

// 階が1つしかないと「他階を見ない」ことがpeek呼び出し回数0で確認できず、他階peekを呼んでしまう
// 変異（例: FLOOR_SHARED_KINDS判定を外して常に他階を見る）でも緑のまま通ってしまう（QA指摘）。
// (c)梁芯と同型に2階構成へ直し、peek呼び出し回数0をassertする。
test('collectFixedMembersByFloor: 中心線（階固有）は自階の固定材だけを数え、他階はpeekしない（呼び出し回数0）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const vP1 = p1.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH }, 'shared-id');
  const vP2 = p2.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH }, 'shared-id');
  const hP1 = p1.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const hP2 = p2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const lockedCol = p1.addColumn(StructuralMaterialType.WOOD, 'SEC-C', vP1, hP1, { dimensionStatus: 'locked' });
  p2.addColumn(StructuralMaterialType.WOOD, 'SEC-C', vP2, hP2, { dimensionStatus: 'locked' }); // idが同じでも他階のCLとは無関係

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  await withProductionPeek(project, store, async (peekCallCount) => {
    const byFloor = await collectFixedMembersByFloor(project, p1, vP1);
    assert.equal(byFloor.length, 1);
    assert.equal(byFloor[0].plane, p1.plane);
    assert.equal(byFloor[0].columns, 1);
    assert.equal(byFloor[0].beams, 0);
    assert.equal(byFloor[0].footings, 0);
    assert.equal(peekCallCount(), 0, '中心線は他階をpeekしないはず');
  });
  assert.ok(lockedCol);
});

// ---- (b) 通り芯: 他階（本番同型peekスタブ）に locked 柱があれば階ごとに出る。自階が先頭 ----

test('collectFixedMembersByFloor: 通り芯（全階共通）は他階もpeekして固定材を数える。自階が先頭', async () => {
  const { project, p1, p2, y0, x0 } = makeTwoFloorsWithGridCL();

  const selfCol = p1.addColumn(StructuralMaterialType.STEEL, 'SEC-C', x0, y0, { dimensionStatus: 'locked' });
  // p2側のlocked柱を作ってシリアライズし、store経由で読ませる（本番同型peek）
  const otherCol = p2.addColumn(StructuralMaterialType.STEEL, 'SEC-C', x0, y0, { dimensionStatus: 'locked' });
  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);

  await withProductionPeek(project, store, async () => {
    const byFloor = await collectFixedMembersByFloor(project, p1, x0);
    assert.equal(byFloor.length, 2, '自階・他階の両方が対象になるはず');
    assert.equal(byFloor[0].plane, p1.plane, '自階が先頭');
    assert.equal(byFloor[0].columns, 1);
    assert.equal(byFloor[1].plane.id, p2.plane.id, '他階（2階）が続く');
    assert.equal(byFloor[1].columns, 1);
  });
  assert.ok(selfCol && otherCol);
});

// ---- (c) 梁芯/中心線: 他階に同idの材があっても見ない（peek呼び出し回数0） ----

test('collectFixedMembersByFloor: 梁芯・中心線は他階をpeekしない（呼び出し回数0）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  // 梁芯（discipline:FUSE）はグラフ固有の実体。p1・p2それぞれに別インスタンスとして作る
  // （idが同じでも他階のCLとは無関係——本テストの主眼はpeekが呼ばれないこと自体）。
  const beamAxisP1 = p1.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.FUSE }, 'shared-id');
  const beamAxisP2 = p2.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.FUSE }, 'shared-id');
  const vP1 = p1.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const vP2 = p2.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  p1.addColumn(StructuralMaterialType.WOOD, 'SEC-C', vP1, beamAxisP1, { dimensionStatus: 'locked' });
  p2.addColumn(StructuralMaterialType.WOOD, 'SEC-C', vP2, beamAxisP2, { dimensionStatus: 'locked' });

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  await withProductionPeek(project, store, async (peekCallCount) => {
    const byFloor = await collectFixedMembersByFloor(project, p1, beamAxisP1);
    assert.equal(byFloor.length, 1, '自階だけが対象');
    assert.equal(byFloor[0].plane, p1.plane);
    assert.equal(peekCallCount(), 0, '梁芯は他階をpeekしないはず');
  });
});

// ---- (d) 固定材なし → [] ----

test('collectFixedMembersByFloor: 固定材が無ければ空配列を返す', async () => {
  const { project, graph, v, h } = makeSingleFloor();
  graph.addColumn(StructuralMaterialType.WOOD, 'SEC-C', v, h, { dimensionStatus: 'auto' }); // autoのみ
  const byFloor = await collectFixedMembersByFloor(project, graph, v);
  assert.deepEqual(byFloor, []);
});

// ---- (e) 他階peekが失敗 → 関数がreject。graph・undoに変化なし ----
// 誰も書かないMap（store）同士の比較は恒真になる（QA指摘）ため、副作用が実際にあり得る対象
// （自階p1のシリアライズ結果・undoManagerの積み上がり）を前後で比較する。

test('collectFixedMembersByFloor: 他階peekが失敗すると関数がrejectし、graph・undoは変化しない', async () => {
  const { project, p1, x0, y0 } = makeTwoFloorsWithGridCL();
  p1.addColumn(StructuralMaterialType.STEEL, 'SEC-C', x0, y0, { dimensionStatus: 'locked' });
  const bytesBefore = serializeGraph(p1);
  const undoBefore = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('他階peek失敗'); };
  try {
    await assert.rejects(() => collectFixedMembersByFloor(project, p1, x0), /他階peek失敗/);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
  assert.deepEqual(serializeGraph(p1), bytesBefore, '自階グラフ（p1）は変化しない（読み取り専用のまま失敗する）');
  assert.equal(undoManager.peekUndo(), undoBefore, 'undoスタックは変化しない（積まれていない）');
  assert.equal(project.structGraph.shapeMap.has(x0.id), true, 'structGraph側の通り芯は未変更');
});

// ---- (f) formatFixedMemberConfirm の文言（Q5の例を1件固定。本数0の材種を省く） ----

// ---- removeFixedMembersReferencing（手動追加材サイレント撤去回避 指示書§5ステップ4）----

test('removeFixedMembersReferencing: 返すid数はfixedMembersReferencingの本数と一致し、除外集合（excludedXxxSlots）は変化しない', () => {
  const { graph, v, h } = makeSingleFloor();
  const v2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });

  graph.addColumn(StructuralMaterialType.WOOD, 'SEC-C', v, h, { dimensionStatus: 'auto' }); // 残る
  const lockedCol = graph.addColumn(StructuralMaterialType.WOOD, 'SEC-C', v, h, { dimensionStatus: 'locked' });
  graph.addBeam(StructuralMaterialType.WOOD, 'SEC-B', h, false, v, v2, { dimensionStatus: 'auto' }); // 残る
  const lockedBeam = graph.addBeam(StructuralMaterialType.WOOD, 'SEC-B', h, false, v, v2, { dimensionStatus: 'locked' });
  const lockedFooting = graph.addFooting('independent', 'SEC-F', v, h, { dimensionStatus: 'locked' });

  const before = fixedMembersReferencing(graph, v.id);
  assert.equal(before.columns.length, 1);
  assert.equal(before.beams.length, 1);
  assert.equal(before.footings.length, 1);

  const excludedColumnSizeBefore  = graph.excludedColumnSlots.size;
  const excludedBeamSizeBefore    = graph.excludedBeamSlots.size;
  const excludedFootingSizeBefore = graph.excludedFootingSlots.size;

  const removed = removeFixedMembersReferencing(graph, v.id);
  assert.equal(removed.columns.length, 1);
  assert.deepEqual(removed.columns, [lockedCol.id]);
  assert.deepEqual(removed.beams, [lockedBeam.id]);
  assert.deepEqual(removed.footings, [lockedFooting.id]);

  assert.equal(graph.columnMap.has(lockedCol.id), false, 'locked柱は削除される');
  assert.equal(graph.beamMap.has(lockedBeam.id), false, 'locked梁は削除される');
  assert.equal(graph.footingMap.has(lockedFooting.id), false, 'locked基礎は削除される');
  assert.equal(graph.columns.filter(c => c.dimensionStatus === 'auto').length, 1, 'auto柱は残る');
  assert.equal(graph.beams.filter(b => b.dimensionStatus === 'auto').length, 1, 'auto梁は残る');

  // 除外集合（トポロジー自動補完が「手動削除済み」を覚える集合）は変化しない——ここでの削除は
  // removeColumn/removeBeam/removeFootingを経由しない（降格に伴う自然な後始末のため）。
  assert.equal(graph.excludedColumnSlots.size,  excludedColumnSizeBefore);
  assert.equal(graph.excludedBeamSlots.size,    excludedBeamSizeBefore);
  assert.equal(graph.excludedFootingSlots.size, excludedFootingSizeBefore);
});

test('removeFixedMembersReferencing: 固定梁のスリーブだけを連鎖削除し、auto梁のスリーブは残す', () => {
  const { graph, v, h } = makeSingleFloor();
  const v2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });

  const autoBeam   = graph.addBeam(StructuralMaterialType.WOOD, 'SEC-B', h, false, v, v2, { dimensionStatus: 'auto' });
  const lockedBeam = graph.addBeam(StructuralMaterialType.WOOD, 'SEC-B', h, false, v, v2, { dimensionStatus: 'locked' });
  const autoSleeve   = graph.addSleeve('beam', { hostBeamId: autoBeam.id });
  const lockedSleeve = graph.addSleeve('beam', { hostBeamId: lockedBeam.id });

  const removed = removeFixedMembersReferencing(graph, v.id);
  assert.deepEqual(removed.sleeves, [lockedSleeve.id]);
  assert.equal(graph.sleeveMap.has(lockedSleeve.id), false, '固定梁のスリーブは削除される');
  assert.equal(graph.sleeveMap.has(autoSleeve.id), true, 'auto梁のスリーブは残る（除外集合には無関係）');
  assert.equal(graph.beamMap.has(autoBeam.id), true, 'auto梁自体も残る');
});

test('formatFixedMemberConfirm: verbを渡すと文末の動詞が変わる（降格側の文言。既定値は変えない）', () => {
  const byFloor = [{ plane: { name: '1階' }, columns: 1, beams: 0, footings: 0 }];
  const message = formatFixedMemberConfirm('通り芯 X3', byFloor, { verb: '中心線にする' });
  assert.equal(message, '通り芯 X3 には手動で固定した構造材があります（1階: 柱1）。中心線にすると一緒に削除されます。よろしいですか？');

  const defaultMessage = formatFixedMemberConfirm('通り芯 X3', byFloor);
  assert.equal(defaultMessage, '通り芯 X3 には手動で固定した構造材があります（1階: 柱1）。削除すると一緒に削除されます。よろしいですか？');
});

test('formatFixedMemberConfirm: Q5の例文を固定する（本数0の材種は省く）', () => {
  const message = formatFixedMemberConfirm('通り芯 X3', [
    { plane: { name: '1階' }, columns: 2, beams: 1, footings: 0 },
    { plane: { name: '2階' }, columns: 2, beams: 0, footings: 0 },
  ]);
  assert.equal(
    message,
    '通り芯 X3 には手動で固定した構造材があります（1階: 柱2・梁1／2階: 柱2）。削除すると一緒に削除されます。よろしいですか？',
  );
});

test('clDisplayName: 通り芯はラベル前置、梁芯・中心線はラベルが無ければ種別名＋座標', () => {
  const { project, p1, x0 } = makeTwoFloorsWithGridCL();
  x0.label = 'X1';
  assert.equal(clDisplayName(x0), '通り芯 X1');

  const beamAxis = p1.addCenterLine(CenterLineType.HORIZONTAL, 2400, { labeled: false, discipline: Discipline.FUSE });
  assert.equal(clDisplayName(beamAxis), '梁芯 (2400)');

  const center = p1.addCenterLine(CenterLineType.VERTICAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(clDisplayName(center), '中心線 (1500)');
  assert.ok(project);
});
