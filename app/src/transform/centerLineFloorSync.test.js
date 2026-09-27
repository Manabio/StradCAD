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
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../graphSnapshot.js';
import { applyPromoteToGrid } from './centerLineConvert.js';
import {
  findFloorsWithCounterpartCL, findFloorsWhereFootprintBoundary, findFloorsBlockingGridDeletion,
  recallPromotedCenterLineDuplicates,
  detachOtherFloorsFromGridCenterLine, applyOtherFloorsGridCenterLineAftermath,
  saveOtherFloorsAfterGridCenterLineAftermath, absorbWallBeamAxesOnPromote, applyCenterLineRemovalAftermath,
} from './centerLineFloorSync.js';
import { worldToCell } from '../finish/gridCells.js';
import { collectUnresolvableCells } from '../finish/roomReinterpret.js';

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

// ---- 発見④・ユーザー裁定・案A・2026-09-25: findFloorsWithCounterpartCLのexcludeAbsorbableBeam ----

test('findFloorsWithCounterpartCL: excludeAbsorbableBeam:trueは保護されない壁由来梁芯を相手から除外する', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null }); // 保護されない梁芯
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const withoutExclude = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl));
  assert.equal(withoutExclude.length, 1, '従来どおり（excludeAbsorbableBeam省略）は相手として報告される');

  const withExclude = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl, { excludeAbsorbableBeam: true }));
  assert.equal(withExclude.length, 0, '保護されない梁芯は除外される');
});

test('findFloorsWithCounterpartCL: excludeAbsorbableBeam:trueでもlockedの部材が乗る梁芯は相手として残る', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  const beamAxis = otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const y0 = otherGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', beamAxis, y0, { dimensionStatus: 'locked' });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const result = await withPeekOverride(project, store, () => findFloorsWithCounterpartCL(project, activeGraph, cl, { excludeAbsorbableBeam: true }));
  assert.equal(result.length, 1, '保護される梁芯は除外されない');
  assert.equal(result[0].kind, 'beam');
});

// ---- findFloorsWhereFootprintBoundary ----
// 通り芯削除ガード（centerLineOps.js deleteCenterLineWithUndo）の階またぎ判定。
// isFootprintBoundaryCL（centerLineConvert.js）の階またぎ版——通り芯は全階共通のオブジェクトのため、
// findFloorsWithCounterpartCLと異なり座標一致の対応物探しは不要（同じclをそのままisFootprintBoundaryCLへ渡す）。

test('findFloorsWhereFootprintBoundary: 他階でこの通り芯が外壁線を担っていればそのPlaneを返す', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  const left = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const cellKey = worldToCell(2000, 2000, otherGraph).key;
  otherGraph.addRoom(new Set([cellKey]), '部屋');
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const result = await withPeekOverride(project, store, () => findFloorsWhereFootprintBoundary(project, activeGraph, left));

  assert.equal(result.length, 1);
  assert.equal(result[0].id, otherGraph.plane.id);
});

test('findFloorsWhereFootprintBoundary: 他階に部屋が無ければ空配列', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  const left = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const result = await withPeekOverride(project, store, () => findFloorsWhereFootprintBoundary(project, activeGraph, left));

  assert.deepEqual(result, []);
});

test('【失敗系】findFloorsWhereFootprintBoundary: peekがthrowしたらrejectする', async () => {
  const { project, activeGraph } = makeProjectWithTwoFloors();
  const left = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('IDB read failed'); };
  try {
    await assert.rejects(() => findFloorsWhereFootprintBoundary(project, activeGraph, left), /IDB read failed/);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- findFloorsBlockingGridDeletion（ステップ4・ルール2。findFloorsWhereFootprintBoundaryと
// findUnresolvableCellsを同じpeekへ統合し、anyOtherFloorNeedsWallRegenも相乗りさせたもの） ----

test('findFloorsBlockingGridDeletion: 他階が外壁線を担っていればfootprintPlanesへ、復元不能セルのみならunresolvablePlanesへ分類する', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  const left = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const cellKey = worldToCell(2000, 2000, otherGraph).key; // leftを外壁線として担う部屋
  otherGraph.addRoom(new Set([cellKey]), '部屋');
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);

  const result = await withPeekOverride(project, store, () => findFloorsBlockingGridDeletion(project, activeGraph, left));
  assert.equal(result.footprintPlanes.length, 1, 'leftは外壁線を担うためfootprintPlanesへ分類される');
  assert.equal(result.unresolvablePlanes.length, 0, 'footprint判定を優先するためunresolvablePlanesには入らない');

  // 対辺2本喪失（gone-leftトリック）で「外壁線ではないが復元不能」な内部CLを別階に用意する。
  const key = `gone-left:${y0.id}:${left.id}:${y1.id}`;
  const otherGraph2 = new PlanGraph(otherGraph.plane);
  otherGraph2._structGraph = project.structGraph;
  otherGraph2.addRoom(new Set([key]), '部屋2');
  const store2 = new Map([[otherGraph.plane.id, serializeGraph(otherGraph2)]]);
  const result2 = await withPeekOverride(project, store2, () => findFloorsBlockingGridDeletion(project, activeGraph, left));
  assert.equal(result2.footprintPlanes.length, 0, 'ダングリングな偽キーは輪郭線分に寄与しないため外壁線とは判定されない');
  assert.equal(result2.unresolvablePlanes.length, 1, '対辺2本喪失のためunresolvablePlanesへ分類される');
});

test('findFloorsBlockingGridDeletion: anyOtherFloorNeedsWallRegenはこの通り芯を参照する他階が壁を持てばtrue（QA指摘10で見直し・参照の無い階は対象外）', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]); // 参照なし・壁0本・鍵未設定＝hasNeverBuiltWalls:true

  const noRef = await withPeekOverride(project, store, () => findFloorsBlockingGridDeletion(project, activeGraph, cl));
  assert.equal(noRef.anyOtherFloorNeedsWallRegen, false, '前提: この通り芯を参照しない他階だけならfalse');

  // 部屋セルの辺にこの通り芯を持たせて参照ありにする（referencesClInCellsOrRecords。壁は置かない
  // ——hasNeverBuiltWallsは壁0本のままにしたいため）。geometryは無関係——文字列としてclIdを
  // 含むキーであればよい（他階版findUnresolvableCellsの副作用でunresolvablePlanesにも入りうるが、
  // 本テストの対象はanyOtherFloorNeedsWallRegenのみ）。
  const cellKey = `x:y:${cl.id}:z`;
  otherGraph.addRoom(new Set([cellKey]), '部屋');
  const storeRefOnly = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);
  const refButNoFreshness = await withPeekOverride(project, storeRefOnly, () => findFloorsBlockingGridDeletion(project, activeGraph, cl));
  assert.equal(refButNoFreshness.anyOtherFloorNeedsWallRegen, false,
    '参照があっても壁を一度も持ったことのない階（wallFreshnessKey未設定・壁0本）ならfalse');

  otherGraph.setWallFreshnessKey('dummy'); // 壁0本でも鍵さえ設定されていればhasNeverBuiltWallsは偽になる
  const store2 = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);
  const after = await withPeekOverride(project, store2, () => findFloorsBlockingGridDeletion(project, activeGraph, cl));
  assert.equal(after.anyOtherFloorNeedsWallRegen, true, 'この通り芯を参照し、壁を持ったことのある他階が1つでもあればtrue');
});

// ---- 発見④・ユーザー裁定・案A・2026-09-25: absorbWallBeamAxesOnPromote ----

test('absorbWallBeamAxesOnPromote: 他階の保護されない壁由来梁芯を吸収撤去しsaveFloorFn・undoRecordsへ記録する', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const beamAxis = otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const beamAxisId = beamAxis.id;
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);
  const saved = [];
  const saveFloorFn = async (planeId, bytes) => { saved.push(planeId); store.set(planeId, bytes); };

  const { blockedPlanes } = await withPeekOverride(project, store, () =>
    absorbWallBeamAxesOnPromote(project, activeGraph, cl, { saveFloorFn })
  );

  assert.deepEqual(blockedPlanes, []);
  assert.deepEqual(saved, [otherGraph.plane.id]);
  const decoded = decodeFloor(project, otherGraph.plane, store.get(otherGraph.plane.id));
  assert.equal(decoded.shapeMap.has(beamAxisId), false, '保護されない梁芯は撤去される');
});

test('absorbWallBeamAxesOnPromote: 保護される梁芯がある階を1つでも見つけたら何も変更せずblockedPlanesを返す', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const beamAxis = otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE, refId: null });
  const y0 = otherGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', beamAxis, y0, { dimensionStatus: 'locked' });
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);
  const saved = [];
  const saveFloorFn = async (planeId, bytes) => { saved.push(planeId); store.set(planeId, bytes); };

  const { blockedPlanes } = await withPeekOverride(project, store, () =>
    absorbWallBeamAxesOnPromote(project, activeGraph, cl, { saveFloorFn })
  );

  assert.equal(blockedPlanes.length, 1);
  assert.equal(blockedPlanes[0].id, otherGraph.plane.id);
  assert.deepEqual(saved, [], '保護される階が1つでもあれば何も保存しない');
  const decoded = decodeFloor(project, otherGraph.plane, store.get(otherGraph.plane.id));
  assert.equal(decoded.shapeMap.has(beamAxis.id), true, '梁芯は無変更');
});

test('absorbWallBeamAxesOnPromote: 梁芯が無い階・座標が違う階はundoRecordsに積まれない', async () => {
  const { project, activeGraph, otherGraph } = makeProjectWithTwoFloors();
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.FUSE, refId: null }); // 別座標
  const store = new Map([[otherGraph.plane.id, serializeGraph(otherGraph)]]);
  const saved = [];
  const saveFloorFn = async (planeId) => { saved.push(planeId); };

  const undoRecords = [];
  const { blockedPlanes } = await withPeekOverride(project, store, () =>
    absorbWallBeamAxesOnPromote(project, activeGraph, cl, { undoRecords, saveFloorFn })
  );

  assert.deepEqual(blockedPlanes, []);
  assert.deepEqual(saved, []);
  assert.deepEqual(undoRecords, []);
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

// ---- detachOtherFloorsFromGridCenterLine / applyOtherFloorsGridCenterLineAftermath
// （段階(a)・案P・2026-09-25。ステップ4・ルール2・2026-09-27で2フェーズへ分割） ----

test('detachOtherFloorsFromGridCenterLine→applyOtherFloorsGridCenterLineAftermath: 他階の通り芯参照の柱・梁・基礎はdetach後に撤去される（decodeFloorだけに頼らず、削除前のstructGraphを復元してから復号し、無関係なCL上の対照部材が残ることも確認する）', async () => {
  const { project, graphs: [p1, p2] } = makeProjectWithFloors(2);
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const otherAxis = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });

  const column  = p2.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', cl, y0);
  const beam    = p2.addBeam(StructuralMaterialType.WOOD, 'SEC-BEAM', cl, true, y0, y1);
  const footing = p2.addFooting('independent', 'SEC-FTG', cl, y0);
  // 対照: 削除対象と無関係なCL(otherAxis)上の部材は撤去されないはず——
  // これが無いと「復号後に参照が0件」という主張が、単に何もかも消える壊れた実装でも通ってしまう
  // （偽陰性を防ぐ目的で追加）。
  const otherColumn = p2.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', otherAxis, y0);
  const columnId = column.id, beamId = beam.id, footingId = footing.id, otherColumnId = otherColumn.id;

  const structCLsBefore = serializeStructCLs(project.structGraph, project.structuralInfo, project.memberGroupLedger);
  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  const { contexts } = await withPeekOverride(project, store, () => detachOtherFloorsFromGridCenterLine(project, p1, cl));

  // 強い確認（decode不要）: フェーズ1のdetach直後、生きているtempグラフ自体で参照が消えていること・
  // 無関係な柱は残ることを直接見る（m-1のねらいと同じ「削除前後どちらで判定しても同じ」誤りを
  // 起こさない——ここではシリアライズを一切経由しない）。
  const p2temp = contexts.find(c => c.plane.id === p2.plane.id).temp;
  assert.equal(p2temp.columns.some(c => c.verticalCL.id === cl.id || c.horizontalCL.id === cl.id), false,
    '削除対象通り芯を参照する柱はdetach直後に撤去されるはず');
  assert.equal(p2temp.beams.some(b => b.axisCL.id === cl.id || b.clStart.id === cl.id || b.clEnd.id === cl.id), false,
    '削除対象通り芯を参照する梁はdetach直後に撤去されるはず');
  assert.equal(p2temp.footings.some(f => f.verticalCL.id === cl.id || f.horizontalCL.id === cl.id), false,
    '削除対象通り芯を参照する基礎はdetach直後に撤去されるはず');
  assert.equal(p2temp.columns.some(c => c.id === otherColumnId), true,
    '無関係なCL(otherAxis)上の柱はdetachで撤去されないはず（対照）');

  await withPeekOverride(project, store, async () => {
    project.structGraph.removeCenterLine(cl.id);
    const { processed } = await applyOtherFloorsGridCenterLineAftermath(contexts, project, cl.id, {});
    await saveOtherFloorsAfterGridCenterLineAftermath(processed, { saveFloorFn });
  });

  // decodeFloorはproject.structGraphの「今の」状態でresolveCLするため、cl削除後の
  // ままdecodeすると（既にdetachされていて参照が無いにせよ）resolveCLが解決不能な参照を黙って捨てる
  // 経路も同時に踏んでしまい、偽陰性（detachが効いていなくても緑になる）を防げない。削除前の
  // structGraphスナップショットを一時的に復元してからdecodeし、対照（otherColumn）が正しく残ることも
  // 確認する——detachが本当に効いていなければotherColumnまで含めて復元不能になり、この対照assertが
  // 落ちるはず。
  restoreStructCLs(project.structGraph, project.structuralInfo, structCLsBefore, project.memberGroupLedger);
  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.columns.some(c => c.id === columnId), false, '削除対象通り芯を参照する柱は保存後も残らないはず');
  assert.equal(decoded.beams.some(b => b.id === beamId), false, '削除対象通り芯を参照する梁は保存後も残らないはず');
  assert.equal(decoded.footings.some(f => f.id === footingId), false, '削除対象通り芯を参照する基礎は保存後も残らないはず');
  assert.equal(decoded.columns.some(c => c.id === otherColumnId), true,
    '無関係なCL(otherAxis)上の柱は保存後も残るはず（対照。structGraph復元込みでresolveCLが正しく解決できることの確認）');
});

// ---- applyCenterLineRemovalAftermath: beforeUnresolvableの必須化（2026-09-27） ----
// 安全網（削除前後の復元不能セル差分）は「CLがgraphに存在する」削除前の状態と比較しないと意味を
// 持たない——本関数は呼び出し側が既にCLを取り除いた後に呼ばれるため、自身の内部で採ると
// 「削除後」同士の差分になり常に空になる（実測: 旧実装の regressison）。

// 単独の部屋1つ・右端が最外郭CL（mid）という最小構成——mid削除後、cellInteriorPointはleft側の
// フォールバックで点自体は解決するが、regionCellsAtがその点をもう領域として拾えなくなるため
// （最外郭を失い実体の外になる）、reinterpretRoomsOnEntryは辺の再解釈で救済できず、
// 削除前は解決可能・削除後は復元不能になる（実測: room.cellsのキーは書き換わらないまま残る）。
function makeSingleRoomAtOutermostBoundary() {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0, '1階', 'p1');
  const struct = { labeled: true, discipline: Discipline.STRUCT };
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0, struct);
  const mid = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 4000, struct);
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, struct);
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000, struct);
  const key = `${x0.id}:${y0.id}:${mid.id}:${y1.id}`;
  p1.addRoom(new Set([key]), '部屋');
  return { project, p1, mid, key };
}

test('applyCenterLineRemovalAftermath: opts.beforeUnresolvableを省略するとthrowする', async () => {
  const { project, p1, mid } = makeSingleRoomAtOutermostBoundary();
  await assert.rejects(
    () => applyCenterLineRemovalAftermath(p1, project, mid.id, {
      deleteFn: () => { project.structGraph.removeCenterLine(mid.id); },
    }),
    /beforeUnresolvable/,
  );
});

test('applyCenterLineRemovalAftermath: 削除前（detachより前）に採ったbeforeUnresolvableを渡すと、削除で新たに復元不能になったセルをnewlyUnresolvedとして検出する', async () => {
  const { project, p1, mid, key } = makeSingleRoomAtOutermostBoundary();
  // 正しいタイミング: CLがまだgraphに存在するうちに採る。
  const beforeUnresolvable = collectUnresolvableCells(p1);
  assert.equal(beforeUnresolvable.size, 0, '前提: 削除前はこのセルは復元可能');

  const { newlyUnresolved } = await applyCenterLineRemovalAftermath(p1, project, mid.id, {
    beforeUnresolvable,
    deleteFn: () => { project.structGraph.removeCenterLine(mid.id); },
  });

  assert.deepEqual(newlyUnresolved, [key], '削除前後の差分で新規復元不能セルを検出できるはず');
});

test('【回帰】applyCenterLineRemovalAftermath: beforeUnresolvableを削除後に採ると（旧実装のバグ）差分が常に空になり検出できない', async () => {
  const { project, p1, mid } = makeSingleRoomAtOutermostBoundary();
  // 誤ったタイミング（旧実装の挙動）: 呼び出し側が削除を先に済ませてから
  // beforeUnresolvableを採ってしまうケースを模す——「削除後」同士の比較になり差分は常に空になる。
  project.structGraph.removeCenterLine(mid.id);
  const beforeUnresolvableTooLate = collectUnresolvableCells(p1);
  assert.equal(beforeUnresolvableTooLate.size, 1, '前提: 削除後に採ると既にこのセルが復元不能に含まれてしまう');

  const { newlyUnresolved } = await applyCenterLineRemovalAftermath(p1, project, mid.id, {
    beforeUnresolvable: beforeUnresolvableTooLate,
    deleteFn: () => {}, // 既に削除済みのため呼び出し側の削除は何もしない
  });

  assert.deepEqual(newlyUnresolved, [], '誤ったタイミングのbeforeUnresolvableでは新規復元不能セルを検出できない（旧実装のバグの再現）');
});

// ---- applyOtherFloorsGridCenterLineAftermath: 他階の後始末で新たに復元不能セルが生じたら
// rejectedPlaneを返す（QA指摘2・T2） ----

test('applyOtherFloorsGridCenterLineAftermath: 他階(p2)の後始末で新たに復元不能セルが生じたらrejectedPlaneを返しprocessedに含めない・保存もされない（T2）', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const struct = { labeled: true, discipline: Discipline.STRUCT };
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0, struct);
  const mid = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 4000, struct);
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, struct);
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000, struct);
  // p2だけに、最外郭CL(mid)で右端を担う部屋を置く（p1=自階は空。findUnresolvableCellsによる
  // 先読みガードでは対辺2本喪失ではないため素通りするが、後始末後の実測ではregionCellsAtが
  // 空になり復元不能になるケース——先読みの漏れをS1/M2の安全網が拾うシナリオを模す）。
  const key = `${x0.id}:${y0.id}:${mid.id}:${y1.id}`;
  p2.addRoom(new Set([key]), '部屋');

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveCalls = [];
  const saveFloorFn = async (planeId, bytes) => { saveCalls.push(planeId); store.set(planeId, bytes); };

  const { contexts } = await withPeekOverride(project, store, () => detachOtherFloorsFromGridCenterLine(project, p1, mid));
  project.structGraph.removeCenterLine(mid.id);
  const { rejectedPlane, processed } = await applyOtherFloorsGridCenterLineAftermath(contexts, project, mid.id, {});

  assert.equal(rejectedPlane?.id, p2.plane.id, '後始末で新たに復元不能になったp2がrejectedPlaneとして返るはず');
  assert.equal(processed.length, 0, 'rejectされた階はprocessedに含めないはず');

  await saveOtherFloorsAfterGridCenterLineAftermath(processed, { undoRecords: [], saveFloorFn });
  assert.deepEqual(saveCalls, [], 'rejectされた場合は他階への保存が一度も起きないはず');
});

// ---- detachOtherFloorsFromGridCenterLineのskip判定完全化（ユーザー裁定・持ち越し不可・2026-09-27）:
// referencesClInCellsOrRecordsはcolumnAxisOffsets・clEccentricitiesのキー、refIdでこの通り芯を参照する
// 子CL（isReferencedByOtherCL(clId,{includeRefId:true})）も見る——core/planGraph.jsの
// removeDependentsOfCenterLine（柱芯オフセット・CL偏芯を撤去）・removeCenterLineがdetachFromCenterLineの
// 前に呼ぶ_reparentChildCenterLines（refId子CLの繰り上げ）に対応する種類を漏らさないため。 ----

test('detachOtherFloorsFromGridCenterLine: 部屋セル・壁が無くても柱芯オフセットだけがclIdを指す他階は処理対象になり、保存後のバイト列にキーが残らない', async () => {
  const { project, activeGraph: p1, otherGraph: p2 } = makeProjectWithTwoFloors();
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  p2.setColumnAxisOffset(cl.id, 15);
  assert.equal(p2.hasExternalCenterLineReferences(cl.id), false, '前提: 構造材・部屋セル・壁のいずれからも参照されていない');

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  const { contexts } = await withPeekOverride(project, store, () => detachOtherFloorsFromGridCenterLine(project, p1, cl));
  assert.equal(contexts.some(c => c.plane.id === p2.plane.id), true, '柱芯オフセットだけを持つ他階も処理対象になるはず');

  project.structGraph.removeCenterLine(cl.id);
  const { processed } = await applyOtherFloorsGridCenterLineAftermath(contexts, project, cl.id, {});
  await saveOtherFloorsAfterGridCenterLineAftermath(processed, { saveFloorFn });

  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.columnAxisOffsets.has(cl.id), false, '保存後のバイト列に削除済みidの柱芯オフセットキーが残らないはず');
});

test('detachOtherFloorsFromGridCenterLine: 部屋セル・壁が無くてもCL偏芯だけがclIdを指す他階は処理対象になり、保存後のバイト列にキーが残らない', async () => {
  const { project, activeGraph: p1, otherGraph: p2 } = makeProjectWithTwoFloors();
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  p2.setCLEccentricity(cl.id, { mode: 'value', value: 300 });
  assert.equal(p2.hasExternalCenterLineReferences(cl.id), false, '前提: 構造材・部屋セル・壁のいずれからも参照されていない');

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  const { contexts } = await withPeekOverride(project, store, () => detachOtherFloorsFromGridCenterLine(project, p1, cl));
  assert.equal(contexts.some(c => c.plane.id === p2.plane.id), true, 'CL偏芯だけを持つ他階も処理対象になるはず');

  project.structGraph.removeCenterLine(cl.id);
  const { processed } = await applyOtherFloorsGridCenterLineAftermath(contexts, project, cl.id, {});
  await saveOtherFloorsAfterGridCenterLineAftermath(processed, { saveFloorFn });

  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.clEccentricities.has(cl.id), false, '保存後のバイト列に削除済みidのCL偏芯キーが残らないはず');
});

test('detachOtherFloorsFromGridCenterLine: 部屋セル・壁が無くてもrefIdでclIdを参照する子CLだけがある他階は処理対象になり、保存後のバイト列にrefIdが残らない（reparentChildCenterLinesで繰り上げ）', async () => {
  const { project, activeGraph: p1, otherGraph: p2 } = makeProjectWithTwoFloors();
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const child = p2.addCenterLine(CenterLineType.VERTICAL, 4500, { labeled: false, discipline: Discipline.ARCH, refId: cl.id, refOffset: 500 });
  const childId = child.id;
  assert.equal(p2.hasExternalCenterLineReferences(cl.id), false, '前提: 構造材・部屋セル・壁のいずれからも参照されていない（refId単体はhasExternalCenterLineReferencesの対象外）');
  assert.equal(p2.isReferencedByOtherCL(cl.id, { includeRefId: true }), true, '前提: refIdでclを参照する子CLがある');

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  const valueBefore = child.value; // = cl.value(4000) + refOffset(500) = 4500

  const { contexts } = await withPeekOverride(project, store, () => detachOtherFloorsFromGridCenterLine(project, p1, cl));
  assert.equal(contexts.some(c => c.plane.id === p2.plane.id), true, 'refId子CLだけを持つ他階も処理対象になるはず');
  // phase1のpass2（temp.reparentChildCenterLines）ですでに繰り上がっているはず（強い確認・decode不要）。
  const p2temp = contexts.find(c => c.plane.id === p2.plane.id).temp;
  const childAfterDetach = p2temp.shapeMap.get(childId);
  assert.equal(childAfterDetach.refId, null, 'detach直後、子CLのrefIdはnullへ繰り上がるはず');
  assert.equal(childAfterDetach.value, valueBefore, '繰り上げ後も子CLのvalueは変わらないはず');

  project.structGraph.removeCenterLine(cl.id);
  const { processed } = await applyOtherFloorsGridCenterLineAftermath(contexts, project, cl.id, {});
  await saveOtherFloorsAfterGridCenterLineAftermath(processed, { saveFloorFn });

  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.shapeMap.get(childId)?.refId, null, '保存後のバイト列でも子CLのrefIdは削除済みidを指さないはず');
  assert.equal(decoded.shapeMap.get(childId)?.value, valueBefore, '保存後もvalueは変わらないはず');
});

// ---- 削除する通り芯自身がrefIdを持つとき（refIdの子CLの子という連鎖）、
// reparentChildCenterLinesの「足し込み」分岐（_reparentChildCenterLinesのif(deletedCL.refId)側）を、
// 他階temp graphに対して初めて通す。 ----

test('detachOtherFloorsFromGridCenterLine: 削除する通り芯がrefIdを持つとき、他階の子CLはrefId=親の通り芯・refOffset=和へ繰り上がりvalueは変わらない（reparentChildCenterLinesの足し込み分岐）', async () => {
  const { project, activeGraph: p1, otherGraph: p2 } = makeProjectWithTwoFloors();
  const grandparent = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // mid自身がgrandparentをrefIdで参照する通り芯（S造の境界寄り通り芯のはね出し追従等で実際に起こりうる形）。
  const mid = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0, {
    labeled: true, discipline: Discipline.STRUCT, refId: grandparent.id, refOffset: 2000,
  });
  const midId = mid.id;
  // p2の子CL: midをrefIdで参照する（階固有の意匠中心線・補助線を想定）。
  const child = p2.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH, refId: midId, refOffset: 500 });
  const childId = child.id;
  const valueBefore = child.value; // = grandparent.value(1000) + mid.refOffset(2000) + child.refOffset(500) = 3500
  assert.equal(valueBefore, 3500, '前提: refIdの連鎖でchild.valueが3500に解決されている');

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  const { contexts } = await withPeekOverride(project, store, () => detachOtherFloorsFromGridCenterLine(project, p1, mid));
  const p2temp = contexts.find(c => c.plane.id === p2.plane.id).temp;
  const childAfterDetach = p2temp.shapeMap.get(childId);
  assert.equal(childAfterDetach.refId, grandparent.id, '子CLのrefIdはmidのrefId＝祖父母(grandparent)へ繰り上がるはず（足し込み分岐）');
  assert.equal(childAfterDetach.refOffset, 2500, 'refOffsetはmidのrefOffset(2000)＋子のrefOffset(500)の和になるはず');
  assert.equal(childAfterDetach.value, valueBefore, '繰り上げ後もvalueは変わらないはず');

  project.structGraph.removeCenterLine(midId);
  const { processed } = await applyOtherFloorsGridCenterLineAftermath(contexts, project, midId, {});
  await saveOtherFloorsAfterGridCenterLineAftermath(processed, { saveFloorFn });

  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  const childDecoded = decoded.shapeMap.get(childId);
  assert.equal(childDecoded.refId, grandparent.id, '保存後も子CLのrefIdは祖父母(grandparent)へ繰り上がったままのはず');
  assert.equal(childDecoded.value, valueBefore, '保存後もvalueは変わらないはず');
});
