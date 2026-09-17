// beamAxisMove.test.js / graphSnapshot.test.js と同じ方針: ダックタイピングでは effectiveValue・
// centerLines・structGraph 連携の実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, Project, CenterLineType, Discipline, centerLineKind, OpeningCategory } from '../core.js';
import {
  ERR_CL_DUPLICATE, ERR_CL_CENTER_UPGRADED, ERR_CL_STRUCT_EXISTS,
  ERR_CL_CONVERT_ATTACHED, ERR_CL_CONVERT_NO_GRID, ERR_CL_CONVERT_DUP_FLOOR, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE,
  ERR_CL_DELETE_LAST_GRID,
} from '../error.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import {
  shouldSuggestWoodStructure, commitCLMoveOp, deleteCenterLineWithUndo, addCenterLineFromDialog,
  promoteCenterToGridWithUndo, demoteGridToCenterWithUndo,
} from './centerLineOps.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// project.structGraph・graph._structGraph の連携（struct CL の追加・重複判定）が必要なテスト用。
function makeProjectWithGraph() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// ---- shouldSuggestWoodStructure ----

test('shouldSuggestWoodStructure: appMode!=="floorplan"なら常にfalse', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const project = { structuralInfo: { mainStructure: '未定' } };
  assert.equal(shouldSuggestWoodStructure(graph, project, 'structure', CenterLineType.VERTICAL, [910]), false);
});

test('shouldSuggestWoodStructure: 主構造が確定済み（未定でない）なら提案しない', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const project = { structuralInfo: { mainStructure: '木造（在来）' } };
  assert.equal(shouldSuggestWoodStructure(graph, project, 'floorplan', CenterLineType.VERTICAL, [910]), false);
});

test('shouldSuggestWoodStructure: グリッドが追加CL自身1本しか無ければ比較対象が無くfalse', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 910, { labeled: true, discipline: Discipline.STRUCT });
  const project = { structuralInfo: { mainStructure: '未定' } };
  assert.equal(shouldSuggestWoodStructure(graph, project, 'floorplan', CenterLineType.VERTICAL, [910]), false);
});

test('shouldSuggestWoodStructure: 既存グリッドと910mm間隔ならtrue', () => {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const project = { structuralInfo: { mainStructure: '未定' } };
  assert.equal(shouldSuggestWoodStructure(graph, project, 'floorplan', CenterLineType.VERTICAL, [910]), true);
});

// ---- commitCLMoveOp ----

test('commitCLMoveOp: 移動量ゼロ（effectiveValue===originalValue）ならundoを積まずtoast:null', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });
  const project = {};
  const beforeTop = undoManager.peekUndo();

  const result = commitCLMoveOp(graph, project, cl, cl.value);

  assert.equal(result.toast, null);
  assert.equal(cl.pendingDelta, 0);
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれないはず');
});

test('commitCLMoveOp: 梁芯移動は移動元座標をexcludedWallBeamAxesへ記録し、undoで移動前座標へ戻る', () => {
  const graph = makeGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 2000, {
    labeled: false, discipline: Discipline.FUSE, extentLo: 0, extentHi: 8000,
  });
  const clId = cl.id;
  const project = {
    structuralInfo: { mainStructure: 'S造' },
    memberGroupLedger: new Map(),
    memberNumberIndex: new Map(),
    planes: [],
  };
  cl.pendingDelta = 500; // 2000 → 2500 へドラッグ確定

  const result = commitCLMoveOp(graph, project, cl, 2000);

  assert.equal(cl.value, 2500);
  assert.equal(cl.pendingDelta, 0);
  assert.ok(graph.excludedWallBeamAxes.has('X:2000'), '移動元座標(2000)が除外集合に記録される');
  assert.equal(result.toast, null, '直交大梁(host)が無いため小梁本数は0→0で変化なし＝トーストなし');

  // 梁芯分岐のUndoはグラフスナップショット方式（graph.clear()→再構築）のため、undo後は
  // 同一idの「新しいCenterLineインスタンス」に置き換わる——元の cl 参照ではなく id で引き直す
  // （graphSnapshot.js applySnapshot 参照）。
  undoManager.undo();
  const restored = graph.shapeMap.get(clId);
  assert.equal(restored.value, 2000, 'undoで移動前座標に戻る');
  assert.equal(graph.excludedWallBeamAxes.has('X:2000'), false, 'undoで除外集合の記録も取り消される');
});

// ---- deleteCenterLineWithUndo ----

test('deleteCenterLineWithUndo: 中心線削除はexcludedWallBeamAxesを変えず、梁芯削除だけ記録する', () => {
  const graph = makeGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });
  const beamCL   = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  const project = {};

  deleteCenterLineWithUndo(graph, project, centerCL);
  assert.equal(graph.shapeMap.has(centerCL.id), false);
  assert.equal(graph.excludedWallBeamAxes.size, 0, '中心線の削除ではexcludedWallBeamAxesは変化しない');

  deleteCenterLineWithUndo(graph, project, beamCL);
  assert.equal(graph.shapeMap.has(beamCL.id), false);
  assert.ok(graph.excludedWallBeamAxes.has('Y:3000'), '梁芯の削除は除外集合に記録される');

  undoManager.undo();
  assert.ok(graph.shapeMap.has(beamCL.id), '直前の梁芯削除はundoで復元される');
});

// ---- deleteCenterLineWithUndo: 軸最後の通り芯ガード（ユーザー要望で新設。中心化ガードと同じ
// isLastGridOnAxis判定を共有する多層防御——UIのグレー化を回避して呼ばれても最終的にここで拒否する）----

test('deleteCenterLineWithUndo: 同軸に他の通り芯があれば（軸最後の1本ではない）通り芯の削除は従来どおり成功しtoast:null', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // 同軸に他の通り芯
  const clId = cl.id;

  const { toast } = deleteCenterLineWithUndo(graph, project, cl);

  assert.equal(toast, null);
  assert.equal(project.structGraph.shapeMap.has(clId), false, '削除される');

  undoManager.undo();
  assert.ok(project.structGraph.shapeMap.has(clId), 'undoで復元される');
});

test('deleteCenterLineWithUndo異常系: 軸最後の通り芯はtoast:ERR_CL_DELETE_LAST_GRIDで拒否されグラフ無変更・undoも積まれない', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }); // VERTICAL軸唯一の通り芯
  const beforeTop = undoManager.peekUndo();

  const { toast } = deleteCenterLineWithUndo(graph, project, cl);

  assert.equal(toast, ERR_CL_DELETE_LAST_GRID);
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, '削除されずstructGraphに残る');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('deleteCenterLineWithUndo: 中心線（非struct）の削除は同軸の通り芯本数に関係なく従来どおり成功する', () => {
  const { project, graph } = makeProjectWithGraph();
  // 直交・同軸とも通り芯を1本も用意しない（同軸の通り芯本数=0でも中心線の削除は無関係のはず）。
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  const { toast } = deleteCenterLineWithUndo(graph, project, cl);

  assert.equal(toast, null, '中心線は軸最後ガードの対象外');
  assert.equal(graph.shapeMap.has(cl.id), false, '削除される');
});

// ---- addCenterLineFromDialog ----

test('addCenterLineFromDialog: 通り芯を既存通り芯と同座標に追加しようとするとdone:falseでERR_CL_DUPLICATE、undoは積まれない', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, false);
  assert.equal(result.toast, ERR_CL_DUPLICATE('struct'));
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('addCenterLineFromDialog: 既存通り芯と同座標へ中心線を追加しようとするとdone:falseでERR_CL_STRUCT_EXISTS', () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, false);
  assert.equal(result.toast, ERR_CL_STRUCT_EXISTS);
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('addCenterLineFromDialog: 既存の梁芯（自動生成・平面では非表示）の位置へ中心線・補助線は追加でき、梁芯も残る', () => {
  const { project, graph } = makeProjectWithGraph();
  const beam = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const beforeTop = undoManager.peekUndo();

  // 既存=梁芯、新規=中心線 → 拒否しない（下階の壁由来で自階に湧いた梁芯を障害物にしない）
  const r1 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r1.done, true);
  assert.equal(r1.toast, null);
  const vAt1000 = graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000);
  assert.equal(vAt1000.length, 2, '梁芯と中心線が同位置に共存する');
  assert.ok(vAt1000.some(cl => cl.id === beam.id), '既存の梁芯は削除されない');
  assert.ok(vAt1000.some(cl => centerLineKind(cl) === 'center'), '中心線が追加される');
  assert.notEqual(undoManager.peekUndo(), beforeTop, 'undoが積まれる');

  // 既存=梁芯、新規=補助線（別軸で独立させる） → 同様に拒否しない
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  const r1b = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'horizontal', worldCoord: 3000, perpCoord: 0 }, value: 3000, kind: 'aux', refId: null, refOffset: 0 },
    { scaleDenominator: 100 }, // aux の extent 計算（はね出し・丸め）が viewport.scaleDenominator を読む
  );
  assert.equal(r1b.done, true);
  assert.equal(r1b.toast, null);
  assert.ok(graph.centerLines.some(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000 && centerLineKind(cl) === 'aux'));
});

test('addCenterLineFromDialog: 補助線と中心線が共存する位置への通り芯追加は、並び順によらず中心線を削除して昇格する（相手選択は種別優先順）', () => {
  const vp = { scaleDenominator: 100 };
  for (const order of ['aux-first', 'center-first']) {
    const { project, graph } = makeProjectWithGraph();
    const addAux    = () => graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, lineType: 'dashed' });
    const addCenter = () => graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });
    const [aux, center] = order === 'aux-first' ? [addAux(), addCenter()] : (() => { const c = addCenter(); const a = addAux(); return [a, c]; })();

    const r = addCenterLineFromDialog(
      graph, project,
      { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
      vp,
    );
    assert.equal(r.done, true, order);
    assert.equal(r.toast, ERR_CL_CENTER_UPGRADED, `${order}: 中心線を削除して昇格する`);
    assert.equal(graph.shapeMap.has(center.id), false, `${order}: 中心線は削除される`);
    assert.equal(graph.shapeMap.has(aux.id), true, `${order}: 補助線は残る`);
    const kinds = graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000).map(centerLineKind).sort();
    assert.deepEqual(kinds, ['aux', 'struct'], `${order}: 通り芯＋補助線の2本になる`);
  }
});

test('addCenterLineFromDialog: 直交する線・壁が無く extent が1点に退化した補助線でも、同座標の2本目は拒否される', () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1'); // 直交CL・壁なし → フリー端点が両方 perpCoord に丸められ長さ0
  const payload = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'aux', refId: null, refOffset: 0 };
  const vp = { scaleDenominator: 100 };

  const r1 = addCenterLineFromDialog(graph, project, payload, vp);
  assert.equal(r1.done, true);
  const first = graph.centerLines.find(cl => centerLineKind(cl) === 'aux');
  assert.equal(first.extentLo, first.extentHi, '前提: extent が1点に退化している');
  const beforeTop = undoManager.peekUndo();

  const r2 = addCenterLineFromDialog(graph, project, payload, vp);
  assert.equal(r2.done, false);
  assert.equal(r2.toast, ERR_CL_DUPLICATE('aux'));
  assert.equal(graph.centerLines.filter(cl => centerLineKind(cl) === 'aux').length, 1, '補助線は1本のまま');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('addCenterLineFromDialog: 梁芯と共存する中心線・補助線があるとき、同位置への2本目の同種別は先頭が梁芯でも拒否される', () => {
  const { project, graph } = makeProjectWithGraph();
  const vp = { scaleDenominator: 100 };

  // 梁芯が先（＝下階由来の自動生成が先にある実機の状況）→ 中心線を追加 → もう1本中心線
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const payloadC = { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'center', refId: null, refOffset: 0 };
  assert.equal(addCenterLineFromDialog(graph, project, payloadC, null).done, true);
  const beforeTop = undoManager.peekUndo();
  const r2 = addCenterLineFromDialog(graph, project, payloadC, null);
  assert.equal(r2.done, false);
  assert.equal(r2.toast, ERR_CL_DUPLICATE('center'));
  assert.equal(graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1000).length, 2, '梁芯＋中心線の2本のまま');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');

  // 補助線も同様（extent が重なる2本目は拒否）
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.FUSE });
  const payloadA = { clDialog: { type: 'horizontal', worldCoord: 3000, perpCoord: 0 }, value: 3000, kind: 'aux', refId: null, refOffset: 0 };
  assert.equal(addCenterLineFromDialog(graph, project, payloadA, vp).done, true);
  const r3 = addCenterLineFromDialog(graph, project, payloadA, vp);
  assert.equal(r3.done, false);
  assert.equal(r3.toast, ERR_CL_DUPLICATE('aux'));
  assert.equal(graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 3000 && centerLineKind(cl) === 'aux').length, 1);

  // 通り芯追加は梁芯と中心線の並び順によらず梁芯を理由に拒否する（中心線が先でも昇格経路へ入らない）
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: false });                                  // 中心線が先
  graph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: false, discipline: Discipline.FUSE });    // 梁芯が後
  const beforeTop2 = undoManager.peekUndo();
  const r4 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 5000, perpCoord: 0 }, value: 5000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r4.done, false);
  assert.equal(r4.toast, ERR_CL_DUPLICATE('beam'));
  assert.equal(graph.centerLines.filter(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 5000).length, 2, '中心線は削除されず通り芯も増えない');
  assert.equal(undoManager.peekUndo(), beforeTop2, 'undoは積まれない');
});

test('addCenterLineFromDialog: 梁芯の手動追加は既存の中心線・通り芯と同位置に共存できず、通り芯追加も既存の梁芯を拒否する', () => {
  const { project, graph } = makeProjectWithGraph();

  // 既存=中心線、新規=梁芯
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false });
  const r2 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'horizontal', worldCoord: 2000, perpCoord: 0 }, value: 2000, kind: 'beam', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r2.done, false);
  assert.equal(r2.toast, ERR_CL_DUPLICATE('center'));

  // 既存=梁芯、新規=通り芯 → 拒否（大梁と完全重複する小梁の生成防止）
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.FUSE });
  const beforeTop = undoManager.peekUndo();
  const r3 = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );
  assert.equal(r3.done, false);
  assert.equal(r3.toast, ERR_CL_DUPLICATE('beam'));
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('addCenterLineFromDialog: 既存中心線位置への通り芯追加は中心線を削除して昇格し、done:true+ERR_CL_CENTER_UPGRADEDでundo可能', () => {
  const { project, graph } = makeProjectWithGraph();
  const centerCL = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false });
  const centerId = centerCL.id;

  const result = addCenterLineFromDialog(
    graph, project,
    { clDialog: { type: 'vertical', worldCoord: 1000, perpCoord: 0 }, value: 1000, kind: 'struct', refId: null, refOffset: 0 },
    null,
  );

  assert.equal(result.done, true);
  assert.equal(result.toast, ERR_CL_CENTER_UPGRADED);
  assert.deepEqual(result.suggestWood, { clType: CenterLineType.VERTICAL, newValues: [1000] });
  assert.equal(graph.shapeMap.has(centerId), false, '旧中心線は削除される');
  assert.ok(project.structGraph.centerLines.some(cl => cl.value === 1000), '通り芯として structGraph に追加される');

  undoManager.undo();
  assert.ok(graph.shapeMap.has(centerId), 'undoで中心線が復元される');
  assert.equal(project.structGraph.centerLines.some(cl => cl.value === 1000), false, 'undoで通り芯は消える');
});

// ---- promoteCenterToGridWithUndo / demoteGridToCenterWithUndo ----
// findFloorsWithCounterpartCL・propagateDemotedCenterLine は project.planeMap の「アクティブ以外の
// 全Plane」を floorSwapManager.peek（IndexedDB経由）する。単一階の project では対象階が0件となり
// peek は発生しないため、そのまま node:test で検証できる（下の大半のテスト）。複数階をまたぐ
// シナリオ（重複ガード・複製伝播）は structural/wallBeamAxes.test.js:197-207 と同じ方式——
// floorSwapManager.peek をテスト中だけ差し替え（try/finallyで必ず復元）、実IDBを経由せずに
// ロジックだけを検証する。IDB不在を理由に断念しない。

test('promoteCenterToGridWithUndo: 直交通り芯があれば通り芯化しundoで中心線に戻る', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, {
    labeled: false, discipline: Discipline.ARCH, extentLo: -500, extentHi: 3500,
  });
  const clId = cl.id;

  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);

  assert.equal(toast, null);
  assert.equal(graph.shapeMap.has(clId), false);
  assert.equal(project.structGraph.shapeMap.has(clId), true);
  assert.equal(project.structGraph.shapeMap.get(clId).discipline, Discipline.STRUCT);

  undoManager.undo();
  assert.equal(graph.shapeMap.has(clId), true, 'undoで中心線に戻る');
  assert.equal(project.structGraph.shapeMap.has(clId), false);
  const restored = graph.shapeMap.get(clId);
  assert.equal(restored.discipline, Discipline.ARCH);
  assert.equal(restored.labeled, false);

  undoManager.redo();
  assert.equal(graph.shapeMap.has(clId), false);
  assert.equal(project.structGraph.shapeMap.has(clId), true, 'redoで通り芯に戻る');
});

test('promoteCenterToGridWithUndo: 斜線が取り付いた中心線はtoast:ERR_CL_CONVERT_ATTACHEDでundoを積まない', async () => {
  const { project, graph } = makeProjectWithGraph();
  // 昇格は直交通り芯の本数を問わないため必須ではないが、実運用に近い状態（直交通り芯あり）でも
  // ATTACHEDガードが正しく効くことを確認するため用意する。
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 4000,  { labeled: true, discipline: Discipline.STRUCT });
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const hOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const ix = graph.getOrCreateIntersection(cl, hOther);
  graph.addDiagonalLine(ix, graph.addPoint(2000, 2000));
  const beforeTop = undoManager.peekUndo();

  const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);

  assert.equal(toast, ERR_CL_CONVERT_ATTACHED);
  assert.equal(graph.shapeMap.has(cl.id), true, '変換されず階グラフに残る');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('demoteGridToCenterWithUndo: 直交通り芯2本があれば中心線化しundoで通り芯に戻る', async () => {
  const { project, graph } = makeProjectWithGraph();
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // isLastGridOnAxisガード対策: 同軸(VERTICAL)にclの他にもう1本必要。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const clId = cl.id;

  const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

  assert.equal(toast, null);
  assert.equal(project.structGraph.shapeMap.has(clId), false);
  assert.equal(graph.shapeMap.has(clId), true);
  const demoted = graph.shapeMap.get(clId);
  assert.equal(demoted.discipline, Discipline.ARCH);
  assert.equal(demoted.labeled, false);
  assert.deepEqual(demoted.extentLoRef, { clId: y1.id, offset: 0 });
  assert.deepEqual(demoted.extentHiRef, { clId: y2.id, offset: 0 });

  undoManager.undo();
  assert.equal(graph.shapeMap.has(clId), false, 'undoで通り芯に戻る');
  assert.equal(project.structGraph.shapeMap.has(clId), true);
  assert.equal(project.structGraph.shapeMap.get(clId).labeled, true);
});

test('demoteGridToCenterWithUndo: 直交する通り芯が1本しかなければtoast:ERR_CL_CONVERT_NO_GRIDでundoを積まない', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 1本のみ
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

  assert.equal(toast, ERR_CL_CONVERT_NO_GRID);
  assert.equal(project.structGraph.shapeMap.has(cl.id), true, '変換されずstructGraphに残る');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

test('demoteGridToCenterWithUndo: discipline:STRUCTだがlabeled:falseの想定外CLはtoastにエラーが入りundoも積まれず例外も出ない', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

  assert.equal(typeof toast, 'string');
  assert.ok(toast.length > 0, 'エラーメッセージがtoastに入る');
  assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
});

// ---- N5: 同期ガードをIDB peekより先に評価する ----

// 昇格は直交通り芯の本数を問わないため（旧F4ガード撤去済み）、N5（同期ガード優先評価）の
// 昇格側デモには別の同期ガード（ATTACHED）を使う——降格側は別の同期ガード（想定外の
// discipline/labeled組合せ）で実演する（下記）。降格側のNO_GRID自体の先行評価は
// さらに下のテストで別途実証する。
test('promoteCenterToGridWithUndo: 同期ガード（ATTACHED）で確実に失敗する場合はfindFloorsWithCounterpartCL（IDB peek）を呼ばない（N5）', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const hOther = graph.addCenterLine(CenterLineType.HORIZONTAL, 500, { labeled: false, discipline: Discipline.ARCH });
  const ix = graph.getOrCreateIntersection(cl, hOther);
  graph.addDiagonalLine(ix, graph.addPoint(2000, 2000));
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('同期ガードで弾かれるはずなのにpeekが呼ばれた'); };
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_ATTACHED);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('demoteGridToCenterWithUndo: 同期ガード（想定外の discipline/labeled 組合せ）で確実に失敗する場合はfindFloorsWithCounterpartCL（IDB peek）を呼ばない（N5）', async () => {
  const { project, graph } = makeProjectWithGraph();
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('同期ガードで弾かれるはずなのにpeekが呼ばれた'); };
  try {
    const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

    assert.equal(typeof toast, 'string');
    assert.ok(toast.length > 0);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// 降格は直交通り芯2本必須のガードを維持する（昇格と非対称。旧F4ガード撤去済みなのは昇格側のみ）
// ため、NO_GRID自体もIDB peekより先に評価されることを別途実証する。
test('demoteGridToCenterWithUndo: 同期ガード（NO_GRID）で確実に失敗する場合はfindFloorsWithCounterpartCL（IDB peek）を呼ばない（N5）', async () => {
  const { project, graph } = makeProjectWithGraph();
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT }); // 1本のみ
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('同期ガードで弾かれるはずなのにpeekが呼ばれた'); };
  try {
    const { toast } = await demoteGridToCenterWithUndo(graph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_NO_GRID);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 複数階シナリオ（floorSwapManager.peek 差し替え方式） ----

test('promoteCenterToGridWithUndo: 他階に同座標の中心線があればフロア名入りトーストで拒否され変換されない', async () => {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = activeGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  const beforeTop = undoManager.peekUndo();

  // floorSwapManager.peek はIndexedDBに依存するため、テスト用に一時的に差し替える
  // （structural/wallBeamAxes.test.js:197-207 と同じ方式。floorSwapManagerはシングルトンインスタンス）。
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(activeGraph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR('2階'));
    assert.equal(activeGraph.shapeMap.has(cl.id), true, '変換されず階グラフに残る');
    assert.equal(project.structGraph.shapeMap.has(cl.id), false);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('demoteGridToCenterWithUndo: 他階（アクティブ階の移籍先ではない階）に同座標の中心線があればフロア名入りトーストで拒否され変換されない（F3-2）', async () => {
  const project = new Project('proj', 'test');
  const { graph: activeGraph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph }  = project.addPlane(3000, '2階', 'p2');
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }); // 他階に同座標の中心線
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  // isLastGridOnAxisガード対策: 同軸(VERTICAL)にclの他にもう1本必要（このテストの主眼＝DUP_FLOORとは無関係）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT });
  const beforeTop = undoManager.peekUndo();

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await demoteGridToCenterWithUndo(activeGraph, project, cl);

    assert.equal(toast, ERR_CL_CONVERT_DUP_FLOOR_DEMOTE('2階'), '降格専用の文言（「中心線にできません」）が使われる（N1）');
    assert.equal(project.structGraph.shapeMap.has(cl.id), true, '変換されずstructGraphに残る（片階だけ複製漏れを防ぐ）');
    assert.equal(activeGraph.shapeMap.has(cl.id), false);
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 同一id複製（降格が propagateDemotedCenterLine で他階へ複製した「同じ線の分身」）の
// 往復シナリオ。saveFloorFn を注入して実IDBを経由せず記録だけで検証する（wallRefresh.js の
// saveFloorFn 注入と同じ前例。promoteCenterToGridWithUndo/demoteGridToCenterWithUndo の第4引数）。

test('promoteCenterToGridWithUndo: 他階にある同一idの複製は重複拒否の対象にせず昇格でき、複製は回収される', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph } = project.addPlane(3000, '2階', 'p2');
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl.id); // 降格複製を模す（同一id）
  const clId = cl.id;

  const saved = [];
  const saveFloorFn = async (planeId) => { saved.push(planeId); };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl, { saveFloorFn });

    assert.equal(toast, null, '同一idは重複扱いされず拒否されない');
    assert.equal(project.structGraph.shapeMap.has(clId), true);
    assert.equal(graph.shapeMap.has(clId), false);
    assert.equal(otherGraph.shapeMap.has(clId), false, '他階の同一id複製は回収される');
    assert.deepEqual(saved, [otherGraph.plane.id]);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('降格→昇格→降格の往復が通り、最終状態で他階に同一idの中心線が1本だけ残る（R7）', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // 同軸にもう1本（isLastGridOnAxis対策）
  const clId = cl.id;

  const saveFloorFn = async () => {};
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherGraph.plane.id ? otherGraph : null);
  try {
    // 1回目: 降格
    const d1 = await demoteGridToCenterWithUndo(graph, project, cl, { saveFloorFn });
    assert.equal(d1.toast, null);
    assert.equal(graph.shapeMap.has(clId), true);
    assert.equal(otherGraph.shapeMap.has(clId), true, '他階へ複製される');

    // 2回目: 昇格（他階の同一id複製が重複拒否せず回収される）
    const p1r = await promoteCenterToGridWithUndo(graph, project, graph.shapeMap.get(clId), { saveFloorFn });
    assert.equal(p1r.toast, null);
    assert.equal(project.structGraph.shapeMap.has(clId), true);
    assert.equal(graph.shapeMap.has(clId), false);
    assert.equal(otherGraph.shapeMap.has(clId), false, '複製は回収される');

    // 3回目: 再度降格
    const d2 = await demoteGridToCenterWithUndo(graph, project, project.structGraph.shapeMap.get(clId), { saveFloorFn });
    assert.equal(d2.toast, null);
    assert.equal(graph.shapeMap.has(clId), true);
    assert.equal(otherGraph.shapeMap.has(clId), true);
    assert.equal(otherGraph.centerLines.filter(c => c.id === clId).length, 1, '最終状態でp2に同一idの中心線が1本だけ');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('promoteCenterToGridWithUndo: undoで他階の複製が復活し、redoで再び回収される（saveFloorFn記録で観測。R9）', async () => {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { graph: otherGraph } = project.addPlane(3000, '2階', 'p2');
  const otherPlane = otherGraph.plane;
  const cl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH });
  otherGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, cl.id);
  const clId = cl.id;

  const saved = [];
  const saveFloorFn = async (planeId, bytes) => { saved.push({ planeId, bytes }); };
  // saveFloorFnで受け取ったバイト列を、peekと同じ手順（PlanGraph+_structGraph差し込み+restoreGraph）で
  // 復号して中身を確認する（otherGraphは生きた同一インスタンスのため、そのshapeMapでは undo/redo の
  // 書き戻しを観測できない——非アクティブ階はIDB書込のみが正であり、amendFloorUndoRecordsも
  // saveFloorFn呼び出しのみを行い、生きたotherGraphオブジェクト自体は書き換えない）。
  const decode = (bytes) => {
    const tmp = new PlanGraph(otherPlane);
    tmp._structGraph = project.structGraph;
    restoreGraph(tmp, bytes);
    return tmp;
  };

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => (plane.id === otherPlane.id ? otherGraph : null);
  try {
    const { toast } = await promoteCenterToGridWithUndo(graph, project, cl, { saveFloorFn });
    assert.equal(toast, null);
    assert.equal(saved.length, 1, '昇格確定時に1回保存される');
    assert.equal(decode(saved[0].bytes).shapeMap.has(clId), false, '昇格直後の保存バイトは複製回収後の状態');

    saved.length = 0;
    undoManager.undo();
    assert.equal(saved.length, 1, 'undoでp2への書き戻しが記録される');
    assert.equal(saved[0].planeId, otherPlane.id);
    assert.equal(decode(saved[0].bytes).shapeMap.has(clId), true, 'undoで書き戻すバイトは複製が復活した状態');

    saved.length = 0;
    undoManager.redo();
    assert.equal(saved.length, 1, 'redoでp2への書き戻しが記録される');
    assert.equal(decode(saved[0].bytes).shapeMap.has(clId), false, 'redoで書き戻すバイトは複製が回収された状態');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- demoteGridToCenterWithUndo: 複製→移籍の順序（案A、2026-09-17裁定）----
// 上のR7/R9等は floorSwapManager.peek を「生きた他階グラフをそのまま返す」スタブに差し替えている
// ため、graphSnapshot.js の restoreGraph（axisCLの id 解決）を経由しない——本番の peek は毎回
// IDBのバイト列から PlanGraph を作り直す（FloorSwapManager.js peek 参照）。以下は本番と同型の
// peek（`new PlanGraph(plane)` + `_structGraph = project.structGraph` + `restoreGraph`）で、
// 他階の壁がその通り芯を id 参照している場合にだけ再現するリグレッション
// （複製フェーズより先に本体を移籍すると、複製のため他階を peek した時点で通り芯が
// project.structGraph に無く、壁の axisCL が resolveCL で解決できず復元時に捨てられる）を検証する。

// 2階建て・structGraph に perp軸(Y)の通り芯2本＋対象軸(V)の通り芯2本（isLastGridOnAxis対策）を
// 持つ最小構成を作る共通ヘルパ。
function makeTwoFloorsWithGridCL() {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y3 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  return { project, p1, p2, y0, y3, cl };
}

// 本番同型 peek（IDBの代わりに Map ストアを読む）＋ saveFloorFn（Map ストアへ書く）を差し替える共通ヘルパ。
function withProductionPeek(project, store, fn) {
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

// store に保存されたバイト列を、peek と同じ手順で復号する（decode ヘルパは saveFloorFn 観測テストで前例あり）。
function decodeFloor(project, plane, bytes) {
  const tmp = new PlanGraph(plane);
  tmp._structGraph = project.structGraph;
  if (bytes) restoreGraph(tmp, bytes);
  return tmp;
}

test('demoteGridToCenterWithUndo: 他階でその通り芯を軸にする壁・開口は降格後も残り、軸は複製された中心線に解決される（本番同型peek）', async () => {
  const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;

  const wall = p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });
  p2.addOpening(cl, 1, true, y0, 500, 800, OpeningCategory.FITTING, 'singleSwing', {});
  const wallId = wall.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  const { toast } = await withProductionPeek(project, store, () =>
    demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn })
  );

  assert.equal(toast, null);

  const decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
  assert.equal(decoded.walls.length, 1, '他階の壁は降格後も残る');
  assert.equal(decoded.walls[0].id, wallId);
  assert.equal(decoded.walls[0].axisCL.id, clId, '壁の軸は複製された中心線（同一id）に解決される');
  assert.equal(decoded.walls[0].axisCL.labeled, false, '複製された中心線はlabeled:false（通り芯ではない）');
  assert.equal(decoded.openings.length, 1, '他階の開口も降格後も残る');
});

test('demoteGridToCenterWithUndo: 降格→昇格→降格の往復（本番同型peek）で他階の壁が3回とも残り、昇格後は structGraph 側の通り芯に解決される', async () => {
  const { project, p1, p2, y0, y3, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;

  const wall = p2.addWall(cl, 0, true, y0, 0, y3, 0, { isExteriorWall: false });
  const wallId = wall.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async (planeId, bytes) => { store.set(planeId, bytes); };

  await withProductionPeek(project, store, async () => {
    // 1回目: 降格
    const d1 = await demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn });
    assert.equal(d1.toast, null);
    let decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.walls.length, 1, '降格後も壁は残る（1回目）');
    assert.equal(decoded.walls[0].id, wallId);
    assert.equal(decoded.walls[0].axisCL.id, clId);
    assert.equal(decoded.walls[0].axisCL.labeled, false, '降格後は複製（中心線）に解決される');

    // 2回目: 昇格
    const promoted = p1.shapeMap.get(clId);
    const p2r = await promoteCenterToGridWithUndo(p1, project, promoted, { saveFloorFn });
    assert.equal(p2r.toast, null);
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.walls.length, 1, '昇格後も壁は残る（2回目）');
    assert.equal(decoded.walls[0].id, wallId);
    assert.equal(decoded.walls[0].axisCL.id, clId);
    assert.equal(decoded.walls[0].axisCL.labeled, true, '昇格後はstructGraph側の通り芯に解決される');
    assert.equal(decoded.shapeMap.has(clId), false, '昇格後は他階の複製自体は回収されている');

    // 3回目: 再度降格
    const clAfterPromote = project.structGraph.shapeMap.get(clId);
    const d2 = await demoteGridToCenterWithUndo(p1, project, clAfterPromote, { saveFloorFn });
    assert.equal(d2.toast, null);
    decoded = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decoded.walls.length, 1, '再度の降格後も壁は残る（3回目）');
    assert.equal(decoded.walls[0].id, wallId);
    assert.equal(decoded.walls[0].axisCL.id, clId);
    assert.equal(decoded.walls[0].axisCL.labeled, false);
  });
});

test('demoteGridToCenterWithUndo: undoで他階の複製が消えredoで再び複製される（saveFloorFn記録のバイト列を復号して観測。本番同型peek）', async () => {
  const { project, p1, p2, cl } = makeTwoFloorsWithGridCL();
  const clId = cl.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saved = [];
  const saveFloorFn = async (planeId, bytes) => { saved.push({ planeId, bytes }); store.set(planeId, bytes); };

  await withProductionPeek(project, store, async () => {
    const { toast } = await demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn });
    assert.equal(toast, null);
    assert.equal(saved.length, 1, '降格確定時に1回保存される');
    assert.equal(decodeFloor(project, p2.plane, saved[0].bytes).shapeMap.has(clId), true, '降格直後の保存バイトは複製後の状態');

    saved.length = 0;
    undoManager.undo();
    assert.equal(saved.length, 1, 'undoでp2への書き戻しが記録される');
    assert.equal(decodeFloor(project, p2.plane, saved[0].bytes).shapeMap.has(clId), false, 'undoで書き戻すバイトは複製前の状態');

    saved.length = 0;
    undoManager.redo();
    assert.equal(saved.length, 1, 'redoでp2への書き戻しが記録される');
    assert.equal(decodeFloor(project, p2.plane, saved[0].bytes).shapeMap.has(clId), true, 'redoで書き戻すバイトは複製後の状態');
  });
});

test('demoteGridToCenterWithUndo: 複製フェーズの2階目でsaveFloorFnがthrowしたら、1階目はbeforeで書き戻され、自階・structGraphは未変更、undoは積まれず、rejectする', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  const { graph: p3 } = project.addPlane(6000, '3階', 'p3');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const clId = cl.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)], [p3.plane.id, serializeGraph(p3)]]);
  const calls = [];
  const saveFloorFn = async (planeId, bytes) => {
    calls.push(planeId);
    if (planeId === p3.plane.id) throw new Error('p3 save failed');
    store.set(planeId, bytes);
  };
  const beforeTop = undoManager.peekUndo();

  await withProductionPeek(project, store, async () => {
    await assert.rejects(() => demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn }), /p3 save failed/);

    assert.equal(project.structGraph.shapeMap.has(clId), true, 'structGraph側の通り芯は未変更');
    assert.equal(p1.shapeMap.has(clId), false, '自階は未変更');
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');

    assert.equal(calls.filter(id => id === p2.plane.id).length, 2, 'p2は複製→ロールバックの2回saveFloorFnが呼ばれる');
    assert.equal(calls.filter(id => id === p3.plane.id).length, 1, 'p3は複製の1回（例外で失敗）だけ');

    const decodedP2 = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decodedP2.shapeMap.has(clId), false, 'p2はロールバックされ複製が残らない（beforeに書き戻された）');
  });
});

test('demoteGridToCenterWithUndo: 複製後にapplyDemoteToCenterがエラーを返したら他階の複製も巻き戻り、自階・structGraph・undoは未変更でトーストだけ返す', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const clId = cl.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  let intruded = false;
  // IDB待ち（saveFloorFn の await）の間に、自階の同座標へ中心線が割り込み追加される状況を模擬する
  // → 複製は済んでいるが applyDemoteToCenter が ERR_CL_DUPLICATE('center') を返す経路。
  const saveFloorFn = async (planeId, bytes) => {
    store.set(planeId, bytes);
    if (!intruded) {
      intruded = true;
      p1.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH, lineType: 'center' });
    }
  };
  const beforeTop = undoManager.peekUndo();

  await withProductionPeek(project, store, async () => {
    const { toast } = await demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn });

    assert.equal(toast, ERR_CL_DUPLICATE('center'));
    assert.equal(project.structGraph.shapeMap.has(clId), true, 'structGraph側の通り芯は未変更');
    assert.equal(p1.shapeMap.has(clId), false, '自階へは移籍していない');
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
    const decodedP2 = decodeFloor(project, p2.plane, store.get(p2.plane.id));
    assert.equal(decodedP2.shapeMap.has(clId), false, 'p2の複製はロールバックされている');
  });
});

test('demoteGridToCenterWithUndo: ロールバックの書き戻しも失敗したら元の例外がそのままrejectされ、自階・structGraph・undoは未変更', async () => {
  const project = new Project('proj', 'test');
  const { graph: p1 } = project.addPlane(0,    '1階', 'p1');
  const { graph: p2 } = project.addPlane(3000, '2階', 'p2');
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const cl = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 5000, { labeled: true, discipline: Discipline.STRUCT }); // isLastGridOnAxis対策
  const clId = cl.id;

  const store = new Map([[p2.plane.id, serializeGraph(p2)]]);
  const saveFloorFn = async () => { throw new Error('save failed'); }; // 複製もロールバックも常に失敗
  const beforeTop = undoManager.peekUndo();

  await withProductionPeek(project, store, async () => {
    await assert.rejects(() => demoteGridToCenterWithUndo(p1, project, cl, { saveFloorFn }), /save failed/);

    assert.equal(project.structGraph.shapeMap.has(clId), true, 'structGraph側の通り芯は未変更');
    assert.equal(p1.shapeMap.has(clId), false, '自階は未変更');
    assert.equal(undoManager.peekUndo(), beforeTop, 'undoは積まれない');
  });
});
