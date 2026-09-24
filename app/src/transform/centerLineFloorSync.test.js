// centerLineOps.test.js と同じ方針: 実 core.js（Plane/PlanGraph/Project）を使う。
// findFloorsWithCounterpartCL は floorSwapManager.peek（IndexedDB経由）に依存するため、テスト中だけ
// 差し替える（floorSwapManagerはシングルトンインスタンス。try/finallyで必ず復元し、実IDBを経由せずに
// ロジックだけを検証する。IDB不在を理由に断念しない）。
// peekスタブは本番同型（`new PlanGraph(plane)` → `_structGraph = project.structGraph` →
// `restoreGraph(g, bytes)`）にする——team-lessons「floorSwapManager.peekのスタブは本番同型」
// （生きたグラフをそのまま返すスタブは禁止）——本番同型の実例は
// transform/centerLineOps.test.js の withProductionPeek（QA指摘m-6: 旧コメントは
// structural/wallBeamAxes.test.js:197-207 を参照していたが、そこにpeekスタブは無い誤記だった）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlanGraph, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { undoManager } from '../undoManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { applyPromoteToGrid } from './centerLineConvert.js';
import {
  findFloorsWithCounterpartCL, recallPromotedCenterLineDuplicates, propagateGridCenterLineDeletion,
} from './centerLineFloorSync.js';

function makeProjectWithTwoFloors() {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  return { project, activeGraph, otherGraph };
}

// 本番同型 peek（IDBの代わりに Map ストアを読む）を差し替える共通ヘルパ
// （transform/centerLineOps.test.js withProductionPeek と同じ方式）。store は
// Map<planeId, bytes>——peek のたびに新規 PlanGraph を作り直し bytes から復元する（生きたグラフを
// そのまま返さない）。try/finallyで必ず元に戻す。
function withPeekOverride(project, store, fn) {
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => {
    const g = new PlanGraph(plane);
    g._structGraph = project.structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
  return (async () => {
    try {
      return await fn();
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  })();
}

// store に保存されたバイト列を、peek と同じ手順で復号する（centerLineOps.test.js decodeFloor と同型）。
function decodeFloor(project, plane, bytes) {
  const tmp = new PlanGraph(plane);
  tmp._structGraph = project.structGraph;
  if (bytes) restoreGraph(tmp, bytes);
  return tmp;
}

test('findFloorsWithCounterpartCL: 他階に同座標・同軸の非labeled CLがあれば該当Planeと相手種別を返す', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const result = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl));

  assert.equal(result.length, 1);
  assert.equal(result[0].plane.id, otherGraph.plane.id);
  assert.equal(result[0].kind, 'center');
});

test('findFloorsWithCounterpartCL: 相手が補助線・梁芯のときはその種別を返す', async () => {
  {
    const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
    otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' });
    const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
    const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);
    const result = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl));
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'aux');
  }
  {
    const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
    otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
    const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
    const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);
    const result = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl));
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, 'beam');
  }
});

test('findFloorsWithCounterpartCL: 同じ他階に中心線・補助線・梁芯が同座標に共存するとき、優先順（中心線＞補助線＞梁芯）で1つ選ぶ', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const result = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl));

  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'center', '中心線・補助線・梁芯が同座標にあっても中心線を優先して報告する');
});

test('findFloorsWithCounterpartCL: 他階に同座標のCLが無ければ空配列', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH }); // 座標が違う
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const result = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl));

  assert.equal(result.length, 0);
});

test('findFloorsWithCounterpartCL: 同座標にあるのがlabeledな通り芯だけなら空配列（非labeled限定）', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  // 通り芯は project.structGraph に居るのが実態（otherGraph._structGraph 経由で otherGraph.centerLines に
  // 自動的に混ざる）。非labeledのみを対象にする findFloorsWithCounterpartCL のフィルタを直接検証する。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const result = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl));

  assert.equal(result.length, 0);
});

// R8: 同一idの複製は「同じ線の分身」であり重複報告の対象にしない（昇格の回収対象）。
test('findFloorsWithCounterpartCL: 同一idのCLは重複として報告しない', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl.id); // 降格複製を模す（同一id）
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const result = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl));

  assert.equal(result.length, 0);
});

// ---- recallPromotedCenterLineDuplicates ----
// 3階構成（p1アクティブ、p2/p3）でも peek を差し替えるため、複数階版の共通ヘルパを用意する。
function makeProjectWithFloors(count) {
  const project = new Project('proj', 'test');
  const names = ['1階', '2階', '3階', '4階'];
  const graphs = [];
  for (let i = 0; i < count; i++) {
    const { graph } = project.addPlane(i * 3000, names[i], `p${i + 1}`);
    graphs.push(graph);
  }
  return { project, graphs };
}

test('recallPromotedCenterLineDuplicates: 他階の同一id複製だけを外し、その階の壁は残る', async () => {
  const { project, graphs: [p1, p2] } = makeProjectWithFloors(2);
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y3 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });

  const cl1 = p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const cl2 = p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl1.id); // 同一id複製
  p2.addWall(cl2, 0, true, y0, 0, y3, 0, {});
  // recallPromotedCenterLineDuplicates は実運用では常に applyPromoteToGrid の後に呼ばれる
  // （centerLineOps.js promoteCenterToGridWithUndo参照）——先に昇格させておかないと、複製回収後の
  // p2の壁のaxisCL参照（cl1.id）がどこにも解決できず、再シリアライズ→復元時に壁ごと消えてしまう
  // （本番同型peekに直してQAで判明。生きたグラフを返す旧スタブはこの欠落を再現できなかった）。
  applyPromoteToGrid(p1, project.structGraph, cl1);

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saved = [];
  const saveFloorFn = async (planeId, bytes) => { saved.push(planeId); store.set(planeId, bytes); };

  await withPeekOverride(project, store, () =>
    recallPromotedCenterLineDuplicates(project, p1, cl1, { saveFloorFn })
  );

  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.shapeMap.has(cl1.id), false, '複製は回収される');
  assert.equal(decoded.walls.length, 1, '壁は道連れ削除されず残る');
  assert.deepEqual(saved, [p2.plane.id]);
});

test('recallPromotedCenterLineDuplicates: structGraph側の同id通り芯は消えない', async () => {
  const { project, graphs: [p1, p2] } = makeProjectWithFloors(2);
  const cl1 = p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl1.id); // 同一id複製
  applyPromoteToGrid(p1, project.structGraph, cl1); // 実際の昇格経路を経た状態を再現

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  await withPeekOverride(project, store, () =>
    recallPromotedCenterLineDuplicates(project, p1, cl1, { saveFloorFn: async (planeId, bytes) => { store.set(planeId, bytes); } })
  );

  assert.equal(project.structGraph.shapeMap.has(cl1.id), true, '昇格後の通り芯本体は消えない');
  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.shapeMap.has(cl1.id), false, '他階の複製は消える');
});

test('recallPromotedCenterLineDuplicates: 同一id複製が無い階はsaveFloorせずスキップ', async () => {
  const { project, graphs: [p1, p2] } = makeProjectWithFloors(2);
  const cl1 = p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  p2.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH }); // 別id・別座標

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saved = [];
  await withPeekOverride(project, store, () =>
    recallPromotedCenterLineDuplicates(project, p1, cl1, { saveFloorFn: async (planeId) => { saved.push(planeId); } })
  );

  assert.deepEqual(saved, []);
});

test('recallPromotedCenterLineDuplicates: 途中の階でsaveFloorFnがthrowしても、保存済みの階分はamendされ全体はrejectする', async () => {
  const { project, graphs: [p1, p2, p3] } = makeProjectWithFloors(3);
  const cl1 = p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  p2.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl1.id);
  p3.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl1.id);

  const store = new Map([[p2.plane.id, serializeGraph(p2)], [p3.plane.id, serializeGraph(p3)]]);
  const calls = [];
  const saveFloorFn = async (planeId, bytes) => {
    calls.push(planeId);
    if (planeId === p3.plane.id) throw new Error('p3 save failed');
    store.set(planeId, bytes);
  };

  const entry = undoManager.push(() => {}, () => {});
  await withPeekOverride(project, store, () =>
    assert.rejects(() => recallPromotedCenterLineDuplicates(project, p1, cl1, { undoEntry: entry, saveFloorFn }))
  );
  assert.ok(calls.includes(p2.plane.id), 'p2は保存済み');
  assert.equal(calls.filter(id => id === p2.plane.id).length, 1);

  // amendFloorUndoRecordsのundo実行時のsaveFloorFn呼び出しはpeekを経由しない（直接呼ぶ）ため、
  // withPeekOverride のスコープ外（finallyでpeekが元に戻った後）でも問題なく動く。
  const callsBeforeUndo = calls.length;
  undoManager.undo();
  assert.equal(calls.length, callsBeforeUndo + 1, 'undo実行でp2への書き戻しが1回追加される');
  assert.equal(calls[calls.length - 1], p2.plane.id, '書き戻し先はp2のみ（p3は保存されていないため対象外）');
});

// ---- propagateGridCenterLineDeletion（段階(a)・案P。2026-09-25） ----

test('propagateGridCenterLineDeletion: 他階の通り芯参照の柱・梁・基礎はdetach後に撤去される（保存後バイトを、通り芯がまだ残るstructGraphで復号して確認。m-1・QA指摘）', async () => {
  const { project, graphs: [p1, p2] } = makeProjectWithFloors(2);
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });

  const column  = p2.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', cl, y0);
  const beam    = p2.addBeam(StructuralMaterialType.WOOD, 'SEC-BEAM', cl, true, y0, y1);
  const footing = p2.addFooting('independent', 'SEC-FTG', cl, y0);

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  await withPeekOverride(project, store, () => propagateGridCenterLineDeletion(project, p1, cl, { saveFloorFn }));

  // この時点ではまだ cl は project.structGraph に残っている（呼び出し側 centerLineOps.js が
  // この後で project.structGraph.removeCenterLine を呼ぶ前提のため）。decodeFloor は
  // project.structGraph（clを含む）で復号する——先にclを取り除いて復号すると、resolveCLが
  // 解決できない参照を黙って捨てるため「参照が見かけ上0件」になる誤検出になる（m-1のねらい。
  // .claude/undo-redo.md「落とし穴」参照）。
  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.columns.some(c => c.verticalCL.id === cl.id || c.horizontalCL.id === cl.id), false,
    '削除対象通り芯を参照する柱は撤去されるはず');
  assert.equal(decoded.beams.some(b => b.axisCL.id === cl.id || b.clStart.id === cl.id || b.clEnd.id === cl.id), false,
    '削除対象通り芯を参照する梁は撤去されるはず');
  assert.equal(decoded.footings.some(f => f.verticalCL.id === cl.id || f.horizontalCL.id === cl.id), false,
    '削除対象通り芯を参照する基礎は撤去されるはず');
  // 前提: フィクスチャが実際にこれらを生成できていること（column/beam/footing変数の未使用警告回避も兼ねる）。
  assert.ok(column.id && beam.id && footing.id);
});
