// wallRefresh.js（refreshWallsAllFloors）の単体テスト。
// 壁の再生成をFinishModeStateから独立させる計画のステップ4: 仕上げモードを開かずに主構造・
// 階別構造・下地材コードを変えても、次の境界（仕上げ脱出／構造脱出／読込み）で鍵不一致の
// 全階の壁が作り直され、梁芯・柱が同じバッチで追従することを確認する。
//
// floorSwapManager.peek はIndexedDBに依存するため、注入可能な opts.peek/opts.saveFloorFn
// （wallRefresh.js自身のテスト用差し替え口）を使う。reflectStructuralToOtherFloors・
// recomputeActiveStructural（structural/structuralOrchestration.js）は内部で直接
// floorSwapManager.peek のシングルトンを呼ぶため、他階を含むテストはシングルトンの
// floorSwapManager.peek も一時的に差し替える（wallBeamAxes.test.js・centerLineFloorSync.test.js
// と同じ手法。try/finallyで必ず復元する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Project, CenterLineType, Discipline, StructuralMaterialType } from './core.js';
import { undoManager } from './undoManager.js';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import { refreshWallsAllFloors } from './wallRefresh.js';
import { regenerateWalls, loadMaterialMap } from './finish/wallRegeneration.js';
import { wallFreshnessKey } from './finish/wallFreshnessKey.js';
import { recomputeStructuralForGraph } from './structural/structuralRecompute.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structural/structureRules.js';

function makeSinglePlaneProject() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

function addRectRoom(graph, name = '部屋A') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  return graph.addRoom(new Set([key]), name);
}

// ---- S4-1裁定（壁0本・鍵nullの階はsweep対象外）により、壁0本・鍵nullの「未脱出」フィクスチャは
// もう refreshWallsAllFloors で壁を持てない。「一度は仕上げモードを通って壁を持った階」を
// 直接 regenerateWalls＋鍵書込みで再現する（finishBoundary.js を経由すると、その内部の
// refreshWallsAllFloors【skipActive:true】呼び出しが他階へ波及し実IDBに触れてしまうため、
// より低レベルの原型プリミティブ2つだけを使う）。
async function seedInitialWalls(graph, project) {
  const materialMap = await loadMaterialMap();
  await regenerateWalls(graph, { materialMap, stairUnderEntries: [], extraStairOpenings: [] });
  graph.setWallFreshnessKey(wallFreshnessKey(graph, project));
}

// ---- 1. 鍵一致なら何もしない ----
test('refreshWallsAllFloors: 鍵一致（保存キー===現在キー）なら何もしない（壁id不変・undo空・saveFloor呼ばれず）', async () => {
  const { project, graph } = makeSinglePlaneProject();
  addRectRoom(graph);
  graph.setWallFreshnessKey(wallFreshnessKey(graph, project)); // 事前に一致させておく
  const undoBefore = undoManager.peekUndo();
  let saveCalled = false;

  const result = await refreshWallsAllFloors(project, { pushUndo: true, saveFloorFn: async () => { saveCalled = true; } });

  assert.deepEqual(result.changedPlaneIds, []);
  assert.equal(graph.walls.length, 0, '壁は一切生成されない（鍵一致でregenerateWalls自体を呼ばない）');
  assert.equal(undoManager.peekUndo(), undoBefore, 'undoエントリは増えない');
  assert.equal(saveCalled, false, 'saveFloorは呼ばれない');
});

// ---- 2. 主構造を変える→自階の壁が再生成され鍵が更新・undoで壁と鍵が戻る ----
test('refreshWallsAllFloors: 主構造（structureOverride）を変えると自階の壁が再生成され鍵が更新される。undoで壁・鍵が変更前へ戻る', async () => {
  const { project, graph } = makeSinglePlaneProject();
  addRectRoom(graph);
  await seedInitialWalls(graph, project); // 前提: 一度は仕上げモードを通って壁を持った階にする（S4-1）
  const wallsBefore = graph.walls.length;
  assert.ok(wallsBefore > 0, '前提: 初期壁が生成されている');
  const keyBefore = graph.wallFreshnessKey;
  const undoBefore = undoManager.peekUndo();

  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const result = await refreshWallsAllFloors(project, { pushUndo: true });

  assert.deepEqual(result.changedPlaneIds, ['p1']);
  assert.ok(graph.walls.length > 0, '壁が再生成されている');
  assert.ok(graph.wallFreshnessKey?.startsWith('v1|'), '鍵が更新されている');
  assert.notEqual(graph.wallFreshnessKey, keyBefore);

  // 主構造の変更は壁交点柱の生成も伴うため、undoManagerには「壁+鍵」のエントリと
  // 「構造再計算（柱）」のエントリが最大2件積まれうる（recomputeActiveStructuralが
  // changed:trueのときだけ別エントリを積む既存の仕様。finishBoundary.js経由の脱出でも
  // 同様に2エントリになる）。積まれた分だけundoすれば壁・鍵・柱・structureOverrideが
  // すべて変更前の状態へ戻ることを確認する（「1エントリで戻る」を主張するのではなく、
  // 「正しく戻る」ことを確認する）。
  let guard = 0;
  while (undoManager.peekUndo() !== undoBefore && guard < 10) { undoManager.undo(); guard++; }
  assert.ok(guard > 0 && guard <= 2, `想定内の件数（1〜2件）でundoスタックが変更前まで戻る（実際:${guard}件）`);
  assert.equal(graph.wallFreshnessKey, keyBefore, 'undoで鍵が変更前に戻る');
  assert.equal(graph.walls.length, wallsBefore, 'undoで壁が変更前の本数に戻る');
});

// ---- 2b. 各階柱寸法（graph.woodColumnWidthMm。ステップ4 C-2）を変える→鍵不一致→壁が再生成され
// 鍵が更新される。undoで壁・鍵が変更前へ戻る（主構造変更と同じ鮮度キー設計）----
test('refreshWallsAllFloors: 各階柱寸法（graph.woodColumnWidthMm）を変えると自階の壁が再生成され鍵が更新される。undoで壁・鍵が変更前へ戻る', async () => {
  const { project, graph } = makeSinglePlaneProject();
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE; // 在来木造をあらかじめ確定させておく（col=に柱寸が乗る前提）
  addRectRoom(graph);
  await seedInitialWalls(graph, project); // 前提: 一度は仕上げモードを通って壁を持った階にする（S4-1）
  const wallsBefore = graph.walls.length;
  assert.ok(wallsBefore > 0, '前提: 初期壁が生成されている');
  const keyBefore = graph.wallFreshnessKey;
  assert.ok(keyBefore.includes('col=WOOD-120x120'), '前提: 鍵に既定の柱寸（120角）が乗っている');
  const undoBefore = undoManager.peekUndo();

  graph.setWoodColumnWidthMm(105);
  const result = await refreshWallsAllFloors(project, { pushUndo: true });

  assert.deepEqual(result.changedPlaneIds, ['p1']);
  assert.ok(graph.walls.length > 0, '壁が再生成されている');
  assert.ok(graph.wallFreshnessKey?.includes('col=WOOD-105x105'), '鍵のcol=が105寸へ更新されている');
  assert.notEqual(graph.wallFreshnessKey, keyBefore);

  // 柱寸変更は壁交点柱・柱同寸下地材の再計算も伴うため、主構造変更と同じく最大2エントリになりうる
  // （「1エントリで戻る」ではなく「正しく戻る」ことを確認する。上のstructureOverrideテストと同じ規律）。
  let guard = 0;
  while (undoManager.peekUndo() !== undoBefore && guard < 10) { undoManager.undo(); guard++; }
  assert.ok(guard > 0 && guard <= 2, `想定内の件数（1〜2件）でundoスタックが変更前まで戻る（実際:${guard}件）`);
  assert.equal(graph.wallFreshnessKey, keyBefore, 'undoで鍵が変更前に戻る');
  assert.equal(graph.walls.length, wallsBefore, 'undoで壁が変更前の本数に戻る');
});

// ---- 3. 他階: 鍵不一致の非アクティブ階だけsaveFloorされる。一致階は保存されない ----
test('refreshWallsAllFloors【他階】: 鍵不一致の非アクティブ階だけsaveFloorされ、鍵一致の階は保存されない', async () => {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3');
  project.activePlaneId = 'p1';
  addRectRoom(g1, '1F'); addRectRoom(g2, '2F'); addRectRoom(g3, '3F');

  const peekMap = { p1: g1, p2: g2, p3: g3 };
  const peek = async (plane) => peekMap[plane.id] ?? null;
  const savedFloors = [];
  const saveFloorFn = async (planeId) => { savedFloors.push(planeId); };

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    // warmup: 全階の鍵を揃える（実運用の「一度は境界を通った状態」に相当）。
    await refreshWallsAllFloors(project, { pushUndo: false, peek, saveFloorFn });
    savedFloors.length = 0;

    // p2だけ鍵を壊す（p3は一致のまま）。
    g2.setWallFreshnessKey('force-mismatch');
    const result = await refreshWallsAllFloors(project, { pushUndo: false, peek, saveFloorFn });

    assert.deepEqual(result.changedPlaneIds, ['p2']);
    assert.deepEqual(savedFloors, ['p2'], '鍵不一致のp2だけsaveFloorされ、p3（一致）は保存されない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 4. 在来へ切替→conformWoodBackingで下地コードが柱同寸×30になり、壁厚が柱寸法に一致 ----
test('refreshWallsAllFloors: 在来木造へ切替えると下地材コードが柱同寸×30（conformWoodBacking）になり、壁のbackingDepthが柱寸法(120)に一致する', async () => {
  const { project, graph } = makeSinglePlaneProject();
  addRectRoom(graph);
  await seedInitialWalls(graph, project); // 前提: 一度は仕上げモードを通って壁を持った階にする（S4-1）
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  await refreshWallsAllFloors(project, { pushUndo: false });

  assert.equal(graph.exteriorWallBacking, '111111111240', '柱120角×30（柱同寸×30）の材コード');
  assert.equal(graph.interiorWallBacking, '111111111240');
  // 単室のみのフィクスチャでは全周が外壁になり、対称壁（backingOffset未指定）は
  // backingDepth が明示されない（Wall.backingRangeのフォールバック式で導出される）ため、
  // backingRange（下地帯の実範囲）の幅で壁厚を確認する。
  const exteriorWall = graph.walls.find(w => w.isExteriorWall);
  assert.ok(exteriorWall, '外壁が生成されている');
  const range = exteriorWall.backingRange;
  assert.ok(range, '下地帯（backingRange）が導出できる');
  assert.equal(Math.round(range.hi - range.lo), 120, '壁厚（下地帯の幅）が柱寸法120に一致する');
});

// ---- 5. 壁再生成後に自階の構造再計算が走り、壁交点柱の本数が前後で不変 ----
test('refreshWallsAllFloors: 主構造を切り替えて戻しても壁交点柱の本数は増減しない', async () => {
  const { project, graph } = makeSinglePlaneProject();
  addRectRoom(graph);
  await seedInitialWalls(graph, project); // 前提: 一度は仕上げモードを通って壁を持った階にする（S4-1）

  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  await refreshWallsAllFloors(project, { pushUndo: false });
  const columnsWood = graph.columns.length;
  assert.ok(columnsWood > 0, '前提: 柱が生成されている');

  graph.structureOverride = null; // 建物全体既定値（未定）へ戻す
  await refreshWallsAllFloors(project, { pushUndo: false });
  const columnsUnspecified = graph.columns.length;

  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE; // 在来へ復帰
  await refreshWallsAllFloors(project, { pushUndo: false });
  const columnsBack = graph.columns.length;

  assert.equal(columnsBack, columnsWood, '在来⇄未定を往復しても柱本数は変わらない');
  assert.equal(columnsUnspecified, columnsWood, 'このフィクスチャでは未定でも同じ交点に柱が立つ（実測）');
});

// ---- S4-1回帰（自階）: 壁0本・鍵null（未脱出階）はsweep対象外 ----
// 裁定案A: graph.wallFreshnessKey==null && graph.walls.length===0 の階は「まだ一度も壁を
// 持ったことのない階」としてsweep対象外にする（conformWoodBackingも走らせない・鍵も書かない）。
// woodAutoFill.js の「壁0本の階は柱を保全」裁定（2026-09-14）と整合させるための回帰テスト
// ——このガードが無いと、壁のあるコード経路に切り替わったとみなされ既存のauto柱が無通知に
// 撤去される（QA実測: moku1.stq 3階で通り芯交点auto柱35→4）。
test('【S4-1回帰・自階】refreshWallsAllFloors: 壁0本・鍵null（未脱出階）の自階はsweep対象外——既存のauto柱を保全し壁も鍵も変えない', async () => {
  const { project, graph } = makeSinglePlaneProject();
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  // 実データのstairVoidのみの階（壁0本）でも既存の柱が残っているケースを再現する。
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,   { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', x0, y0);
  assert.equal(graph.wallFreshnessKey, null, '前提: 未脱出階（鍵null）');
  assert.equal(graph.walls.length, 0, '前提: 壁0本');

  const result = await refreshWallsAllFloors(project, {
    pushUndo: true,
    saveFloorFn: async () => { throw new Error('未脱出階の自階はsaveFloorされないはず'); },
  });

  assert.deepEqual(result.changedPlaneIds, [], '未脱出階はsweep対象外のためchangedPlaneIdsに含まれない');
  assert.equal(graph.walls.length, 0, '壁は生成されない');
  assert.equal(graph.columns.length, 1, '既存のauto柱が保全される（woodAutoFill.js 2026-09-14裁定と整合）');
  assert.equal(graph.wallFreshnessKey, null, '鍵も書かれない');
});

// ---- S4-1回帰（他階）: 他階が壁0本・鍵null（未脱出階）でもsweep対象外 ----
test('【S4-1回帰・他階】refreshWallsAllFloors: 他階が壁0本・鍵null（未脱出階）ならsweep対象外——saveFloorされず既存auto柱も保全される', async () => {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1'); // アクティブ（鍵一致・無変化）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 未脱出階（壁0本・鍵null）
  project.activePlaneId = 'p1';
  addRectRoom(g1, '1F');
  await seedInitialWalls(g1, project); // g1は鍵一致（変化なし）のままにする——他階側の判定だけを見る

  const x0 = g2.addCenterLine(CenterLineType.VERTICAL, 0,   { labeled: false, discipline: Discipline.ARCH });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  g2.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', x0, y0);
  assert.equal(g2.wallFreshnessKey, null, '前提: p2は未脱出階（鍵null）');
  assert.equal(g2.walls.length, 0, '前提: p2は壁0本');

  const peekMap = { p1: g1, p2: g2 };
  const peek = async (plane) => peekMap[plane.id] ?? null;
  const savedFloors = [];
  const saveFloorFn = async (planeId) => { savedFloors.push(planeId); };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const result = await refreshWallsAllFloors(project, { pushUndo: false, peek, saveFloorFn });
    assert.deepEqual(result.changedPlaneIds, [], 'p1は鍵一致・p2は未脱出階のためどちらもchangedPlaneIdsに含まれない');
    assert.deepEqual(savedFloors, [], 'p2はsaveFloorされない');
    assert.equal(g2.walls.length, 0, 'p2の壁は生成されない');
    assert.equal(g2.columns.length, 1, 'p2の既存auto柱は保全される');
    assert.equal(g2.wallFreshnessKey, null, 'p2の鍵も書かれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- QA V4: 壁0本でも鍵が既にある階はsweep対象（S4-1ガードとの境界線）----
// S4-1ガードは「wallFreshnessKey==null かつ 壁0本」の階だけを対象外にする。鍵が既にある
// （null ではない）壁0本の階（実運用では屋外部屋のみ等、regenerateWallsがregenerated:trueでも
// 壁0本になりうる経路がある）はsweep対象のまま——conformWoodBacking・regenerateWallsは走り、
// 鍵は現在の入力に基づき更新される。壁が無いためwoodAutoFill.jsの「壁0本の階は柱を保全」
// （2026-09-14裁定）は独立してそのまま効き、柱本数は変わらない。
test('【QA V4】refreshWallsAllFloors: 壁0本だが鍵ありの階はsweep対象——structureOverride変更で鍵が更新され、壁0本のまま柱本数は変わらない', async () => {
  const { project, graph } = makeSinglePlaneProject();
  graph.setWallFreshnessKey('seed-key-before'); // null ではない＝S4-1ガードの対象外
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  // 壁0本でも既存の柱が残っているケースを再現する（S4-1回帰テストと同じ設定）。
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,   { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  graph.addColumn(StructuralMaterialType.WOOD, 'SEC-COL', x0, y0);
  assert.notEqual(graph.wallFreshnessKey, null, '前提: 鍵は既にある');
  assert.equal(graph.walls.length, 0, '前提: 壁0本（部屋が無い）');
  const columnsBefore = graph.columns.length;

  const result = await refreshWallsAllFloors(project, { pushUndo: false });

  assert.deepEqual(result.changedPlaneIds, ['p1'], '壁0本でも鍵ありの階はsweep対象になる（S4-1ガードとは別条件）');
  assert.notEqual(graph.wallFreshnessKey, 'seed-key-before', '鍵は現在の入力（structureOverride等）に基づき更新される');
  assert.equal(graph.walls.length, 0, '部屋が無いため壁は0本のまま');
  assert.equal(graph.columns.length, columnsBefore, '壁が無いためwoodAutoFill.jsの柱保全ガードが効き柱本数は変わらない');
});

// ---- S4-2: 他階変更起因で自階（アクティブ）構造が再計算されたとき、pushUndo:falseでも
// pushActiveStructuralUndo（既定true）でundoエントリが積まれる ----
// finishBoundary.js は自階の壁を既に自分で処理済みのため pushUndo:false で呼ぶが、他階の
// 変更を受けてアクティブ階の構造（wallBeamAxes:'selfAndBelow'の壁由来梁芯アンカー等）が
// 再計算された分のundoまで殺してはいけない（裁定）。
test('【S4-2】refreshWallsAllFloors: pushUndo:falseでもpushActiveStructuralUndo既定(true)なら自階の構造再計算のundoが積まれる。falseにすれば積まれない', async () => {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1'); // 他階（無指定構造。柱を生成しないため実IDBに触れない）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // アクティブ（在来木造）
  project.activePlaneId = 'p2';
  addRectRoom(g1, '1F');
  addRectRoom(g2, '2F');
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const peekMap = { p1: g1, p2: g2 };
  const peek = async (plane) => peekMap[plane.id] ?? null;
  const saveFloorFn = async () => {};
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    await seedInitialWalls(g1, project);
    await seedInitialWalls(g2, project);
    // g2の構造（auto柱）を実IDB保存を経由せず暖機する（recomputeInactiveStructuralのsaveFloor
    // 未注入問題を回避するため、g1は無指定構造のまま＝柱を持たずreflectStructuralToOtherFloors
    // 内のrecomputeInactiveStructuralがchanged:falseになるようにしておく）。
    await recomputeStructuralForGraph(g2, project, TRADITIONAL_WOOD_STRUCTURE);
    const columnsStable = g2.columns.length;
    assert.ok(columnsStable > 0, '前提: g2に柱が生成されている');

    // ケースA: pushActiveStructuralUndo既定(true)
    g1.setWallFreshnessKey('force-mismatch-p1-a'); // p1側だけ鍵を人工的に不一致にする（sweep起動条件）
    const autoColA = g2.columns.find(c => c.dimensionStatus === 'auto' && c.role !== 'foundation');
    assert.ok(autoColA, '前提: g2にauto柱がある');
    g2.columnMap.delete(autoColA.id); // g2自身の構造が「ずれている」状態を作る
    const undoBeforeA = undoManager.peekUndo();

    const resultA = await refreshWallsAllFloors(project, { skipActive: true, pushUndo: false, peek, saveFloorFn });

    assert.ok(resultA.changedPlaneIds.includes('p1'), '前提: p1（他階）の変更でsweepが起動している');
    assert.equal(g2.columns.length, columnsStable, '自階の構造再計算で削除した柱が復元される');
    assert.notEqual(undoManager.peekUndo(), undoBeforeA,
      'pushUndo:falseでもpushActiveStructuralUndo既定(true)なら自階の構造再計算のundoが積まれる');
    let guard = 0;
    while (undoManager.peekUndo() !== undoBeforeA && guard < 5) { undoManager.undo(); guard++; }
    assert.equal(g2.columns.length, columnsStable - 1, 'undoで削除した柱が消えた状態へ戻る');
    undoManager.redo();
    assert.equal(g2.columns.length, columnsStable, 'redoで柱が復元された状態へ戻る');

    // ケースB: pushActiveStructuralUndo:false を明示すれば積まれない
    g1.setWallFreshnessKey('force-mismatch-p1-b');
    const autoColB = g2.columns.find(c => c.dimensionStatus === 'auto' && c.role !== 'foundation');
    g2.columnMap.delete(autoColB.id);
    const undoBeforeB = undoManager.peekUndo();

    const resultB = await refreshWallsAllFloors(project, {
      skipActive: true, pushUndo: false, pushActiveStructuralUndo: false, peek, saveFloorFn,
    });

    assert.ok(resultB.changedPlaneIds.includes('p1'));
    assert.equal(g2.columns.length, columnsStable, '柱自体は再計算で復元される（undoの有無とは別軸）');
    assert.equal(undoManager.peekUndo(), undoBeforeB,
      'pushActiveStructuralUndo:falseなら自階の構造再計算のundoは積まれない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- ステップ5: store.js bootReady と同じ組合せ（pushUndo:false・pushActiveStructuralUndo:false）
// では、自階・他階どちらの変更でもundoスタックが完全に空のまま（読込み時は undo 対象外・
// dirty にするだけの裁定2026-09-15）----
test('【ステップ5】refreshWallsAllFloors: pushUndo:falseかつpushActiveStructuralUndo:false（bootReadyと同じ組合せ）ではundoスタックが変わらない', async () => {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1'); // アクティブ
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 他階
  project.activePlaneId = 'p1';
  addRectRoom(g1, '1F'); addRectRoom(g2, '2F');
  await seedInitialWalls(g1, project);
  await seedInitialWalls(g2, project);
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE; // 自階も鍵不一致にする
  g2.setWallFreshnessKey('force-mismatch-p2'); // 他階も鍵不一致にする

  const peekMap = { p1: g1, p2: g2 };
  const peek = async (plane) => peekMap[plane.id] ?? null;
  const saveFloorFn = async () => {};
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  const undoBefore = undoManager.peekUndo();
  try {
    const result = await refreshWallsAllFloors(project, {
      pushUndo: false, pushActiveStructuralUndo: false, peek, saveFloorFn,
    });
    assert.deepEqual(result.changedPlaneIds.sort(), ['p1', 'p2'], '前提: 自階・他階とも再生成されている');
    assert.equal(undoManager.peekUndo(), undoBefore, 'undoスタックは完全に空のまま（増減なし）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 6a. 失敗系: materialMapのロード失敗はスキップして何もしない ----
// 前提として「一度は仕上げモードを通って壁を持った階」にしてから鍵不一致を作る（S4-1ガードにより
// 壁0本・鍵nullのフィクスチャだと、materialMapに触れる前にガードでskipされ検証にならないため）。
test('【失敗系】refreshWallsAllFloors: materialMapのロードに失敗したら壁に一切触れず、changedPlaneIdsは空', async () => {
  const { project, graph } = makeSinglePlaneProject();
  addRectRoom(graph);
  await seedInitialWalls(graph, project);
  const wallsBefore = graph.walls.length;
  const keyBefore = graph.wallFreshnessKey;
  assert.ok(wallsBefore > 0, '前提: 壁が生成されている');
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE; // 鍵不一致を作る（本来なら再生成されるはず）

  const result = await refreshWallsAllFloors(project, {
    pushUndo: false,
    loadMaterialMapFn: async () => { throw new Error('boom'); },
  });

  assert.deepEqual(result.changedPlaneIds, []);
  assert.equal(graph.walls.length, wallsBefore, 'materialMap無しでは壁を一切作り直さない（本数不変）');
  assert.equal(graph.wallFreshnessKey, keyBefore, '鍵も書き換えない（壁が実際には変わっていないため）');
});

// ---- QA ステップ5: materialMapは鍵不一致の階が無ければロードされない（遅延ロード）。
// 不一致があれば、複数階分あっても1回だけロードされる ----
test('【QAステップ5】refreshWallsAllFloors: 鍵一致のみの全階ではloadMaterialMapFnが呼ばれず、鍵不一致があれば1回だけ呼ばれる', async () => {
  // (a) 全階鍵一致 → loadMaterialMapFnは一度も呼ばれない
  {
    const project = new Project('proj', 'test');
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
    project.activePlaneId = 'p1';
    addRectRoom(g1, '1F'); addRectRoom(g2, '2F');
    await seedInitialWalls(g1, project);
    await seedInitialWalls(g2, project);

    let loadCalls = 0;
    const loadMaterialMapFn = async () => { loadCalls++; return loadMaterialMap(); };
    const peekMap = { p1: g1, p2: g2 };
    const peek = async (plane) => peekMap[plane.id] ?? null;
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
    try {
      const result = await refreshWallsAllFloors(project, { pushUndo: false, peek, loadMaterialMapFn });
      assert.deepEqual(result.changedPlaneIds, [], '前提: 全階鍵一致で無変化');
      assert.equal(loadCalls, 0, '鍵一致のみならmaterialMapは一度もロードされない');
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  }

  // (b) 複数階が鍵不一致 → loadMaterialMapFnは1回だけ呼ばれる（メモ化）
  {
    const project = new Project('proj', 'test');
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
    const { graph: g3 } = project.addPlane(6000, '3階', 'p3');
    project.activePlaneId = 'p1';
    addRectRoom(g1, '1F'); addRectRoom(g2, '2F'); addRectRoom(g3, '3F');
    await seedInitialWalls(g1, project);
    await seedInitialWalls(g2, project);
    await seedInitialWalls(g3, project);
    g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE; // 自階も含め複数階を鍵不一致にする
    g2.setWallFreshnessKey('force-mismatch-p2');
    g3.setWallFreshnessKey('force-mismatch-p3');

    let loadCalls = 0;
    const loadMaterialMapFn = async () => { loadCalls++; return loadMaterialMap(); };
    const peekMap = { p1: g1, p2: g2, p3: g3 };
    const peek = async (plane) => peekMap[plane.id] ?? null;
    const saveFloorFn = async () => {};
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
    try {
      const result = await refreshWallsAllFloors(project, { pushUndo: false, peek, saveFloorFn, loadMaterialMapFn });
      assert.deepEqual(result.changedPlaneIds.sort(), ['p1', 'p2', 'p3'], '前提: 3階とも鍵不一致で再生成される');
      assert.equal(loadCalls, 1, '複数階が不一致でもmaterialMapのロードは1回だけ（メモ化）');
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  }
});

// ---- 6b. 失敗系: peekがnullを返す階はスキップして他階は続行 ----
test('【失敗系】refreshWallsAllFloors: peekがnullを返す階はスキップし、他の鍵不一致階は続行する', async () => {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // peekが失敗する想定の階
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3');
  project.activePlaneId = 'p1';
  addRectRoom(g1, '1F'); addRectRoom(g2, '2F'); addRectRoom(g3, '3F');
  // structureOverride は変えない（未定のまま）——実構造入力（柱の有無）を変えずに鍵だけを
  // 人工的に不一致にする。実構造が変わらなければ reflectStructuralToOtherFloors 内の
  // recomputeInactiveStructural は changed:false のため実IDBの saveFloor（db.js。注入不可）へ
  // 到達しない（このテストの対象は「peek失敗時のスキップ」であり構造再計算ではないため）。

  const fullPeekMap = { p1: g1, p2: g2, p3: g3 };
  const originalPeek = floorSwapManager.peek;
  // シングルトンの floorSwapManager.peek は
  // reflectStructuralToOtherFloors（wallRefresh.js が変更後に呼ぶ既存プリミティブ）が
  // 内部で直接使う——これは今回のテストの対象外（peek失敗のスキップ挙動はwallRefresh.js
  // 自身のループの話）なので、全階を正常に解決できるようにしておく。
  floorSwapManager.peek = async (plane) => fullPeekMap[plane.id] ?? null;
  try {
    const restrictedPeekMap = { p1: g1, p3: g3 }; // p2は意図的に含めない→wallRefresh自身のループ向けにはnull
    const peek = async (plane) => restrictedPeekMap[plane.id] ?? null;
    const savedFloors = [];
    const saveFloorFn = async (planeId) => { savedFloors.push(planeId); };

    // p2・p3を「本来なら再生成が要る」状態にし、wallRefresh自身のループ向けpeek（引数peek）
    // だけがp2でnullを返す状況を作る。
    g2.setWallFreshnessKey('force-mismatch-p2');
    g3.setWallFreshnessKey('force-mismatch-p3');
    const result = await refreshWallsAllFloors(project, { pushUndo: false, peek, saveFloorFn });
    assert.ok(!result.changedPlaneIds.includes('p2'), 'peekがnullのp2はスキップされる');
    assert.ok(result.changedPlaneIds.includes('p3'), 'p3は続行して再生成される');
    assert.deepEqual(savedFloors, ['p3']);
    assert.equal(g2.walls.length, 0, 'p2はスキップされ壁に触れられない（peekできないため直接は変更されない）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- S4-5回帰: peekがthrowする階もnullを返す場合と同じくスキップして他階は続行する ----
test('【S4-5回帰】refreshWallsAllFloors: peekがthrowする階もnull同様スキップし、他の鍵不一致階は続行する', async () => {
  const project = new Project('proj', 'test');
  // p3（最上階）をpeek throwの対象にする——中間・下階の階段コンテキスト解決（resolveStairContext）は
  // 自階より「下」の階だけをpeekするため、最上階をthrowさせれば他階の処理に巻き込まれない
  // （中間階をthrowにすると、その上の階の階段コンテキスト解決が同じpeekでthrowを受けてしまい、
  // このテストが検証したい「サイクル自身のpeekのtry/catch」と別の場所で例外が飛ぶ）。
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3'); // peekがthrowする想定の階（最上階）
  project.activePlaneId = 'p1';
  addRectRoom(g1, '1F'); addRectRoom(g2, '2F'); addRectRoom(g3, '3F');
  // structureOverrideは変えない（未定のまま）——test『失敗系: peekがnullを返す階はスキップ』と
  // 同じ理由で実構造入力は変えず鍵だけ人工的に不一致にする。

  const fullPeekMap = { p1: g1, p2: g2, p3: g3 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => fullPeekMap[plane.id] ?? null;
  try {
    const peek = async (plane) => {
      if (plane.id === 'p3') throw new Error('peek boom');
      return fullPeekMap[plane.id] ?? null;
    };
    const savedFloors = [];
    const saveFloorFn = async (planeId) => { savedFloors.push(planeId); };

    g2.setWallFreshnessKey('force-mismatch-p2');
    g3.setWallFreshnessKey('force-mismatch-p3');
    const result = await refreshWallsAllFloors(project, { pushUndo: false, peek, saveFloorFn });
    assert.ok(!result.changedPlaneIds.includes('p3'), 'peekがthrowするp3はスキップされる');
    assert.ok(result.changedPlaneIds.includes('p2'), 'p2は続行して再生成される');
    assert.deepEqual(savedFloors, ['p2']);
    assert.equal(g3.walls.length, 0, 'p3はスキップされ壁に触れられない（throwを捕捉して継続するため）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- QA V2回帰: saveFloorFnがthrowする階もpeek同様スキップし、他の鍵不一致階は続行する（rejectしない）----
test('【QA V2回帰】refreshWallsAllFloors: saveFloorFnがthrowする階はskipして他階は続行し、全体はrejectしない', async () => {
  const project = new Project('proj', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // saveFloorFnがthrowする想定の階
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3');
  project.activePlaneId = 'p1';
  addRectRoom(g1, '1F'); addRectRoom(g2, '2F'); addRectRoom(g3, '3F');

  const peekMap = { p1: g1, p2: g2, p3: g3 };
  const peek = async (plane) => peekMap[plane.id] ?? null;
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const savedFloors = [];
    const saveFloorFn = async (planeId) => {
      if (planeId === 'p2') throw new Error('save boom');
      savedFloors.push(planeId);
    };

    g2.setWallFreshnessKey('force-mismatch-p2');
    g3.setWallFreshnessKey('force-mismatch-p3');
    const result = await refreshWallsAllFloors(project, { pushUndo: false, peek, saveFloorFn });

    assert.ok(!result.changedPlaneIds.includes('p2'), '保存に失敗したp2はchangedPlaneIdsに含まれない（鍵未更新のまま次回再試行）');
    assert.ok(result.changedPlaneIds.includes('p3'), 'p3は続行して再生成・保存される');
    assert.deepEqual(savedFloors, ['p3']);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 不変条件: App.jsx の runStructuralExitBoundary が refreshWallsAllFloors を呼んでいる ----
test('【不変条件・ステップ4】App.jsx: runStructuralExitBoundary の関数本体が refreshWallsAllFloors を呼び出している', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'App.jsx'), 'utf8');
  const startIdx = appSrc.indexOf('async function runStructuralExitBoundary');
  assert.ok(startIdx >= 0, 'runStructuralExitBoundary が見つからない');
  // 関数本体を波括弧の対応数で抽出する（引数の分割代入 `{ ... } = {}` の直後、
  // `) {` の { から対応する } まで——先頭の { だと引数側の分割代入を拾ってしまう）。
  const parenCloseIdx = appSrc.indexOf(') {', startIdx);
  const braceStart = appSrc.indexOf('{', parenCloseIdx);
  let depth = 0, i = braceStart;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = appSrc.slice(braceStart, i + 1);
  // 行コメントを落として判定する（コメントアウトされた呼び出しを「有効な呼び出し」と
  // 誤検知しないため）。
  const codeOnly = body.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(/refreshWallsAllFloors\(/.test(codeOnly), 'runStructuralExitBoundary の本体に refreshWallsAllFloors( 呼び出しが無い');
});

// ---- 不変条件・S4-3: refreshWallsAllFloors の呼び出しが reflectOtherFloors ガードの内側にある
// （「階切替には足さない」裁定。ガードを外す変異を入れるとこのテストだけが赤くなる想定）----
test('【不変条件・S4-3】App.jsx: refreshWallsAllFloors の呼び出しが if (reflectOtherFloors) ガードの内側にある', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'App.jsx'), 'utf8');
  const startIdx = appSrc.indexOf('async function runStructuralExitBoundary');
  assert.ok(startIdx >= 0, 'runStructuralExitBoundary が見つからない');
  const parenCloseIdx = appSrc.indexOf(') {', startIdx);
  const braceStart = appSrc.indexOf('{', parenCloseIdx);
  let depth = 0, i = braceStart;
  for (; i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = appSrc.slice(braceStart, i + 1);

  const ifIdx = body.indexOf('if (reflectOtherFloors)');
  assert.ok(ifIdx >= 0, 'if (reflectOtherFloors) ガードが見つからない');
  const ifBraceStart = body.indexOf('{', ifIdx);
  let ifDepth = 0, j = ifBraceStart;
  for (; j < body.length; j++) {
    if (body[j] === '{') ifDepth++;
    else if (body[j] === '}') { ifDepth--; if (ifDepth === 0) break; }
  }
  const ifBody = body.slice(ifBraceStart, j + 1);
  const codeOnly = s => s.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');

  assert.ok(/refreshWallsAllFloors\(/.test(codeOnly(ifBody)),
    'refreshWallsAllFloors の呼び出しが if (reflectOtherFloors) ガードの内側に無い');

  const outsideIf = body.slice(0, ifBraceStart) + body.slice(j + 1);
  assert.ok(!/refreshWallsAllFloors\(/.test(codeOnly(outsideIf)),
    'refreshWallsAllFloors の呼び出しが if (reflectOtherFloors) ガードの外にもある（階切替時にも走ってしまう）');
});

// ---- 不変条件: finish/finishBoundary.js が他階向けに refreshWallsAllFloors を呼んでいる ----
// S4-5: App.jsx側と同じ関数本体切り出し方式にし、pushUndo:false・skipActive:trueの値まで固定する。
test('【不変条件・ステップ4／S4-5】finish/finishBoundary.js: runFinishExitBoundary の関数本体が skipActive:true・pushUndo:false で refreshWallsAllFloors を呼んでいる', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'finish/finishBoundary.js'), 'utf8');
  const startIdx = src.indexOf('export async function runFinishExitBoundary');
  assert.ok(startIdx >= 0, 'runFinishExitBoundary が見つからない');
  const parenCloseIdx = src.indexOf(') {', startIdx);
  const braceStart = src.indexOf('{', parenCloseIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(braceStart, i + 1);
  const codeOnly = body.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');

  const callMatch = codeOnly.match(/refreshWallsAllFloors\(project,\s*\{([^}]*)\}\)/);
  assert.ok(callMatch, 'runFinishExitBoundary の本体に refreshWallsAllFloors(project, {...}) 呼び出しが無い');
  assert.match(callMatch[1], /skipActive:\s*true\b/, 'skipActive: true が指定されていない');
  assert.match(callMatch[1], /pushUndo:\s*false\b/, 'pushUndo: false が指定されていない');
});

// ---- 不変条件・ステップ5: store.js の bootReady が読込み時sweepを呼び、changedPlaneIdsを
// 条件にmarkDirtyしている（undo対象外だがdirtyにする裁定2026-09-15）----
test('【不変条件・ステップ5】store.js: bootReady本体がrefreshWallsAllFloorsをpushUndo:falseで呼び、changedPlaneIdsを条件にmarkDirtyしている', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'store.js'), 'utf8');
  const startIdx = src.indexOf('export const bootReady');
  assert.ok(startIdx >= 0, 'bootReady が見つからない');
  const arrowIdx = src.indexOf('=> {', startIdx);
  const braceStart = src.indexOf('{', arrowIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(braceStart, i + 1);
  const codeOnly = body.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');

  const callMatch = codeOnly.match(/refreshWallsAllFloors\(project,\s*\{([^}]*)\}\)/);
  assert.ok(callMatch, 'bootReady の本体に refreshWallsAllFloors(project, {...}) 呼び出しが無い');
  assert.match(callMatch[1], /pushUndo:\s*false\b/, 'pushUndo: false が指定されていない');

  const markDirtyIdx = codeOnly.indexOf('markDirty()');
  assert.ok(markDirtyIdx >= 0, 'markDirty() の呼び出しが無い');
  const before = codeOnly.slice(0, markDirtyIdx);
  const lastIfIdx = before.lastIndexOf('if (');
  assert.ok(lastIfIdx >= 0, 'markDirty() の前にif条件が無い（無条件でmarkDirtyしている）');
  const ifCond = before.slice(lastIfIdx, before.indexOf(')', lastIfIdx) + 1);
  assert.match(ifCond, /changedPlaneIds\.length\s*>\s*0/,
    'markDirty() の条件が「変更があったときだけ」（changedPlaneIds.length > 0）になっていない');
});
