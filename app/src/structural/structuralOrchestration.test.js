// centerLineOps.test.js と同じ方針: ダックタイピングでは undo/serializeGraph・structGraph 連携の
// 実挙動を再現できないため、実 core.js（Plane/PlanGraph/Project）と実 undoManager を使う。
// composition は「下階なし」（graphForCategory→null）のスタブで足りる範囲に限定し、IDB（floorSwapManager
// 経由の indexedDB アクセス）を要しないシナリオだけをここでは検証する（fixture方針は下記コメント参照）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import {
  Project, PlanGraph, Plane, CenterLineType, Discipline, StructuralMaterialType, OpeningCategory,
} from '../core.js';
import { undoManager } from '../undoManager.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { saveFloor } from '../storage/db.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE, rulesFor } from './structureRules.js';
import { autoFillWoodColumns } from './woodAutoFill.js';
import { autoFillWallBeamAxes, selfWallSegments } from './wallBeamAxes.js';
import { gridIndexOf } from '../finish/gridCells.js';
import { buildCellToRoom } from '../finish/edgeClassify.js';
import { collectFloorGroups, totalCountOf, renumberMembers } from './memberNumbering.js';
import { memberGroupKey } from './memberCatalog.js';
import { syncRoofPlane } from './roofPlane.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';
import { findSectionEntry } from './sectionCatalog.js';
import {
  recomputeStructuralComposition, reflectStructuralAfterFinishExit, reflectStructuralToOtherFloors,
  repeatReflectPassUntilConverged, MAX_REFLECT_PASSES, columnSetSignature, runStructuralModeSetup,
  recomputeActiveStructural, reflectStructuralAfterFloorAdd, recomputeForStructuralSync,
} from './structuralOrchestration.js';
import { figureBindingManager } from '../figure/FigureBindingManager.js';
import { createStructuralResolveContext } from './structuralResolveContext.js';
import { buildWoodFloorForB1, dumpB1AllFloorsAllFields } from './structuralOrchestrationFixtures.js';

// 下階なし（基礎伏図相当）composition スタブ。recomputeStructuralComposition は
// belowGraph=null のとき下階分岐（buildStructuralWallGate 等の非同期IDB経路）を一切通らない。
const noBelowComposition = { graphForCategory: () => null };

function makeSinglePlaneProject() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  return { project, graph };
}

// ---- 反映パスの「収束するまで繰り返す」（リード裁定・2026-09-19）を直接検証するための最小限の
// インメモリIndexedDBシム。----
// 従来（下の「reflectStructuralToOtherFloorsを直接呼ぶ挙動テストは断念」コメント参照）はfake-indexeddb
// 等のIDBモックが本リポジトリのdevDependenciesに無いことを理由に断念していたが、新規npm依存を
// 追加せず自前で最小限のシムを書けば足りると判断し直した（storage/db.js openDB/saveFloor/loadFloorが
// 使うAPIだけを模す。indexedDB.open→onupgradeneeded→onsuccessの非同期チェーンをqueueMicrotaskで
// 再現するだけの薄いスタブで、実IndexedDBの仕様には準拠しない——このテストファイルの外では使わない）。
// 旧onFloorsPutフック（'floors'ストアへのput呼び出しを観測する干渉トリガ）は、本ファイル内の他の
// 多数のtest()が先にopenDB()を成功させるとstorage/db.jsの_dbPromiseキャッシュ越しに一度も発火しない
// 空振りになることが判明したため、それに依存するテストは structuralOrchestration.interference.test.js
// （専用ファイル・fakeDbをモジュールレベルで1個だけ生成）へ移設した（差し戻し対応・2026-09-21）。
// このファイルに残る withFakeIndexedDB の利用者はどれもonFloorsPutフックを使わないため、
// オプション自体を削除した（使われないオプションを残さない）。
// storage/db.js は DB 接続をモジュール内にキャッシュするため、このファイルの withFakeIndexedDB は
// **全テストで最初の fakeDb のストアを共有**している（毎回 `new FakeDB()` しても2回目以降は
// _dbPromise越しに無視され、実際に使われるのは最初にopenDB()を成功させたfakeDbだけ）。新しいテストは
// 必ず自分で saveFloor してから読むこと・空のストアを前提にしないこと・fakeDbのフック（onFloorsPut等）
// に依存するテストは別ファイル（structuralOrchestration.interference.test.js）に置くこと。
function withFakeIndexedDB(fn) {
  class FakeRequest { constructor() { this.onsuccess = null; this.onerror = null; } }
  class FakeStore {
    constructor() { this.data = new Map(); }
    put(value) {
      const req = new FakeRequest();
      this.data.set(value.planeId ?? value.projectId, value);
      queueMicrotask(() => req.onsuccess?.({ target: { result: undefined } }));
      return req;
    }
    get(key) {
      const req = new FakeRequest();
      queueMicrotask(() => req.onsuccess?.({ target: { result: this.data.get(key) } }));
      return req;
    }
  }
  class FakeDB {
    constructor() {
      this.stores = new Map();
      this.objectStoreNames = { contains: (n) => this.stores.has(n) };
      for (const name of ['floors', 'projects', 'savedFloors']) {
        this.stores.set(name, new FakeStore());
      }
    }
    transaction(name) { const store = this.stores.get(name); return { objectStore: () => store }; }
  }
  const fakeDb = new FakeDB();
  const original = globalThis.indexedDB;
  globalThis.indexedDB = {
    open() {
      const req = new FakeRequest();
      queueMicrotask(() => req.onsuccess?.({ target: { result: fakeDb } }));
      return req;
    },
  };
  return fn().finally(() => { globalThis.indexedDB = original; });
}

// ---- recomputeStructuralComposition ----

test('recomputeStructuralComposition: mutateありならundoが1件積まれ、undoでstructureOverrideが戻る', async () => {
  const { project, graph } = makeSinglePlaneProject();
  const beforeTop = undoManager.peekUndo();

  await recomputeStructuralComposition(noBelowComposition, graph, project, {
    mutate: () => { graph.setStructureOverride('S造'); },
  });

  assert.equal(graph.structureOverride, 'S造');
  assert.notEqual(undoManager.peekUndo(), beforeTop, 'mutate指定時はchanged不問でundoが積まれる');

  undoManager.undo();
  assert.equal(graph.structureOverride, null, 'undoでstructureOverrideが戻る');
});

test('recomputeStructuralComposition: mutateなし・差分なし（同一入力2回目）ならundoを積まない', async () => {
  const { project, graph } = makeSinglePlaneProject();
  project.structuralInfo.mainStructure = 'S造';
  // 2x2グリッド（通り芯4本）を張り、wallGate=null（部屋未定義）フォールバックで交点に柱が
  // 自動生成される状況を作る——初回は生成でchanged:true、2回目は同一入力で冪等changed:falseになる
  // ことを確認する（idempotency）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  await recomputeStructuralComposition(noBelowComposition, graph, project);
  assert.equal(graph.columns.length, 4, '初回は交点4箇所に柱が自動生成される');
  const afterFirst = undoManager.peekUndo();

  await recomputeStructuralComposition(noBelowComposition, graph, project);
  assert.equal(graph.columns.length, 4, '2回目は柱本数が変わらない（冪等）');
  assert.equal(undoManager.peekUndo(), afterFirst, '2回目は差分なしのためundoを積まない');
});

test('recomputeStructuralComposition: onToast未指定でも例外を投げない（optional callbackの失敗パス）', async () => {
  const { project, graph } = makeSinglePlaneProject();
  await assert.doesNotReject(
    recomputeStructuralComposition(noBelowComposition, graph, project, {
      mutate: () => { graph.setStructureOverride('S造'); },
    }),
  );
});

// ---- ステップD: recomputeActiveStructural（唯一のbefore/after=captureSnapshots利用元）のundoが生きていること ----
test('recomputeActiveStructural: 変化があればundoに1件積まれ、undoで再計算前（柱0本）へ戻る', async () => {
  const { project, graph } = makeSinglePlaneProject();
  project.structuralInfo.mainStructure = 'S造';
  // recomputeStructuralComposition の「mutateなし・差分なし」テストと同じ2x2グリッド
  // （wallGate=null フォールバックで交点4箇所に柱が自動生成される）。
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  const beforeTop = undoManager.peekUndo();
  await recomputeActiveStructural(project);
  assert.equal(graph.columns.length, 4, '交点4箇所に柱が自動生成される');
  assert.notEqual(undoManager.peekUndo(), beforeTop, '変化があったのでundoが積まれる');

  undoManager.undo();
  assert.equal(graph.columns.length, 0, 'undoで再計算前（柱0本）へ戻る');

  undoManager.redo();
  assert.equal(graph.columns.length, 4, 'redoで再計算後（柱4本）へ戻る');
});

test('recomputeActiveStructural: 差分なし（同一入力2回目）ならundoを積まない', async () => {
  const { project, graph } = makeSinglePlaneProject();
  project.structuralInfo.mainStructure = 'S造';
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  await recomputeActiveStructural(project);
  assert.equal(graph.columns.length, 4, '前提: 初回は交点4箇所に柱が自動生成される');
  const afterFirst = undoManager.peekUndo();

  await recomputeActiveStructural(project);
  assert.equal(graph.columns.length, 4, '2回目は柱本数が変わらない（冪等）');
  assert.equal(undoManager.peekUndo(), afterFirst, '2回目は差分なしのためundoを積まない');
});

test('recomputeActiveStructural: 戻り値{changed}を返す（構造同期structural/structuralSync.jsのrecomputeForStructuralSyncが"all"の外側ループ収束判定に使う。2026-09-25）', async () => {
  const { project, graph } = makeSinglePlaneProject();
  project.structuralInfo.mainStructure = 'S造';
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  const first = await recomputeActiveStructural(project);
  assert.deepEqual(first, { changed: true }, '初回（柱0本→4本）はchanged:trueを返すはず');
  assert.equal(graph.columns.length, 4);

  const second = await recomputeActiveStructural(project);
  assert.deepEqual(second, { changed: false }, '2回目（差分なし）はchanged:falseを返すはず');
});

// ---- recomputeForStructuralSync（structural/structuralSync.js recompute実装。段階(a)・2026-09-25）----

// m-3・QA指摘: 単一階フィクスチャは「peekする他階が無いから0回」なだけで検出力が弱いため、
// 他階が実在する2階建てへ強化する。ただし在来木造（columnPlacement:'wallIntersections'）は
// 3b（上階柱直下の柱）のため'active'スコープでも1つ上の実体階を都度peekする——これは
// recomputeStructuralForGraph（structuralRecompute.js）自身の既存の読み取り専用peek（構造同期の
// scope概念より前からある挙動）で、他階の**保存**はしない。'active'スコープが保証するのは
// 「他階を書き換えない」ことであり「一切peekしない」ことではない（実測で判明。以前のコメント
// 「'active'は自階だけの再計算のためpeekを呼ばない」は単一階フィクスチャでしか成立しない過大な
// 主張だった）。そのため本テストは在来限定にせず、peekが構造的に0回になるS造（gridIntersections・
// wallBeamAxes:null。上下階を一切見ない）×アクティブ＝最下階（resolveLowestGraphが自階を返し
// 追加peekしない）の組合せで検証する——'all'スコープなら2階へ反映するため必ず1回以上peekする
// （すぐ上の【失敗系】テスト・下記【全体反映】テストで対照済み）。
test('recomputeForStructuralSync("active"): 2階建て(S造)フィクスチャでもfloorSwapManager.peekを一度も呼ばない（"他階を書き換えない"がscope="active"の実体で、"一切peekしない"は保証しない。m-3・QA指摘）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-m3', 'test');
    project.structuralInfo.mainStructure = 'S造';
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
    const { graph: g1 } = project.addPlane(0,    '1階', 'p1'); // アクティブ＝最下階（resolveLowestGraphが自階を返す）
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 存在するが'active'スコープでは触れられてはいけない他階
    project.activePlaneId = 'p1';
    await saveFloor('p1', serializeGraph(g1));
    await saveFloor('p2', serializeGraph(g2));

    let peekCalls = 0;
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (...args) => { peekCalls++; return originalPeek.call(floorSwapManager, ...args); };
    try {
      await recomputeForStructuralSync(project, 'active');
      assert.equal(peekCalls, 0, "'active'は自階だけの再計算のため、2階が実在してもpeekを呼ばないはず（S造は上下階を参照しないため真に0回になる）");
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  });
});

test('【失敗系】recomputeForStructuralSync("all"): 他階のpeekがthrowしたらrejectする', async () => {
  // withFakeIndexedDBで包む——自階(graph)の保存はrecomputeForStructuralSyncの手順1で先に走るため
  // （'all'は自階を先に再計算・保存してから他階へ反映する。saveViaの既定_saveはstorage/db.js
  // saveFloor＝実IDBを要求する）、これを欠くとopenDB()がindexedDB未定義でReferenceErrorになり、
  // storage/db.js の _dbPromise キャッシュが恒久的に汚染されて以降の全テスト（withFakeIndexedDB
  // 利用テストを含む）が壊れる（QA実測。db.jsのonerrorハンドラは同期throwでは発火せず解除されない）。
  await withFakeIndexedDB(async () => {
    const { project, graph } = makeSinglePlaneProject();
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
    project.activePlaneId = graph.plane.id;
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane, structGraph) => {
      if (plane.id === g2.plane.id) throw new Error('peek boom');
      return originalPeek.call(floorSwapManager, plane, structGraph);
    };
    try {
      await assert.rejects(() => recomputeForStructuralSync(project, 'all'), /peek boom/);
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  });
});

test('recomputeForStructuralSync("all"): 3階建て(在来)+屋根フィクスチャで、外部から1回呼ぶだけで全階が収束し、もう1回呼んでも変化せず他階へのsave回数は0件になる（冪等。m-4・QA指摘: 保存回数を数えて確認する）', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activeId = project.planes[0].id;
    project.activePlaneId = activeId; // 1階をアクティブにする（自階先行保存の効果を確認しやすい）

    // save呼び出しをplaneId別に数える解決コンテキストを注入する（recomputeForStructuralSync自身は
    // ctxを明示された場合disposeしないため、呼び出し側で毎回dispose）。
    function countingCtx(saveCallsByPlane) {
      return createStructuralResolveContext({
        save: async (planeId, bytes) => {
          saveCallsByPlane.set(planeId, (saveCallsByPlane.get(planeId) ?? 0) + 1);
          await saveFloor(planeId, bytes);
        },
      });
    }

    const saveCalls1 = new Map();
    const ctx1 = countingCtx(saveCalls1);
    await recomputeForStructuralSync(project, 'all', ctx1);
    ctx1.dispose();
    const dumpAfterOnce = await dumpB1AllFloorsAllFields(project);
    for (const floorName of ['1階', '2階', '3階']) {
      assert.ok(dumpAfterOnce[floorName].columns.length > 0, `${floorName}は空であってはならない（save→本番peek往復で部材が失われていないことの構造的な担保）`);
    }
    assert.ok((saveCalls1.get(activeId) ?? 0) > 0, '前提: 初回は自階が最低1回保存される');

    const saveCalls2 = new Map();
    const ctx2 = countingCtx(saveCalls2);
    await recomputeForStructuralSync(project, 'all', ctx2);
    ctx2.dispose();
    const dumpAfterTwice = await dumpB1AllFloorsAllFields(project);
    assert.deepEqual(dumpAfterTwice, dumpAfterOnce, 'もう1回呼んでも部材ダンプが変わらない（冪等）');

    // 他階（非アクティブ）へのsave回数は2回目は0件のはず——recomputeInactiveStructuralは
    // changed:trueのときだけsaveViaを呼ぶため、収束済みなら他階は一切保存されない。
    // 自階（アクティブ階）だけは設計どおりpass1で無条件に1回saveVia（recomputeForStructuralSyncの
    // 「自階を先に保存してから他階へ反映する」手順そのもの。structural-model.md「起動点」節参照）
    // ——このテストが確認したいのは「収束後に冗長な保存が起きないか」であり、自階の設計上の
    // 1回書きはその対象外（REASONED。文字どおり「2回目はsave呼び出し0件」にすると、この
    // 常に1回書く設計仕様と矛盾して常に失敗するテストになってしまう——m-4のQA指摘に対する
    // 技術的判断としてこの形にした）。
    for (const [planeId, count] of saveCalls2) {
      if (planeId === activeId) continue;
      assert.equal(count, 0, `2回目は他階(${planeId})への保存は0件のはず`);
    }
    assert.ok((saveCalls2.get(activeId) ?? 0) >= 1, '自階は仕組み上パス1で毎回1回保存されるため0にはならない');
  });
});

// ---- QA F4: 下階編集経路（主構造変更時等）は直前に立った下階の3b柱を撤去しない ----
test('recomputeStructuralComposition: 下階編集経路は直前に立った下階の3b柱を撤去しない（QA F4）', async () => {
  const project = new Project('proj-f4', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（belowGraph。3b柱の対象階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（subjectGraph）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 1階: 3640×1820の実壁の部屋（4隅が3a交点）＋走行方向アンカー用の通り芯 x=1820（壁は無い）。
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  const anchorX = g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 1階に「直前のreflectStructuralToOtherFloorsで立った」3b柱を模した既存の自動柱を置く（1820,0）。
  const col3b = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', anchorX, gy0, {});
  assert.equal(col3b.dimensionStatus, 'auto', '前提: 自動生成分（撤去対象になりうる）');

  // 2階: 自階柱(1820,0)——1階の3b柱にとっての「1つ上の実体階の柱」役（aboveColumnsForBelow）。
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, y0, {});

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 }; // belowGraph=g1（下階編集経路を通す）
    await recomputeStructuralComposition(composition, g2, project, { mutate: () => {} });
    assert.ok(g1.columnMap.has(col3b.id), '1階の3b柱は下階編集経路の再計算で撤去されない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- ステップ3h-2: 下階編集経路（主構造変更時等）は直前に立った下階の3h-2柱（上階の頭つなぎ・受梁が
// 壁を横切る位置の柱）を撤去しない。QA F4（3b柱）と対称のシナリオ——1階の3a交点そのものにしない
// よう、頭つなぎが横切る位置(1820,0)はコーナー(0,0)・(3640,0)とは別の壁上の点にする。 ----
test('recomputeStructuralComposition: 下階編集経路は直前に立った下階の3h-2柱を撤去しない', async () => {
  const project = new Project('proj-3h2', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（belowGraph。3h-2柱の対象階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（subjectGraph。頭つなぎを持つ）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 1階: 3640×1820の実壁の部屋（4隅が3a交点）＋走行方向アンカー用の通り芯 x=1820（壁は無い）。
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  const anchorX = g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 1階に「直前のreflectStructuralToOtherFloorsで立った」3h-2柱を模した既存の自動柱を置く（1820,0）。
  const colTie = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', anchorX, gy0, {});
  assert.equal(colTie.dimensionStatus, 'auto', '前提: 自動生成分（撤去対象になりうる）');

  // 2階: 頭つなぎ（縦方向、x=1820、y:-1000..1000）——1階のy=0の壁を(1820,0)で横切る
  // （aboveBeamSegmentsForBelow＝columnSeedBeamSegments(subjectGraph,...)の対象）。
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const yA = g2.addCenterLine(CenterLineType.HORIZONTAL, -1000, { labeled: true, discipline: Discipline.STRUCT });
  const yB = g2.addCenterLine(CenterLineType.HORIZONTAL, 1000,  { labeled: true, discipline: Discipline.STRUCT });
  const tieBeam = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, true, yA, yB, { role: 'primary', beamType: '頭つなぎ' });
  // 2階自身の壁線上の通し梁再計算（wallRunSegmentsは自階＋1階の壁を合成するため、2階に壁が無くても
  // 空にならない）にこの手作りの頭つなぎを巻き込まれないよう手動固定にする（columnSeedBeamSegmentsは
  // dimensionStatusを見ないため候補列挙には影響しない）。
  tieBeam.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 }; // belowGraph=g1（下階編集経路を通す）
    await recomputeStructuralComposition(composition, g2, project, { mutate: () => {} });
    assert.ok(g1.columnMap.has(colTie.id), '1階の3h-2柱は下階編集経路の再計算で撤去されない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 実機裁定ステップ4 C-2 QA2: 「各階柱寸法」欄（下階graphのwoodColumnWidthMm）は
// WoodColumnWidthSelectのonStructureChanged経由でrecomputeStructuralCompositionへ乗る。
// mutateが下階（belowGraph）自身を書き換えるケース——柱グループのgraphは伏図慣習で「1つ下の実体階」
// のため、この欄の変更は必ずbelowGraphを書き換える（.claude/structural-model.md参照）。 ----
test('recomputeStructuralComposition【実機裁定ステップ4 C-2 QA2】: 下階の「各階柱寸法」を変えると下階柱・自階梁（下階柱寸参照）の断面が追従し、undoで断面・柱寸・部材番号のすべてが元に戻る', async () => {
  const project = new Project('proj-c2-qa2', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（belowGraph。柱グループの編集対象）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（subjectGraph。梁は下階柱寸を参照）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 通り芯（全階共通）は project.structGraph に置く——階固有graphへ直接addCenterLineすると、
  // 通り芯はserializeGraphの階スナップショットから除外される（buildSnapshot: isStructCLは
  // serializeStructCLs側でだけ復元する前提）ため、undo（restoreGraph）で消えてしまう
  // （graphSnapshot.test.jsの「通り芯復元前にrestoreGraphすると壁が無音で失われる」と同種の落とし穴）。
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  // 1階: 柱1本（既定120角のまま）。
  const col1F = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y0, {});

  // 2階: 梁1本（成240。材幅は「梁を支える1つ下の実体階＝1階」の柱寸を参照する対象）。
  const beam2F = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x240', y0, false, x0, x1, { role: 'primary' });
  // 成の自動更新（autoFillWoodBeamDepths、ステップ3d）を対象外にし、材幅だけの追従
  // （conformWoodSections。dimensionStatusに関わらず書き換える）を単独で確認する。
  beam2F.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 }; // 柱グループの欄が編集する graph（下階=1階）
    const col1FNoBefore = col1F.memberNo;
    const beam2FNoBefore = beam2F.memberNo;
    const undoBefore = undoManager.peekUndo();

    // WoodColumnWidthSelect.handleChange と同じ形の mutate（belowGraph自身を書き換える）。
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });

    assert.equal(g1.woodColumnWidthMm, 105);
    assert.equal(col1F.sectionDefId, 'WOOD-105x105', '1階柱は105角へそろう（自階の値）');
    assert.equal(beam2F.sectionDefId, 'WOOD-105x240', '2階梁は成240を保ったまま材幅だけ105へ（下階=1階の柱寸を参照。beamColumnWidthMm）');
    assert.notEqual(undoManager.peekUndo(), undoBefore, 'undoエントリが1件積まれる');

    undoManager.undo();
    // restoreGraph は clear()→再構築のため、undo後は id で引き直す（保持していた古いJS参照は
    // 置き換え前の実体を指したままになる。structuralOrchestration.test.js の既存パターン
    // ＝QA F4テストの g1.columnMap.has(col3b.id) と同じ規律）。
    const col1FAfterUndo = g1.columnMap.get(col1F.id);
    const beam2FAfterUndo = g2.beamMap.get(beam2F.id);
    assert.equal(g1.woodColumnWidthMm, null, 'undoで各階柱寸法（下階graphのwoodColumnWidthMm）が戻る');
    assert.equal(col1FAfterUndo.sectionDefId, 'WOOD-120x120', 'undoで1階柱の断面が戻る');
    assert.equal(beam2FAfterUndo.sectionDefId, 'WOOD-120x240', 'undoで2階梁の断面が戻る');
    // 実機観測: 柱寸変更後にundoしても1階の柱番号（グループ表記）が変更前に戻っていなかった
    // （belowGraphのbeforeスナップショットをmutate実行後に取っていたバグ。再発防止）。
    assert.equal(col1FAfterUndo.memberNo, col1FNoBefore, 'undoで1階柱の部材番号も変更前に戻る');
    assert.equal(beam2FAfterUndo.memberNo, beam2FNoBefore, 'undoで2階梁の部材番号も変更前に戻る');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- ステップ3（2026-09-17裁定）: 柱の個別柱寸（column.woodColumnWidthMm）----
test('recomputeStructuralComposition【ステップ3】: 柱の個別柱寸を設定するとその柱だけ断面・タグが分かれ、undoで断面・タグとも変更前（共通）に戻る', async () => {
  const project = new Project('proj-step3-individual-column', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const col1 = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y0, {});
  const col2 = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x1, y0, {});

  // ベース採番（column.setField直後ではなくrecomputeStructuralCompositionを通した状態を前提にする）。
  await recomputeStructuralComposition(noBelowComposition, g1, project, { mutate: () => {} });
  const col1TagBefore = col1.memberNo;
  const col2TagBefore = col2.memberNo;
  assert.equal(col1TagBefore, col2TagBefore, '前提: 個別指定前は共通の1グループ（同じタグ）');

  const undoBefore = undoManager.peekUndo();
  await recomputeStructuralComposition(noBelowComposition, g1, project, {
    mutate: () => { col1.setField('woodColumnWidthMm', 105); },
  });

  assert.equal(col1.sectionDefId, 'WOOD-105x105', '個別指定した柱はその値へ');
  assert.equal(col2.sectionDefId, 'WOOD-120x120', '個別指定していない柱は共通（階の値・既定120）のまま');
  assert.notEqual(col1.memberNo, col2.memberNo, '個別指定した柱は共通のタグから分かれる');
  assert.notEqual(undoManager.peekUndo(), undoBefore, 'undoエントリが1件積まれる');

  undoManager.undo();
  const col1AfterUndo = g1.columnMap.get(col1.id);
  const col2AfterUndo = g1.columnMap.get(col2.id);
  assert.equal(col1AfterUndo.woodColumnWidthMm, null, 'undoで個別柱寸(woodColumnWidthMm)が戻る');
  assert.equal(col1AfterUndo.sectionDefId, 'WOOD-120x120', 'undoで断面が戻る');
  assert.equal(col1AfterUndo.memberNo, col2AfterUndo.memberNo, 'undoでタグが共通へ戻る（採番索引の戻りも同型）');
  assert.equal(col1AfterUndo.memberNo, col1TagBefore, 'undoでタグが変更前と一致する');
});

test('【失敗系・実機裁定ステップ4 C-2 QA2】recomputeStructuralComposition: 下階が無い（基礎伏図相当）場合は自階の値へフォールバックし梁幅が追従する', async () => {
  const project = new Project('proj-c2-qa2-nobelow', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  const beam1F = g1.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x240', y0, false, x0, x1, { role: 'primary' });
  beam1F.setDimensionStatus('locked'); // 材幅だけの追従を単独で確認する（成の自動更新3dは対象外にする）

  await recomputeStructuralComposition(noBelowComposition, g1, project, {
    mutate: () => { g1.setWoodColumnWidthMm(105); },
  });

  assert.equal(beam1F.sectionDefId, 'WOOD-105x240', '下階が無ければ自階の値へフォールバックする（beamColumnWidthMmの規約）');
});

// ---- 実機再確認（moku1・2階伏図）QA3: undo/redoでentity.memberNoはrestoreGraphで戻るが、
// 建物全体の採番索引（project.memberNumberIndex。非永続キャッシュ）は作り直されないため、
// 構造リストのバッジ表示（floorSpanLabel/totalCountOf。例「1~3F・計106本」）が復元後の実体と
// 食い違って残る（実機観測: undo後に柱グループのバッジが変更前に戻らない・梁グループのバッジが消える）----
test('recomputeStructuralComposition【実機裁定ステップ4 C-2 QA3】: undoで採番索引（floorRanks・counts）が変更前と一致し、redoで変更後と一致する', async () => {
  const project = new Project('proj-c2-qa3', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（belowGraph）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（subjectGraph）
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3'); // composition対象外（undoで一切触れない階）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g3.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  project.activePlaneId = 'p2';

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });

  // 1〜3階すべてに「WOOD-120x120」の柱を置く（在来木造は柱の採番グループを階ごとに分けるため
  // ユーザー裁定2026-09-17・A、同じ材寸でも3グループに分かれる。3階はcompositionのbelowGraphでは
  // ない＝undoで一切restoreGraphされない）。
  const col1F = g1.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y0, {});
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y1, {});
  g3.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', x0, y0, {});

  // モード境界の反映パス（reflectStructuralToOtherFloors）が構造モード突入時に必ず先に建物全体を
  // 収集済み、という前提を再現する（ここでは直接collectFloorGroupsで模す。3階は今回のundo/redoで
  // 一切触れない階として、その寄与が索引に残ったまま試験する）。
  runInAction(() => {
    collectFloorGroups(g1, project);
    collectFloorGroups(g2, project);
    collectFloorGroups(g3, project);
  });
  // 在来木造は柱グループが階ごと（groupKeyに@planeIdが付く）に分かれるため、1階の「120×120」
  // グループは1階専用（floorRanks=[0]・count=1）——建物全体で1つにまとまる非在来の挙動
  // （旧テストが検証していた"1~3F"相当）とは異なる（ユーザー裁定2026-09-17・A）。
  const groupKey = memberGroupKey(col1F, 'columnMap', rulesFor(TRADITIONAL_WOOD_STRUCTURE), undefined, g1.plane.id);
  const groupBefore = project.memberNumberIndex.get(groupKey);
  assert.ok(groupBefore, '前提: 1階の「120×120」柱グループ（1階専用）が索引に存在する');
  const floorRanksBefore = [...groupBefore.floorRanks].sort();
  const countBefore = totalCountOf(groupBefore);
  assert.deepEqual(floorRanksBefore, [0], '前提: 在来木造は柱グループが階ごとに分かれるため1階のみ');
  assert.equal(countBefore, 1);

  const peekMap = { p1: g1, p2: g2, p3: g3 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 };
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });

    // 変更直後: 1階の柱が別グループ（105×105@1F）へ移る。旧グループ（120×120@1F）は1階専用だった
    // ため寄与が0本になり索引からゴースト掃除で消える（非在来のように他階分が残って縮むのではなく
    // 丸ごと消える——在来は柱グループが階をまたがないため）。
    const groupDuring = project.memberNumberIndex.get(groupKey);
    assert.equal(groupDuring, undefined, '前提: 変更直後は120×120@1Fグループがゴースト掃除で消える');

    undoManager.undo();
    const groupAfterUndo = project.memberNumberIndex.get(groupKey);
    assert.ok(groupAfterUndo, 'undo後に「120×120」柱グループ（1階専用）の索引エントリが復元される（実機観測: 梁グループのバッジが消えた不具合の回帰防止）');
    assert.deepEqual([...groupAfterUndo.floorRanks].sort(), floorRanksBefore, 'undoで索引のfloorRanksが変更前と一致する（バッジ表示の食い違いの回帰防止）');
    assert.equal(totalCountOf(groupAfterUndo), countBefore, 'undoで索引のcountsが変更前と一致する');

    undoManager.redo();
    const groupAfterRedo = project.memberNumberIndex.get(groupKey);
    assert.equal(groupAfterRedo, undefined, 'redoで再び120×120@1Fグループが消える（変更後の状態と一致）');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- reflectStructuralAfterFinishExit ----
// runStructuralModeSetup（syncRoofPlane→reflectStructuralToOtherFloors内のreflectRoofPlaneが
// 屋根専用平面をfloorSwapManager.peekし、indexedDBに到達する。fake-indexeddb等のIDBモックは本リポジトリの
// devDependencies に無く新規依存の追加は本タスクの範囲外）は node:test 環境で indexedDB未定義の
// ReferenceErrorになるため断念する（REASONED: node --import ./scripts/testSetup.mjs -e での事前検証で
// 実際に indexedDB is not defined を確認済み）。
// reflectStructuralAfterFinishExit は idx===-1／最上階退出の2ケースに限りIDBを一切経由しないため対象にする
// （いずれもmakeSinglePlaneProjectが屋根専用平面を持たないためreflectRoofPlaneも早期returnする）。

test('reflectStructuralAfterFinishExit: 存在しないplaneId（idx===-1）＋goingToStructure=trueは何もせず例外なし・undo不変', async () => {
  const { project } = makeSinglePlaneProject();
  const beforeTop = undoManager.peekUndo();

  await reflectStructuralAfterFinishExit('does-not-exist', true, project);

  assert.equal(undoManager.peekUndo(), beforeTop, 'idx===-1かつgoingToStructure=trueは自階再計算も他階ループも通らない');
});

test('reflectStructuralAfterFinishExit: 最上階（唯一の実体階）からの退出は上階ループが回らず正常完了', async () => {
  const { project, graph } = makeSinglePlaneProject();

  await assert.doesNotReject(reflectStructuralAfterFinishExit(graph.plane.id, false, project));
});

// ---- 不変条件・ソース走査: 下階編集経路（主構造変更時等）が、上階柱直下の柱（ステップ3b）・上階の
// 柱生成の点源（role:'primary'|'floor'の梁）が壁を横切る位置の柱（ステップ3h-2）に必要な
// aboveColumns（subjectGraph.columns。メモリ上・peek不要）・wallSegments（wallRunSegments）・
// aboveBeamSegments（columnSeedBeamSegments(subjectGraph,...)。同じくメモリ上・peek不要）を
// autoFillColumnsForStructure(belowGraph, ...) へ渡していること。これを渡し忘れると、直前の
// reflectStructuralToOtherFloors が作った下階の3b・3h-2柱が、この経路の再計算で候補から漏れて
// 撤去される（woodAutoFill.test.jsの同種テストと同じ手法。fs.readFileSync+正規表現）。----
test('【不変条件・ソース走査】structuralOrchestration.js: 下階編集経路が autoFillColumnsForStructure に subjectGraph.columns・wallRunSegments(...)・columnSeedBeamSegments(subjectGraph,...) を渡している', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, 'structuralOrchestration.js'), 'utf8');
  assert.ok(/autoFillColumnsForStructure\(belowGraph, project, belowGate, aboveColumnsForBelow, belowWallSegments, aboveBeamSegmentsForBelow, belowBelowGraph\?\.columns \?\? \[\]\)/.test(src),
    'autoFillColumnsForStructure(belowGraph, ...) へ aboveColumnsForBelow・belowWallSegments・aboveBeamSegmentsForBelow・belowBelowGraph?.columnsを渡していない');
  assert.ok(/aboveColumnsForBelow\s*=\s*subjectGraph\.columns/.test(src),
    'aboveColumnsForBelow が subjectGraph.columns（メモリ上）から来ていない（誤ってpeekしている可能性）');
  assert.ok(/belowWallSegments\s*=\s*wallRunSegments\(belowGraph, belowBelowGraph, belowStructure, belowWallSourceCache\)/.test(src),
    'belowWallSegments が wallRunSegments(belowGraph, belowBelowGraph, belowStructure, belowWallSourceCache) から来ていない');
  assert.ok(/aboveBeamSegmentsForBelow\s*=\s*columnSeedBeamSegments\(subjectGraph,\s*rulesFor\(effectiveStructure\(subjectGraph, project\)\)\)/.test(src),
    'aboveBeamSegmentsForBelow が columnSeedBeamSegments(subjectGraph, ...)（メモリ上）から来ていない（誤ってpeekしている可能性）');
});

// ---- 実機再QA指摘1: 標準材の解決が採番パイプライン（collect/apply）とUI同期経路（renumberMembers・
// MemberListTab.jsx・transform/centerLineOps.js）で二系統に分かれ、下階の柱寸変更後に
// renumberMembers を呼ぶとタグが分裂する実測バグ（105×120の梁が2G18のまま留まらず2G18〜2G26に分裂）。
// 派生値方式（graph.beamColumnWidthMm）採用後は renumberMembers もこの派生値を読むだけになり、
// 分裂しないことを確認する。----
test('renumberMembers【実機裁定ステップ4 C-2 QA4】: 構造リストの編集（renumberMembers）は下階基準の標準材（graph.beamColumnWidthMm）を保つ——105×120の2本が同一タグのまま分裂しない', async () => {
  const project = new Project('proj-c2-qa4', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（各階柱寸法の編集対象）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（構造リストを編集する階）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  project.activePlaneId = 'p2';

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: true, discipline: Discipline.STRUCT });

  // 2階: 105×120（標準材＝柱寸105×梁成表の最小成120）×2 本＋105×330（非標準＝個別採番対象）×1本。
  // 成の自動更新（ステップ3d）を対象外にして材幅の分類だけを確認する。
  const beamStdA = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y0, false, x0, x1, { role: 'primary' });
  const beamStdB = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y1, false, x0, x1, { role: 'primary' });
  const beamNonStd = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x330', y2, false, x0, x1, { role: 'primary' });
  for (const b of [beamStdA, beamStdB, beamNonStd]) b.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 }; // 「各階柱寸法」欄が編集するgraph（下階=1階）
    // 突入時相当の再計算: 1階の柱寸を105にした状態で2階を再計算し、graph.beamColumnWidthMm
    // （下階=1階基準の派生値）を2階へキャッシュさせる。
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });
    assert.equal(g2.beamColumnWidthMm, 105, '前提: 2階の派生値（下階=1階の柱寸）が105になっている');
    assert.equal(beamStdA.memberNo, beamStdB.memberNo, '前提: 105×120の2本は同一タグ（標準材として1グループ）');
    assert.notEqual(beamStdA.memberNo, beamNonStd.memberNo, '前提: 105×330は個別採番対象で別タグ');

    // 「構造リストの編集」相当（分割・統合・手動タグ解除・部材追加/削除はいずれもrenumberMembersを呼ぶ）。
    runInAction(() => renumberMembers(g2, project, 'beamMap'));

    assert.equal(beamStdA.memberNo, beamStdB.memberNo,
      'renumberMembers後も105×120の2本は同一タグのまま分裂しない（実機観測: 2G18が2G18〜2G26に分裂したバグの回帰防止）');
    assert.notEqual(beamStdA.memberNo, beamNonStd.memberNo, '105×330（個別採番対象）は引き続き標準材の2本とは別タグ');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 実機再QA指摘2→再QA指摘4: 配線側（反映の呼び出し側）は temp インスタンス自体を持ち回らず、
// collectフェーズで求めた beamColumnWidthMm（数値のみ）を控える。applyMemberNumbersToFloor は
// peekVia で対象階を取得し、控えた数値を無条件で書き戻してからapplyNumbersを呼ぶ（collect時点の
// 標準材判定をapply側でも再現する）。従来経路（ctx:null）は復元し直したインスタンス（非永続の
// beamColumnWidthMm はnullへ落ちる）、コンテキスト経路は collect と同じ保持インスタンスが返る——
// どちらでも同じ値を読ませるために書き戻しがセットで要る。旧規律「同時に生きる非アクティブ階は
// 1階分」は 2026-09-21 裁定で改めた（.claude/structural-model.md「反映処理の間だけ各階のpeek結果を
// 使い回す」節。階を保持するのは解決コンテキストの役目で、配線側ではない）。----
test('【不変条件・実機再QA指摘4】structuralOrchestration.js: applyMemberNumbersToFloor は peekVia で階を取得し、保存された beamColumnWidthMm 数値を書き戻してから applyNumbers を呼ぶ（配線側で temp インスタンス自体を持ち回らない）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = stripComments(fs.readFileSync(path.join(here, 'structuralOrchestration.js'), 'utf8'));
  // ステップB-3でctx（解決コンテキスト。省略可・既定undefined）が5番目の引数として加わった。
  const fnMatch = /async function applyMemberNumbersToFloor\(plane, tags, project, beamColumnWidthMmValue, ctx = undefined\) \{([\s\S]*?)\r?\n\}/.exec(src);
  assert.ok(fnMatch, 'applyMemberNumbersToFloor(plane, tags, project, beamColumnWidthMmValue, ctx)（数値を引数で受け取る宣言）が見つからない');
  const body = fnMatch[1];
  // 階の取得はpeekVia経由——ctxが無ければfloorSwapManager.peek直呼び、あれば保持インスタンス
  // （structuralPeek.js peekVia参照）。
  assert.ok(/peekVia\(ctx, plane, project\.structGraph\)/.test(body), 'applyMemberNumbersToFloor が peekVia で階を取得していない（tempインスタンスを引数で持ち回る実装に戻っている、またはpeekViaを経由していない）');
  assert.ok(/setBeamColumnWidthMm\(beamColumnWidthMmValue\)/.test(body), 'applyMemberNumbersToFloor が保存済みの beamColumnWidthMm 数値を書き戻していない（standardBeamSectionFor の判定がcollect時点と食い違う。コメントアウトされている可能性）');
  // 呼び出し側（reflectStructuralToOtherFloors/reflectStructuralAfterFinishExit）が temp インスタンス自体
  // ではなく temp.beamColumnWidthMm（数値）だけを控えていること（配線側の固定）。
  assert.ok(/beamColumnWidthByPlaneId\.set\(plane\.id, temp\.beamColumnWidthMm\)/.test(src),
    'reflectStructuralToOtherFloorsがtempインスタンス自体を保持している（beamColumnWidthMm数値だけを保持する規律に反する）');
  assert.ok(/touchedByPlaneId\.set\(planes\[i\]\.id, temp\.beamColumnWidthMm\)/.test(src),
    'reflectStructuralAfterFinishExitがtempインスタンス自体を保持している（beamColumnWidthMm数値だけを保持する規律に反する）');
});

// ---- 実機再QA指摘3: mutate指定時、自階（subjectGraph）自身の再計算が内部で行う下階へのfresh peek
// （floorSwapManagerは毎回IDBから読む）が、mutateで書き換えた下階の編集可能peekのデバウンス保存
// （最大400ms）未反映のまま古い値を読んでしまう競合を、flushEditablePeek()で解消している。
// 自階再計算（recomputeStructuralForGraphの呼び出し＝下階へのfresh peekを含む）より前に
// ちょうど1回awaitされることをスパイで固定する。
// 【前提】このfixtureは壁が無く下階柱集合が変化しない（3a/3b候補が生成されない）——
// columnSetSignatureによる自階再実行（QA3-1〜QA3-6節）は発火しないため、flushは常に1回のまま
// （mutate経路の既存flushのみ）。下階柱集合が変化する場合の2回呼び出しは下の
// 【QA3-6】テストが別に固定する。----
test('recomputeStructuralComposition【実機裁定ステップ4 C-2 QA3】: mutate指定時はflushEditablePeekを自階再計算（下階へのfresh peekを含む）より前に1回awaitする', async () => {
  const project = new Project('proj-c2-qa3-flush', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const calls = [];
  const originalFlush = floorSwapManager.flushEditablePeek;
  const originalPeek = floorSwapManager.peek;
  const peekMap = { p1: g1, p2: g2 };
  floorSwapManager.flushEditablePeek = () => { calls.push('flush'); return Promise.resolve(); };
  floorSwapManager.peek = async (plane) => { calls.push(`peek:${plane.id}`); return peekMap[plane.id] ?? null; };
  try {
    const composition = { graphForCategory: () => g1 };
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });
    assert.equal(calls.filter(c => c === 'flush').length, 1, 'flushEditablePeekがちょうど1回呼ばれる');
    assert.equal(calls[0], 'flush', 'flushEditablePeekが最初（下階へのfresh peekより前）に呼ばれる');
    assert.ok(calls.slice(1).some(c => c.startsWith('peek:')), '前提: flush後に少なくとも1回はpeekが呼ばれる（自階再計算の下階peek）');
  } finally {
    floorSwapManager.flushEditablePeek = originalFlush;
    floorSwapManager.peek = originalPeek;
  }
});

// ---- QA3-6: mutate（各階柱寸法の変更）と下階柱集合の変化（3a柱の新規生成）が同じ呼び出しの中で
// 同時に起きる組合せ。flushEditablePeekはmutate経路（既存・73行目付近）で1回、下階柱集合変化による
// 自階の再実行（151行目付近）でもう1回の計2回呼ばれる。undoでは下階柱寸法・下階の新規柱・自階の
// 分割された梁のすべてが変更前へ戻ることを確認する（afterスナップショットが2回目の再計算より
// 後で取られていることの間接確認——afterを2回目の前に取っていれば分割前の状態がredoされ、
// このアサーションが失敗する）。----
test('recomputeStructuralComposition【QA3-6】: mutateと下階柱集合の変化が同時に起きても自階が再計算され直り、undoで両方とも変更前に戻る（flushEditablePeekは2回）', async () => {
  const project = new Project('proj-mutate-and-resplit', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（mutateの編集対象＝3a柱も新規に立つ）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 通り芯は project.structGraph に置く（undo対象——階固有graphへ直接追加するとrestoreGraphで消える。
  // QA C2 QA2/QA3テストと同じ規律）。
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 1階: 3640×1820の実壁の部屋。柱はまだ1本も無い——この呼び出しの下階編集ブロックで3a柱4本が
  // 新規に立ち、下階柱集合（g1.columns）が変化する条件を作る。
  const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  const originalFlush = floorSwapManager.flushEditablePeek;
  const calls = [];
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  floorSwapManager.flushEditablePeek = () => { calls.push('flush'); return Promise.resolve(); };
  try {
    const composition = { graphForCategory: () => g1 };
    const undoBefore = undoManager.peekUndo();

    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(105); },
    });

    assert.equal(calls.length, 2, 'flushEditablePeekはmutate経路（1回目）と下階柱集合変化による自階再実行（2回目）で計2回呼ばれる');
    assert.ok(g1.columns.length > 0, '前提: 下階に3a柱が新規に立ち、下階柱集合が変化した');
    assert.notEqual(undoManager.peekUndo(), undoBefore, 'undoエントリが1件積まれる');

    undoManager.undo();
    assert.equal(g1.woodColumnWidthMm, null, 'undoで各階柱寸法（下階のmutate）が変更前に戻る');
    assert.equal(g1.columns.length, 0, 'undoで下階に新規に立った3a柱も消える（壁があるだけ・柱ゼロの元の状態へ）');
  } finally {
    floorSwapManager.peek = originalPeek;
    floorSwapManager.flushEditablePeek = originalFlush;
  }
});

// ---- QA3-1: 屋根専用平面の「下階」不一致（2026-09-17指摘、非在来のみ現存）。composition の
// belowGraph（drawingDesignation.js structuralPlaneBelow。屋根なら最上階を返す）と、
// recomputeStructuralForGraph が自前peekする belowGraph（wallBeamAxes.js belowPlaneOf。
// 屋根専用平面はproject.planesに含まれないため常にnull）は別概念——屋根では一致しない。
// 一致しないまま2回目にprecomputedBelowGraph（最上階）を渡すと、1回目（belowGraph=null＝
// 屋根自身の柱寸へフォールバック）と2回目（belowGraph=最上階）とでbeamColumnWidthMmが食い違い、
// 屋根伏図の軒桁材幅が最上階の柱寸へ静かに置き換わる。「屋根専用平面は再実行しない」ガードで
// 固定していた。
//
// 【裁定変更・2026-09-19】在来木造は上の前提が失効した——小屋伏図にも梁・柱ルールを適用する計画
// （.claude/structural-model.md）で「屋根の1つ下＝最上階」と定義し、structuralRecompute.js が
// isRoof のとき peekBelowGraph の代わりに peekRoofBelowGraph（roofForPlaneIdが指す最上階）を使う
// ようになった（ステップ4）ため、1回目・2回目のbelowGraphが常に同じ最上階になり「食い違い」自体が
// 起きない。既存の確定規律「梁幅＝その梁を支える1つ下の実体階の柱寸」（ステップ4 C-2・2026-09-16）
// に照らせば、小屋伏図の梁（軒桁・頭つなぎ）を支えるのは最上階の柱であり、最上階の柱寸(105)こそが
// 正しい値——屋根 graph 自身の柱寸(120)は屋根に柱が無い以上、意味を持たない値である。
// 在来木造は再実行抑止を解除し（structuralOrchestration.js roofReexecBlocked）、軒桁材幅が
// 最上階の柱寸へ揃うことを期待値として固定する（下のテスト・裁定変更）。非在来（roofBeamPlacement:
// 'gridEaves'。RC造・S造等）は旧裁定のまま——wallBeamAxes/framingがいずれも無くbelowGraphの
// 解決自体が起きないため（structuralRecompute.js参照）、旧裁定の理由は非在来では今も有効。----

test('recomputeStructuralComposition【QA3-1・非在来は維持】: 非在来（S造。roofBeamPlacement:gridEaves）は下階(=最上階)柱集合が変化しても自階(屋根)を再計算し直さない（旧裁定2026-09-17を維持）', async () => {
  // 直接の観測対象（beamColumnWidthMm・conformWoodSections）は非在来では常にno-op（rules.framingが
  // 無いため）なので材幅そのものでは「再実行されたか」を判別できない——2回目のrecomputeStructuralForGraph
  // が走れば buildStructuralWallGate・resolveLowestGraph 等が発行する floorSwapManager.peek が
  // 追加で発生するはず、という副作用でregression検知する（柱集合が変化する/しないの2条件を比較し、
  // 変化しても peek 回数が増えない＝2回目が走っていないことを示す）。
  async function run(withColumnGrid) {
    const project = new Project(`proj-roof-steel-${withColumnGrid}`, 'test');
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 最上階
    g1.structureOverride = 'S造';
    g2.structureOverride = 'S造';
    const roofPlane = syncRoofPlane(project);
    const roofGraph = project.graphMap.get(roofPlane.id);
    assert.ok(roofGraph.plane.isRoofPlane, '前提: 屋根専用平面が生成されている');
    roofGraph.structureOverride = 'S造';
    if (withColumnGrid) {
      // 柱グリッドを構成する通り芯（project.structGraph=全階共通）——S造はcolumnPlacement:
      // 'gridIntersections'のため、これだけで2階（最上階）に柱が新規に立ち下階柱集合が変化する。
      project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
      project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
      project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
      project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
    }
    const peekMap = { p1: g1, p2: g2 };
    let peekCount = 0;
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => { peekCount++; return peekMap[plane.id] ?? null; };
    try {
      const composition = { graphForCategory: () => g2 };
      await recomputeStructuralComposition(composition, roofGraph, project, {});
      if (withColumnGrid) assert.ok(g2.columns.length > 0, '前提: 下階(=最上階)に柱が新規に立ち、下階柱集合が変化した');
    } finally {
      floorSwapManager.peek = originalPeek;
    }
    return peekCount;
  }
  const withoutChange = await run(false);
  const withChange = await run(true);
  assert.equal(withChange, withoutChange,
    '非在来は柱集合が変化してもpeek回数が変わらない＝2回目のrecomputeStructuralForGraphが走っていない');
});

test('recomputeStructuralComposition【裁定変更・2026-09-19】: 在来木造は最上階の柱寸(105)と屋根自身の柱寸(120)が異なるとき、下階(=最上階)柱集合の変化で自階(屋根)を再計算し直し、軒桁材幅が最上階の柱寸(105)になる', async () => {
  const project = new Project('proj-roof-below-mismatch', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 最上階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.setWoodColumnWidthMm(105); // 最上階の柱寸

  const roofPlane = syncRoofPlane(project);
  const roofGraph = project.graphMap.get(roofPlane.id);
  assert.ok(roofGraph.plane.isRoofPlane, '前提: 屋根専用平面が生成されている');
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  roofGraph.setWoodColumnWidthMm(120); // 屋根自身の柱寸（1つ下の実体階=最上階が解決できないときのフォールバック値）

  // 通り芯は project.structGraph（全階共通）に置く。
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  // 2階（最上階＝屋根伏図からみた「柱の供給元」）に壁の部屋を新規に置く——この呼び出しの下階編集
  // ブロックで3a柱が新規に立ち、下階柱集合（g2.columns）が変化する条件を作る。
  const room = g2.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g2, room);

  // 屋根伏図の軒桁は在来木造では壁線方式（ステップ5・role:'primary', beamType:'軒桁'）で自動生成される
  // ため、ここでは事前に手動生成しない——生成される梁の材幅（幅）が最上階の柱寸（105）にそろうはず。

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g2 }; // structuralPlaneBelow: 屋根→最上階
    await recomputeStructuralComposition(composition, roofGraph, project, {});

    assert.ok(g2.columns.length > 0, '前提: 下階(=最上階)に3a柱が新規に立ち、下階柱集合が変化した');
    const eaveBeams = roofGraph.beams.filter(b => b.role === 'primary' && b.beamType === '軒桁');
    assert.ok(eaveBeams.length > 0, '前提: 屋根伏図に壁線方式の軒桁(役割primary・beamType軒桁)が生成されている');
    for (const b of eaveBeams) {
      assert.equal(findSectionEntry(b.sectionDefId)?.width, 105,
        '屋根伏図の軒桁の材幅は最上階の柱寸(105)になる（裁定変更・2026-09-19。屋根の1つ下=最上階）');
    }
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// テストの穴（コーディネーター指摘）: roofReexecBlockedを常時trueへ全戻し（旧2026-09-17裁定のまま）
// にする変異が上の「裁定変更」テスト2件のいずれでも赤くならなかった——どちらも1回目のrecompute
// （peekRoofBelowGraph経由で既に最上階を見る。ステップ4）だけで観測値（材幅）が確定してしまうため、
// 2回目の再実行（roofReexecBlocked=falseで許可される分岐）が実際に効くかどうかを区別できていなかった。
// 本テストは「1回目の再計算後に下階(最上階)へ柱が新規に増える」ことそのものを2回目の再計算でしか
// 拾えない観測値（屋根の壁線方式の軒桁が、その新規柱で分割され直るかどうか）で直接固定する。
test('recomputeStructuralComposition【テストの穴・再発防止】: 在来木造の屋根は、1回目の再計算後に下階(最上階)の柱集合が変化したとき、2回目の再計算でその柱により軒桁が分割され直る', async () => {
  const project = new Project('proj-roof-reexec-hole', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 最上階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const roofPlane = syncRoofPlane(project);
  const roofGraph = project.graphMap.get(roofPlane.id);
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 通り芯は project.structGraph（全階共通）に置く。x=1820は屋根自身にもアンカーCLとして必要
  // （3c-2bの下階柱による分割はfindBeamAnchorCLで既存CLへの厳密一致を要求し、3iの柱生成が使う
  // オフセットアンカー(nearestAnchorCL)のフォールバックを共有しない——分割点にする位置には実CLが
  // 要る）。
  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const xm = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   1820, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  void xm;

  // 2階（最上階）に3640×1820の実壁の部屋——長辺(3640>1820)の壁は1回目のroofGraph再計算で
  // 屋根の壁線方式の軒桁として通し1本のまま自動生成され（下階編集ブロックより前に1回目の
  // recomputeStructuralForGraph(subjectGraph=roofGraph)が走るため、この時点ではg2に3i柱はまだ無い）、
  // その後の下階編集ブロックでg2自身の3i（roofGraphの通し軒桁を「上階の梁」として見る）が
  // (1820,0)に新規柱を立てる——columnSetSignatureが変化し、2回目のroofGraph再計算が走る条件になる。
  const room = g2.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g2, room);

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g2 };
    await recomputeStructuralComposition(composition, roofGraph, project, {});

    const newCol = g2.columns.find(c => c.role !== 'foundation' && Math.abs(c.axisX - 1820) < 1 && Math.abs(c.axisY) < 1);
    assert.ok(newCol, '前提: 下階(最上階)に屋根の軒桁由来の3i柱(1820,0)が新規に立ち、柱集合が変化した');

    const eaveSegmentsAtY0 = roofGraph.beams.filter(b => b.role === 'primary' && !b.isVertical && Math.abs(b.axisValue) < 1);
    assert.equal(eaveSegmentsAtY0.length, 2,
      `屋根の軒桁(y=0)は2回目の再計算で下階の新規柱(x=1820)により2本に分割され直る（実測=${eaveSegmentsAtY0.length}本）`);
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

test('recomputeStructuralComposition【裁定変更・2026-09-19】: 在来木造の屋根は1回目（peekRoofBelowGraph経由）・2回目（precomputedBelowGraph）のbelowGraphが同じ最上階になり、軒桁材幅がチャーンしない', async () => {
  const project = new Project('proj-roof-nochurn', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 最上階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.setWoodColumnWidthMm(105);

  const roofPlane = syncRoofPlane(project);
  const roofGraph = project.graphMap.get(roofPlane.id);
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  roofGraph.setWoodColumnWidthMm(120);

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g2.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g2, room);
  // 屋根伏図の軒桁は在来木造では壁線方式（ステップ5）で自動生成される——事前に手動生成しない。

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    // 1回目相当: recomputeStructuralForGraph単体（structuralRecompute.jsのpeekRoofBelowGraphが
    // 直接この時点で最上階g2を解決するため、1回目の時点で既に材幅(width)は105へそろっているはず）。
    // 注意: 成(depth)はbelowGraph.columns（この時点ではg2にまだ3a柱が無い）に依存するため対象外
    // ——チャーンしないと確定できるのは「梁幅＝支える1つ下の実体階の柱寸」の対象である材幅(width)
    // だけで、支持点の増減で変わりうる成(depth)は含めない（3bの「1回遅れ」節と同種の既知の性質）。
    await recomputeStructuralForGraph(roofGraph, project, TRADITIONAL_WOOD_STRUCTURE);
    const afterFirstCallOnly = new Map(
      roofGraph.beams.filter(b => b.role === 'primary' && b.beamType === '軒桁')
        .map(b => [b.id, findSectionEntry(b.sectionDefId)?.width]));
    assert.ok(afterFirstCallOnly.size > 0, '前提: 1回目で壁線方式の軒桁が生成されている');
    for (const width of afterFirstCallOnly.values()) {
      assert.equal(width, 105, '1回目の時点で既に最上階基準(105)——2回目を待たない');
    }

    // フル経路（1回目+条件付き2回目）を通しても、id・材幅(width)とも変わらない（チャーンしない＝
    // 撤去→再生成が起きていない）。
    const composition = { graphForCategory: () => g2 };
    await recomputeStructuralComposition(composition, roofGraph, project, {});
    const afterFullPath = new Map(
      roofGraph.beams.filter(b => b.role === 'primary' && b.beamType === '軒桁')
        .map(b => [b.id, findSectionEntry(b.sectionDefId)?.width]));
    assert.deepEqual(afterFullPath, afterFirstCallOnly, '2回目が走っても軒桁のid・材幅(width)はチャーンしない');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- QA3-2: precomputedBelowGraph（structuralRecompute.js第4引数）を落とすと全スイート緑になって
// しまう（変異で確認済み）ことへの対策テスト。floorSwapManager.peek が常に「古い（3b柱を含まない）
// シリアライズ済みコピー」を返す状況（IDBが未反映のまま、という本番の実際の状態）を再現し、
// compositionの下階graphは生のライブオブジェクト（peekではない）を返す——2回目の再計算が
// precomputedBelowGraphでこのライブオブジェクトを直接使わず、peekし直していたら（4引数を
// 落とす変異と同じ）、古いコピーを読んで分割されないままになる。----
test('recomputeStructuralComposition【QA3-2】: 下階のpeekが古い（3b柱を含まない）シリアライズ済みコピーを返しても、compositionの下階graphを直接使って自階の梁が分割され直る', async () => {
  const project = new Project('proj-stale-peek', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（peekは常に古いコピーを返す）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT }); // 3b柱アンカー

  const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  // このrecompute呼び出し前（柱ゼロ）のg1をIDBの「古い」スナップショットとして固定する——
  // floorSwapManager.peekは常にこのバイト列から作り直したコピーを返し、g1本体への以後の変更
  // （3b柱追加等）を一切反映しない（IDB未反映を模す）。
  const staleG1Bytes = serializeGraph(g1);

  const xMid = project.structGraph.centerLines.find(cl => cl.value === 1820 && cl.centerLineType === CenterLineType.VERTICAL);
  const y0b = y0;
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xMid, y0b, {});

  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => {
    if (plane.id === 'p1') {
      const stale = new PlanGraph(plane);
      stale._structGraph = project.structGraph;
      restoreGraph(stale, staleG1Bytes);
      return stale;
    }
    if (plane.id === 'p2') return g2;
    return null;
  };
  try {
    const composition = { graphForCategory: () => g1 }; // peekではなく生のg1を直接返す
    await recomputeStructuralComposition(composition, g2, project, {});

    assert.ok(g1.columns.length > 0, '前提: 生のg1には3b柱が新規に立った（peekの古いコピーには反映されない）');
    const splitBeams = g2.beams.filter(b => b.role === 'primary' && !b.isVertical && Math.abs(b.axisValue - 0) < 1);
    assert.equal(splitBeams.length, 2,
      'peekが古いコピーを返しても、compositionの下階graphを直接使うことで自階の梁が分割され直る');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 実機再々QA指摘1: reflectStructuralToOtherFloors はアクティブ階を recomputeStructuralForGraph
// （structuralRecompute.js）経由しない「収集だけ」の軽量経路のため、beamColumnWidthMm（下階基準の
// 派生値）を誰も書かない窓ができる——文書読込み直後・構造モードのままの階切替直後
// （runStructuralModeSetupがこのreflectをrecomputeStructuralCompositionより前に呼ぶ）は
// アクティブ階が未再計算=nullのまま自階フォールバックでcollect/applyが走り、標準材の判定が
// 一瞬だけ自階基準へずれる（実機観測: moku1・1階=105・アクティブ2階で、突入直後の反映パスで
// 105×120×9本が2G18〜2G26へ分裂→直後の自階再計算で2G18へ戻る）。----
// コメントを除去してから走査する（memberCatalog.test.js/structureRules.test.js の scanOffenders と
// 同じ方針）——コメントアウトで実装を無効化した変異（mutation test）でも赤くなるようにするため、
// 行コメント（`// …`）・ブロックコメント行（先頭`*`／`/*`）の内容は判定対象から除く。
function stripComments(src) {
  return src.split(/\r?\n/)
    .map(line => (line.trim().startsWith('*') || line.trim().startsWith('/*')) ? '' : line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('【不変条件・実機再々QA指摘1】structuralOrchestration.js: reflectStructuralToOtherFloors はアクティブ階の collectFloorGroups の直前に beamColumnWidthMm の派生値を書く', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = stripComments(fs.readFileSync(path.join(here, 'structuralOrchestration.js'), 'utf8'));
  // reflectStructuralToOtherFloors本体を抜き出し、その中で
  // 「setBeamColumnWidthMm(...) の呼び出し」→「collectFloorGroups(project.activeGraph, project)」の順に
  // 現れることを確認する（間に他の分岐が挟まっても良いが、setBeamColumnWidthMmが必ず先に実行される
  // ソース上の位置関係を固定する）。
  // ステップB-5でctx引数はctxArgへ改名され、本体全体がwithResolveContext(ctxArg, async (ctx) => {...})の
  // コールバックへ包まれた（省略時に自分でコンテキストを生成してdisposeするため）。
  const fnMatch = /export async function reflectStructuralToOtherFloors\(project, ctxArg = undefined\) \{\r?\n\s*return withResolveContext\(ctxArg, async \(ctx\) => \{([\s\S]*?)\r?\n\s*\}\);\r?\n\}/.exec(src);
  assert.ok(fnMatch, 'reflectStructuralToOtherFloors関数本体が見つからない');
  const body = fnMatch[1];
  const setIdx = body.search(/project\.activeGraph\.setBeamColumnWidthMm\(beamColumnWidthMm\(project\.activeGraph, belowForActive, project\)\)/);
  const collectIdx = body.search(/collectFloorGroups\(project\.activeGraph, project\)/);
  assert.notEqual(setIdx, -1, 'project.activeGraph.setBeamColumnWidthMm(beamColumnWidthMm(...)) が見つからない（コメントアウトされている可能性）');
  assert.notEqual(collectIdx, -1, 'collectFloorGroups(project.activeGraph, project) が見つからない');
  assert.ok(setIdx < collectIdx, 'setBeamColumnWidthMm が collectFloorGroups(project.activeGraph, ...) より後にある（順序が逆）');
});

// ---- B-4（2026-09-19）: 反映パス（reflectStructuralToOtherFloors の再計算ループ）は最上階→最下階の
// 降順で回す（ユーザー裁定「柱の追加は最上階から順に、最下階まで可能な限り同位置に」）。project.planes は
// elevation昇順（core/project.js）のため、降順で回すには [...project.planes].reverse() を使う必要がある
// ——挙動テスト（実際にpeek順序を記録する）はIDB依存（saveFloor）のため断念し、既存の不変条件テストと
// 同じソース走査に留める（本ファイル冒頭コメント参照）。----
test('【不変条件・B-4】structuralOrchestration.js: reflectStructuralToOtherFloors の再計算ループは project.planes を降順（reverse）で回す', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = stripComments(fs.readFileSync(path.join(here, 'structuralOrchestration.js'), 'utf8'));
  // ステップB-5でctx引数はctxArgへ改名され、本体全体がwithResolveContext(ctxArg, async (ctx) => {...})の
  // コールバックへ包まれた（省略時に自分でコンテキストを生成してdisposeするため）。
  const fnMatch = /export async function reflectStructuralToOtherFloors\(project, ctxArg = undefined\) \{\r?\n\s*return withResolveContext\(ctxArg, async \(ctx\) => \{([\s\S]*?)\r?\n\s*\}\);\r?\n\}/.exec(src);
  assert.ok(fnMatch, 'reflectStructuralToOtherFloors関数本体が見つからない');
  const body = fnMatch[1];
  assert.ok(/for \(const plane of \[\.\.\.project\.planes\]\.reverse\(\)\) \{[\s\S]*?recomputeInactiveStructural\(plane, project, ctx\)/.test(body),
    '再計算ループ（recomputeInactiveStructuralを呼ぶfor文）が [...project.planes].reverse() で回っていない');
  // 採番の適用ループ（下段）は建物全体で1回・順序非依存のため昇順のまま据え置く（変更対象外）。
  assert.ok(/for \(const plane of project\.planes\) \{[\s\S]*?applyMemberNumbersToFloor\(plane, tags, project/.test(body),
    '採番の適用ループが project.planes（昇順のまま）を回っていない（意図せず変更されている可能性）');
});

// ---- 小屋伏図にも梁・柱ルールを適用する計画（ステップ7）: 反映パスの降順ループの先頭に屋根 ----
test('【不変条件・ステップ7】structuralOrchestration.js: reflectStructuralToOtherFloors は降順ループ（[...project.planes].reverse()）の前にreflectRoofPlaneを呼ぶ', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = stripComments(fs.readFileSync(path.join(here, 'structuralOrchestration.js'), 'utf8'));
  // ステップB-5でctx引数はctxArgへ改名され、本体全体がwithResolveContext(ctxArg, async (ctx) => {...})の
  // コールバックへ包まれた（省略時に自分でコンテキストを生成してdisposeするため）。
  const fnMatch = /export async function reflectStructuralToOtherFloors\(project, ctxArg = undefined\) \{\r?\n\s*return withResolveContext\(ctxArg, async \(ctx\) => \{([\s\S]*?)\r?\n\s*\}\);\r?\n\}/.exec(src);
  assert.ok(fnMatch, 'reflectStructuralToOtherFloors関数本体が見つからない');
  const body = fnMatch[1];
  assert.ok(/await reflectRoofPlane\(project, ctx\);[\s\S]*?for \(const plane of \[\.\.\.project\.planes\]\.reverse\(\)\)/.test(body),
    'reflectRoofPlane(project, ctx) の呼び出しが降順ループより前に無い（小屋伏図→最上階→…→最下階の順にならない）');
});

// ---- 反映は収束するまで繰り返す（リード裁定・2026-09-19）----

// repeatReflectPassUntilConverged（純粋なループ本体。runPassをスタブに差し替えられる）を直接検証する。
test('repeatReflectPassUntilConverged: sawWallRuns=falseなら1回で止まる（非在来だけの建物と同じ挙動）', async () => {
  let calls = 0;
  await repeatReflectPassUntilConverged(async () => { calls++; return { anyChanged: true, sawWallRuns: false }; }, 'test');
  assert.equal(calls, 1, 'sawWallRunsが立たなければanyChangedがtrueでも1回で止まる');
});

test('repeatReflectPassUntilConverged: anyChanged=falseになった時点で止まる（収束）', async () => {
  let calls = 0;
  await repeatReflectPassUntilConverged(async () => {
    calls++;
    return { anyChanged: calls < 3, sawWallRuns: true }; // 1・2回目はchanged、3回目でfalse
  }, 'test');
  assert.equal(calls, 3, '3回目でanyChanged=falseになった時点（収束）で止まる');
});

test('【失敗系】repeatReflectPassUntilConverged: 常にchangedを返すスタブはMAX_REFLECT_PASSES回で打ち切り、console.warnで1回だけ知らせる', async () => {
  let calls = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await repeatReflectPassUntilConverged(async () => { calls++; return { anyChanged: true, sawWallRuns: true }; }, 'testLabel');
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls, MAX_REFLECT_PASSES, `上限${MAX_REFLECT_PASSES}回で打ち切る（例外にしない）`);
  assert.equal(warnings.length, 1, 'console.warnは1回だけ');
  assert.ok(warnings[0].includes('testLabel') && warnings[0].includes(String(MAX_REFLECT_PASSES)), 'warnメッセージにlabelと上限回数を含む');
});

// 実際のreflectStructuralToOtherFloors/reflectStructuralAfterFinishExitを、最小限の自前IndexedDB
// シム（withFakeIndexedDB）でsaveFloorまで通して検証する——従来「断念」していたIDB依存を、
// 新規npm依存を追加しない自前シムで解消した（上のwithFakeIndexedDB定義のコメント参照）。
// 【QA第2巡Major-3是正】floorSwapManager.peekを生きたgraphMapへの素通しにスタブしていたため
// 「保存されたか」を検証できていなかった（同じ落とし穴はR-3の2テストにもあった）。real peek
// （withFakeIndexedDB＋実saveFloor）に置き換え、CLもproject.structGraphへ移す（Major-1と同じ理由）。
test('【統合・収束】reflectStructuralToOtherFloors: 在来木造の複数階＋屋根フィクスチャで、外部から1回呼ぶだけで収束する（続けてもう1回呼んでも部材ダンプが変わらない。本番peekで再読込して確認）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-converge-once', 'test');
    project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE; // 屋根は未保存のまま最初にpeekされるため（Major-1と同じ理由）
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 最上階
    g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

    // 2階: 3640×1820の実壁の部屋（短辺1820・長辺3640>1820）。長辺の壁は内部に交点が無いため、
    // 通し1本のまま3i（支持長1820超）の対象になり、x=1820の位置（走行方向アンカー用の通り芯を
    // 別途置く）に2階自身の柱が立つ。
    const gx0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const gx1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
    const gy0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const gy1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
    const room = g2.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
    generateRoomWallsFromOutline(g2, room);
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

    const roofPlane = syncRoofPlane(project);
    const roofGraph = project.graphMap.get(roofPlane.id);
    roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    // syncRoofPlane（内部でproject.addPlaneを呼ぶ）は、activePlaneIdが未設定のときそのplaneを
    // アクティブにする（core/project.js addPlane）——ここより前にnullへ戻すと屋根がアクティブに
    // なってしまい reflectRoofPlane の「アクティブなら何もしない」ガードに掛かる。誰もアクティブで
    // ない状態（全階を反映対象にする）にするのは、屋根を含む全plane生成が終わった後で行う。
    project.activePlaneId = null;

    // 実IDB往復のfloorSwapManager.peekが空の一時graphを返さないよう、g1・g2は事前に保存する
    // （屋根はまだ一度も保存されていない前提のまま——reflectRoofPlaneの初回反映で生成・保存される）。
    await saveFloor('p1', serializeGraph(g1));
    await saveFloor('p2', serializeGraph(g2));

    // このフィクスチャは内部で複数パスを要する（実測: 屋根→2階→1階の1パス目・2パス目はanyChanged=true、
    // 3パス目でanyChanged=falseに収束）。ループ機構そのものの回帰は上のrepeatReflectPassUntilConverged
    // 単体テスト（スタブでMAX_REFLECT_PASSES到達・収束を直接固定・変異で赤化確認済み）が担う——ここでは
    // 実際のreflectStructuralToOtherFloors／reflectRoofPlane／recomputeInactiveStructuralが正しく配線され、
    // 屋根込みで例外なく完全収束することをエンドツーエンドで確認する（peek回数は複数パスが実際に
    // 走ったことの参考値。厳密な変異検知はしない）。
    // 【B-5是正・2026-09-21】ctx: null を明示し「コンテキストを使わない従来経路」に固定する——
    // 省略（自前生成）だと1回の反映処理の間に同じ階のpeek結果が使い回されるため、この参考値
    // （複数階×複数パス分のpeekが実際に発生したこと）の指標にならない（B-4の同型是正と同じ理由。
    // 上のコメント参照）。コンテキスト経路のpeek削減はstructuralResolveContext.test.js（B-5節）の
    // 専用テストで別途検証する。
    let peekCount = 0;
    const originalPeek = floorSwapManager.peek.bind(floorSwapManager);
    floorSwapManager.peek = async (...args) => { peekCount++; return originalPeek(...args); };
    try {
      await reflectStructuralToOtherFloors(project, null); // 外部からの呼び出しは1回だけ
      assert.ok(peekCount > 6, `参考値: 内部で複数階×複数パス分のpeekが発生している（実測peek回数=${peekCount}）`);

      // 実体階・屋根とも、非アクティブ階はrecomputeが本番同型peekの一時graphに対して行われ
      // saveFloorされる。graphMapの生グラフは更新されないため、確認は再peekで行う（本番同型）。
      async function dump() {
        const out = {};
        for (const p of [...project.planes, roofPlane]) {
          const g = await floorSwapManager.peek(p, project.structGraph);
          out[p.name] = {
            columns: g.columns.map(c => `${c.role}:${Math.round(c.x)},${Math.round(c.y)}`).sort(),
            beams: g.beams.map(b => `${b.role}:${b.beamType ?? ''}:${b.isVertical}:${Math.round(b.axisValue)}:` +
              `${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}`).sort(),
          };
        }
        return out;
      }
      const dumpAfterOnce = await dump();
      assert.ok(dumpAfterOnce['2階'].columns.length > 0 && dumpAfterOnce['2階'].beams.length > 0,
        '前提: 保存された2階は空ダンプであってはならない（save→本番peek往復で壁・CLが失われていないことの構造的な担保）');
      assert.ok(dumpAfterOnce[''].beams.some(b => b.includes(':軒桁:')),
        '前提: 屋根は壁線方式の軒桁(beamType=\'軒桁\')を1本以上持つ');
      await reflectStructuralToOtherFloors(project); // もう1回呼んでも
      const dumpAfterTwice = await dump();
      assert.deepEqual(dumpAfterTwice, dumpAfterOnce, '外部からもう1回呼んでも部材ダンプが変わらない（1回目で既に収束している。本番peekで再読込して確認）');
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  });
});

// ---- R-3（2026-09-19是正）: 採番の適用ループへ屋根を含める ----
// 【QA第2巡Major-3是正】以前はfloorSwapManager.peekを生きたgraphMapへの素通しにスタブしており、
// g2・roofGraph（ともに非アクティブ＝実際は本番同型peekの一時graphに対して再計算・保存される）を
// 直接参照していたため「保存されたか」ではなく「同一オブジェクトか」を見ていた（saveFloor削除の
// 変異で赤化しない）。real peek（withFakeIndexedDB＋実saveFloor）に置き換え、確認は全て
// 再peekしたインスタンスに対して行う。CLもproject.structGraphへ移す（Major-1と同じ理由）。
test('【R-3】reflectStructuralToOtherFloors: 屋根の梁（role:primary）にも採番が適用され、memberNoが保存される（同じ材寸グループの実体階の梁と同じタグ。本番peekで再読込して確認）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-r3-roof-numbering', 'test');
    project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE; // 屋根は未保存のまま最初にpeekされるため（Major-1と同じ理由）
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 最上階
    g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

    // 1階: 遠く離れた小部屋（1000×1000。短スパン＝成表の最小値120で幅120角＝WOOD-120x120になる）。
    // wallRunSegments(g2, g1, ...)経由でg2側の壁線にもこの小部屋の壁が合流し、g2にも同じ断面の梁が
    // 生成される——屋根の梁（同じくWOOD-120x120）と実体階（g2）の梁が同じ材寸グループを共有する
    // 状況を作る（あとで両者のタグが一致することを確認する）。
    const hx0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
    const hx1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 11000, { labeled: true, discipline: Discipline.STRUCT });
    const hy0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 10000, { labeled: true, discipline: Discipline.STRUCT });
    const hy1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 11000, { labeled: true, discipline: Discipline.STRUCT });
    const hroom = g1.addRoom(new Set([`${hx0.id}:${hy0.id}:${hx1.id}:${hy1.id}`]), 'H');
    generateRoomWallsFromOutline(g1, hroom);

    const gx0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const gx1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
    const gy0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const gy1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
    const room = g2.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
    generateRoomWallsFromOutline(g2, room);
    project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

    const roofPlane = syncRoofPlane(project);
    const roofGraph = project.graphMap.get(roofPlane.id);
    roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    project.activePlaneId = null;

    // 実IDB往復のfloorSwapManager.peekが空の一時graphを返さないよう、g1・g2は事前に保存する。
    await saveFloor('p1', serializeGraph(g1));
    await saveFloor('p2', serializeGraph(g2));

    await reflectStructuralToOtherFloors(project);

    // g2・屋根とも非アクティブ＝recomputeは本番同型peekの一時graphに対して行われ保存される
    // （graphMapの生グラフ g2・roofGraph 自体は更新されない）。確認は再peekしたインスタンスで行う。
    const rePeekedG2 = await floorSwapManager.peek(project.planes.find(p => p.id === 'p2'), project.structGraph);
    const rePeekedRoof = await floorSwapManager.peek(roofPlane, project.structGraph);
    const roofBeams = rePeekedRoof.beams.filter(b => b.role === 'primary');
    assert.ok(roofBeams.length > 0, '前提: 屋根に大梁(role:primary、壁線方式の軒桁)が生成されている');
    for (const b of roofBeams) {
      assert.ok(b.memberNo != null, `屋根の梁(${b.beamType}:${b.isVertical}:${Math.round(b.axisValue)})のmemberNoが再peekでも非null（saveFloor済み）`);
    }
    // 同じ断面(材寸グループ)の実体階(g2)側の梁と同じタグを共有する（WOOD-120x120グループ）。
    const g2Small = rePeekedG2.beams.filter(b => b.role === 'primary' && b.sectionDefId === 'WOOD-120x120');
    const roofSmall = roofBeams.filter(b => b.sectionDefId === 'WOOD-120x120');
    assert.ok(g2Small.length > 0 && roofSmall.length > 0, '前提: g2・屋根とも WOOD-120x120 の大梁を持つ');
    assert.ok(roofSmall.every(rb => rb.memberNo === g2Small[0].memberNo),
      `同じ材寸グループ(WOOD-120x120)なら屋根の梁も実体階(g2)の梁と同じタグを共有する（g2=${g2Small[0].memberNo}, roof=${roofSmall.map(b => b.memberNo)}）`);
    assert.ok(/R/.test(roofSmall[0].memberNo), `共有タグには屋根の階プレフィックス"R"が含まれるはず（実際:${roofSmall[0].memberNo}）`);
  });
});

test('【失敗系・R-3】reflectStructuralToOtherFloors: 非在来（S造。roofBeamPlacement:gridEaves）の屋根はmemberNoを書き戻さない（従来どおり収集のみ）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-r3-nonwood-roof', 'test');
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    g1.structureOverride = 'S造';
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
    const roofPlane = syncRoofPlane(project);
    const roofGraph = project.graphMap.get(roofPlane.id);
    roofGraph.structureOverride = 'S造';
    project.activePlaneId = null;

    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => project.graphMap.get(plane.id) ?? null;
    try {
      // 非在来の屋根専用平面はreflectRoofPlaneが「収集だけ」（!roofRules.framing早期return）で
      // 自階再計算・保存をしない（実際のジオメトリ生成はユーザーが屋根伏図を直接訪れたときの
      // 通常経路に委ねる既存の割り切り）——ここでは「直接訪れた」を模して先に1回だけ自階再計算する。
      await recomputeStructuralForGraph(roofGraph, project, 'S造');
      const roofBeams = roofGraph.beams.filter(b => b.role === 'eaves');
      assert.ok(roofBeams.length > 0, '前提: 屋根に軒桁(role:eaves、通り芯グリッド方式)が生成されている');
      assert.equal(roofBeams.every(b => b.memberNo == null), true, '前提: 生成直後はmemberNo未確定');

      await reflectStructuralToOtherFloors(project);
      assert.ok(roofBeams.every(b => b.memberNo == null), '非在来の屋根はmemberNoを書き戻さない（従来どおり収集のみ）');
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  });
});

test('【統合】reflectStructuralToOtherFloors: 非在来（S造）は各非アクティブ階が1パスだけ再計算される（peek回数固定。sawWallRunsが立たないため繰り返さない）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-nonwood-onepass', 'test');
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
    project.activePlaneId = null;
    g1.structureOverride = 'S造';
    g2.structureOverride = 'S造';
    // 柱グリッドを構成する通り芯（毎回changed=trueになるよう、まだ柱が無い状態から始める）。
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

    const peekCounts = new Map();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async (plane) => {
      peekCounts.set(plane.id, (peekCounts.get(plane.id) ?? 0) + 1);
      return project.graphMap.get(plane.id) ?? null;
    };
    try {
      // 【B-5是正・2026-09-21】ctx: null を明示し「コンテキストを使わない従来経路」に固定する——
      // 省略（自前生成）だと同じ階への複数箇所からのpeekがコンテキスト経由で使い回され、下記の
      // 手動導出した内訳（実peek回数）の前提が崩れる（B-4の同型是正と同じ理由）。コンテキスト経路の
      // peek削減はstructuralResolveContext.test.js（B-5節）の専用テストで別途検証する。
      await reflectStructuralToOtherFloors(project, null);
      // 実測（1内部パスのときの内訳。手動導出・再発検知用）: p1（最下階）=3
      // （自身のrecomputeInactiveStructural由来1 + p2のbuildStructuralWallGate/resolveLowestGraphが
      // 下階として参照する分2） + 採番の適用フェーズ（applyMemberNumbersToFloor。反映パスの繰り返しとは
      // 無関係に建物全体で1回だけ回る）1 = 4ではなく3（p2の下階参照2件のうち1件は自身がidx=0＝
      // 最下階のためbuildStructuralWallGateのループがp1自身をactiveGraphとして直接返しpeekを経由しない
      // ケースと、p2からの2件の実測値）。p2（最上階）=2（自身のrecomputeInactiveStructural由来1 +
      // 採番の適用フェーズ1）。**このテストの目的はpeek回数の内訳を厳密に説明することではなく**、
      // 「反映対象に在来木造の階が無ければ、いずれかの階のchangedに関わらず内部パスが2回目へ進まない」
      // ことを固定すること——sawWallRunsのガードを外す変異でこの値が増える（下のmutation testで実測）。
      assert.equal(peekCounts.get('p1'), 3, '1階のpeek回数（内部パス1回分の基準値）');
      assert.equal(peekCounts.get('p2'), 2, '2階のpeek回数（内部パス1回分の基準値）');
    } finally {
      floorSwapManager.peek = originalPeek;
    }
  });
});

// ---- B-1（リード裁定2026-09-19）: 構造モード突入の1回で、アクティブ階を含む全階を収束させる ----
// 「REALなfloorSwapManager.peekをfake-IndexedDBの往復越しに使う（生グラフmapのスタブ禁止）」
// （team-lessons「peekスタブは本番同型に」）に従い、floorSwapManager.peekは差し替えず、
// withFakeIndexedDBでsaveFloor/loadFloorだけをフェイクIDBへ向ける。

// 1階・2階・3階（全て在来木造・同一形状の部屋）＋屋根の4階建てフィクスチャ。
// 各階同一位置（3640×1820、x=1820にアンカー用通り芯）にすることで、上階柱の直下（3b）・
// 支持長超過候補の910グリッド（3i）が階をまたいで同じ位置に並び、上階の変化が下階へ伝播する
// 状況を作る（B-1が無いと、アクティブ階の再計算で新たに生じた変化が他階の反映パスへ伝わらない）。
// 【QA第2巡Major-1是正】通り芯は project.structGraph（全階共通）へ置く——階固有の
// graph.addCenterLine でSTRUCT種別を作ると、壁のCL参照（axisCLId等）がsaveFloor→本番peek
// （floorSwapManager.peek）のrestoreGraphで解決できず、壁が復元後に消える落とし穴がある
// （R-6(2)で発見・回避したものと同じ。旧実装はここを踏んでおり、【統合・B-1】5本＋【R-4】が
// 実は「save→peek往復で壁4→0・CLが消え、突入1回後は柱0梁0」という空ダンプ同士の比較になっていた）。
// 全floorで共有する4本のCL（gx0/gx1/gy0/gy1）はbuildB1Fixtureが1回だけ生成し、ここへ渡す。
// addDefaultDimensionLines・buildWoodFloorForB1 は structuralOrchestrationFixtures.js（両テスト
// ファイルの共有モジュール）から import する（寸法線を省くと save→peek・undoのrestoreGraph初回だけ
// 新規追加されて比較が揺れる、という理由は同ファイルのコメント参照）。

function buildB1Fixture() {
  const project = new Project('proj-b1', 'test');
  // 【QA第2巡Major-1是正】屋根はsyncRoofPlane直後はまだ一度もsaveFloorされていないため、
  // floorSwapManager.peekが返す一時graphはstructureOverrideを引き継がない（空のPlanGraphのまま
  // ＝graph.structureOverrideを後から設定してもpeekした一時graphには乗らない）。建物全体既定値
  // （project.structuralInfo.mainStructure）を在来木造にしておくことで、未保存の屋根もeffectiveStructure
  // 経由で正しく在来木造に解決され、壁線方式の軒桁（role:primary）を通る（R-6(2)と同じ配線）。
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const gx0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  project.structGraph.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT }); // 走行方向アンカー
  const gridCLs = { gx0, gx1, gy0, gy1 };
  buildWoodFloorForB1(project, 0,    '1階', 'p1', gridCLs);
  buildWoodFloorForB1(project, 3000, '2階', 'p2', gridCLs);
  buildWoodFloorForB1(project, 6000, '3階', 'p3', gridCLs);
  const roofPlane = syncRoofPlane(project); // project.addPlaneを内部で呼ぶ（activePlaneId未設定なら自動採用に注意）
  const roofGraph = project.graphMap.get(roofPlane.id);
  roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE; // アクティブ=屋根のときはメモリ直読みなので有効
  project.activePlaneId = null; // syncRoofPlaneの後で（前だと屋根が自動でアクティブになる）
  return { project, roofPlane };
}

// 【QA第2巡Major-1是正】空ダンプ同士の比較で緑になることを構造的に防ぐ——各実体階は柱・梁とも
// 1本以上、屋根は壁線方式の軒桁（beamType='軒桁'）を1本以上持つことを直接アサートする。
function assertB1NonEmpty(dump, label) {
  for (const floorName of ['1階', '2階', '3階']) {
    const d = dump[floorName];
    assert.ok(d.columns.length > 0 && d.beams.length > 0,
      `アクティブ=${label}: ${floorName}は空ダンプであってはならない（save→本番peek往復で壁・CLが失われていないことの構造的な担保。実際: columns=${d.columns.length} beams=${d.beams.length}）`);
  }
  const roofDump = dump['']; // 屋根専用平面のnameは常に''（syncRoofPlane参照）
  assert.ok(roofDump.beams.some(b => b.includes(':軒桁:')),
    `アクティブ=${label}: 屋根は壁線方式の軒桁(beamType='軒桁')を1本以上持つ（実際:${JSON.stringify(roofDump.beams)}）`);
}

async function saveB1InitialFloors(project) {
  for (const p of project.planes) {
    await saveFloor(p.id, serializeGraph(project.graphMap.get(p.id)));
  }
}

// アクティブ階はメモリ（project.activeGraph）を直接読み、非アクティブ階だけ実peekで読む
// （実運用と同じ——アクティブ階のauto-saveは確定保存されるまでdirty印だけのため）。
async function dumpB1AllFloors(project) {
  const out = {};
  for (const p of [...project.planes, project.roofPlane].filter(Boolean)) {
    const g = p.id === project.activePlaneId ? project.activeGraph : await floorSwapManager.peek(p, project.structGraph);
    out[p.name] = {
      columns: g.columns.map(c => `${c.role}:${Math.round(c.x)},${Math.round(c.y)}`).sort(),
      beams: g.beams.map(b => `${b.role}:${b.beamType ?? ''}:${b.isVertical}:${Math.round(b.axisValue)}:` +
        `${Math.round(Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue))}..${Math.round(Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue))}`).sort(),
    };
  }
  return out;
}

for (const label of ['屋根', '3階', '2階', '1階']) {
  test(`【統合・B-1】runStructuralModeSetup: アクティブ階=${label}でも突入1回で全階（屋根＋各実体階）が収束する（実IDB往復のfloorSwapManager.peek使用）`, async () => {
    await withFakeIndexedDB(async () => {
      const { project, roofPlane } = buildB1Fixture();
      await saveB1InitialFloors(project);
      const activePlane = label === '屋根' ? roofPlane : project.planes.find(p => p.name === label);
      project.activePlaneId = activePlane.id;
      try {
        await runStructuralModeSetup(project.activeGraph, project, {});
        const dumpAfterOnce = await dumpB1AllFloors(project);
        assertB1NonEmpty(dumpAfterOnce, label);

        // 突入1回の直後に「他階だけの反映」をもう一度外部から呼んでも変わらない＝突入の中で
        // 他階もアクティブ階の最新状態を前提に収束済み（B-1が無いと、屋根／上階の再計算が生んだ
        // 新しい柱・梁がまだ他階へ伝わっておらず、ここで初めて変化してしまう）。
        await reflectStructuralToOtherFloors(project);
        const dumpAfterExtraReflect = await dumpB1AllFloors(project);
        assert.deepEqual(dumpAfterExtraReflect, dumpAfterOnce,
          `アクティブ=${label}: 突入1回の後、他階だけの反映をさらに1回呼んでも部材ダンプが変わらない（他階も収束済み）`);

        // 2回目の突入（構造モードを出て入り直した相当）でも同じ結果に安定する。
        await runStructuralModeSetup(project.activeGraph, project, {});
        const dumpAfterSecondEntry = await dumpB1AllFloors(project);
        assert.deepEqual(dumpAfterSecondEntry, dumpAfterOnce,
          `アクティブ=${label}: 2回目の突入でも部材ダンプが変わらない`);
      } finally {
        await figureBindingManager.deactivate();
      }
    });
  });
}

// ---- R-4（2026-09-19）: 外側ループ（runStructuralModeSetup）本体が複数パス回ることを実測で固定する ----
// 上のB-1テスト群は「収束後の最終状態」だけを比較しており、外側ループを1回でbreakする変異（前の
// builderが報告した「外側ループ本体を1回でbreakする変異で5本が赤くならない」不具合）を検出できない
// ——buildB1Fixtureは在来木造の初回突入で必ず2パス（1回目changed=true・2回目changed=falseで収束）
// 実行するため、ここでは「初回突入のpeek回数」を実測し固定することで、外側ループが1回で打ち切られる
// 変異（`for (let pass = 1; pass <= MAX_REFLECT_PASSES; pass++)` を `pass <= 1` 等にする）を検出する
// ——1回で打ち切られると2パス目のreflectStructuralToOtherFloors・recomputeStructuralCompositionが
// 呼ばれずpeek回数が実測値未満に減る。
// 【B-4是正・2026-09-21】ctx: null を明示し「コンテキストを使わない従来経路」に固定する——
// ctx省略（デフォルト）だと本関数が自分でコンテキストを生成し、2パス目のfloorSwapManager.peekの
// 大半がコンテキストの保持ヒットで置き換わり実測値が激減する（peek回数がもはや「パス数」の代理
// 指標にならない。B-4の意図どおりの結果——A/B等価はstructuralResolveContext.test.jsの専用テスト群
// （B-4節）で別途検証する）。本テストの目的（外側ループが1回でbreakする変異の検出）は従来経路
// （ctx:null）に固定してこそ意味を持つため、ここではctx:nullを明示する。
test('【R-4】runStructuralModeSetup: アクティブ階=3階の初回突入は外側ループが2パス実行される（peek回数で固定・ctx:null=従来経路。1回でbreakする変異を検出）', async () => {
  await withFakeIndexedDB(async () => {
    const { project, roofPlane } = buildB1Fixture();
    void roofPlane;
    await saveB1InitialFloors(project);
    const activePlane = project.planes.find(p => p.name === '3階');
    project.activePlaneId = activePlane.id;
    let peekCount = 0;
    const originalPeek = floorSwapManager.peek.bind(floorSwapManager);
    floorSwapManager.peek = async (...args) => { peekCount++; return originalPeek(...args); };
    try {
      await runStructuralModeSetup(project.activeGraph, project, { ctx: null });
      // 実測値（本番順・fake IndexedDB実peek経由。QA第2巡Major-1でフィクスチャを
      // project.structGraph方式に是正した後の値=97。旧フィクスチャは壁・CLがsave→peek往復で
      // 消えており、柱・梁が空のまま「収束」していたため回数が少なく出ていた＝40は誤った実測値）。
      // 外側ループを1回でbreakする変異ではこれより少なくなる（2パス目のreflectStructuralToOtherFloors・
      // recomputeStructuralCompositionが呼ばれないため）。
      assert.equal(peekCount, 97, `初回突入（アクティブ=3階・ctx:null）のpeek回数（実測値。2パス分）。実際:${peekCount}`);
    } finally {
      floorSwapManager.peek = originalPeek;
      await figureBindingManager.deactivate();
    }
  });
});

test('【統合・B-1】runStructuralModeSetup: 非在来（S造）は外側ループが1回で収束する（アクティブ階再計算のchangedが2回目には残らないため）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-b1-nonwood', 'test');
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
    g1.structureOverride = 'S造';
    g2.structureOverride = 'S造';
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
    await saveFloor('p1', serializeGraph(g1));
    project.activePlaneId = 'p2';

    let peekCount = 0;
    const originalPeek = floorSwapManager.peek.bind(floorSwapManager);
    floorSwapManager.peek = async (...args) => { peekCount++; return originalPeek(...args); };
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      await runStructuralModeSetup(g2, project, {});
      assert.equal(warnings.length, 0, '非在来はMAX_REFLECT_PASSESまで回らない（1回で収束しwarnは出ない）');
      const firstPeekCount = peekCount;
      // 2回目の突入呼び出しでもpeek回数が変わらない＝外側ループは初回呼び出し内で既に1回しか
      // 回っていない（非在来のrecomputeStructuralCompositionはchangedが1回目で決着しfalseになるため）。
      peekCount = 0;
      await runStructuralModeSetup(g2, project, {});
      assert.equal(peekCount, firstPeekCount, '非在来は2回目の突入でもpeek回数が変わらない（毎回1パスで収束）');
    } finally {
      floorSwapManager.peek = originalPeek;
      console.warn = originalWarn;
      await figureBindingManager.deactivate();
    }
  });
});

// ---- Major-2（QA第2巡）: runStructuralModeSetupのundoが1エントリで機能することを直接検証する ----
// 突入全体で1エントリだけpushされ、undoでアクティブ階が突入前の状態に戻り、canRedoが立つことを
// 確認する（anyChangedのpushをif自体ごと消す変異／パス毎にpushする変異のいずれでも赤化する）。
test('【Major-2】runStructuralModeSetup: 突入全体でundoが1件だけ積まれ、undoでアクティブ階が突入前に戻りcanRedoが立つ', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activePlane = project.planes.find(p => p.name === '3階');
    project.activePlaneId = activePlane.id;
    const entryBefore = serializeGraph(project.activeGraph);
    const undoCountBefore = undoManager._undoStack.length;
    try {
      await runStructuralModeSetup(project.activeGraph, project, {});
      assert.equal(undoManager._undoStack.length, undoCountBefore + 1,
        '突入全体でundoエントリはちょうど1件だけ積まれる（外側ループのパス毎にではなく）');
      assert.equal(undoManager.canRedo, false, '突入直後はredoスタックが空（pushがredoスタックをクリアするため）');
      undoManager.undo();
      assert.deepEqual(serializeGraph(project.activeGraph), entryBefore,
        'undoでアクティブ階が突入前のスナップショットに戻る');
      assert.equal(undoManager.canRedo, true, 'undo後はredoできる');
    } finally {
      await figureBindingManager.deactivate();
    }
  });
});

// ---- R-6(2)（2026-09-19）: reflectRoofPlaneの挙動を本番peek＋fake IDBで対比する ----
// 在来は反映1回で屋根の梁が生成・保存される／非在来は屋根が保存されない（収集だけ）ことを、
// floorSwapManager.peekをスタブせず（本番同型）、実際にsaveFloorされたか否かで確認する。
test('【R-6(2)】reflectStructuralToOtherFloors: 在来木造は反映1回で屋根の梁が生成・保存される（本番peekで再読込して確認）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-r6-2-wood', 'test');
    // 建物全体既定値（project.structuralInfo.mainStructure）で在来木造にする——階別override
    // （graph.structureOverride）は屋根がまだ一度もsaveFloorされていない間はfloorSwapManager.peekが
    // 返す一時graphに引き継がれない（peekは「保存済みバイト列があれば復元、無ければ空のPlanGraph」
    // なので、まだ保存の無い屋根はoverride未設定のまま——建物全体既定値でeffectiveStructureを
    // 解決させるのが正しい配線。実機でも「未設定の階は建物既定値」という同じ規約）。
    project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    // 通り芯はproject.structGraph（全階共通）へ置く——階固有のgraph.addCenterLineでSTRUCT種別を
    // 作ると、壁のCL参照（axisCLId等）がsaveFloor→本番peek（floorSwapManager.peek）の
    // restoreGraphで解決できず、壁が復元後に消える落とし穴がある（本番は通り芯を必ず
    // project.structGraphへ置くため踏まない。ここで再発見・回避）。
    const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
    const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
    const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
    generateRoomWallsFromOutline(g1, room);
    await saveFloor('p1', serializeGraph(g1)); // 本番peek（peekRoofBelowGraph等）が読む「保存済みの1階」
    const roofPlane = syncRoofPlane(project);
    project.activePlaneId = null; // 誰もアクティブでない＝屋根もreflectRoofPlaneの対象になる
    // floorSwapManager.peekはスタブしない（本番同型。fake IndexedDBの上で本番実装を通す）。
    await reflectStructuralToOtherFloors(project);
    const rePeeked = await floorSwapManager.peek(roofPlane, project.structGraph);
    const roofBeams = rePeeked.beams.filter(b => b.role === 'primary');
    assert.ok(roofBeams.length > 0,
      `在来木造は反映1回で屋根の梁が生成・保存される（本番peekで再読込した屋根の梁本数=${rePeeked.beams.length}）`);
    assert.ok(roofBeams.every(b => b.beamType === '軒桁'));
  });
});

test('【失敗系・R-6(2)】reflectStructuralToOtherFloors: 非在来（S造）の屋根は反映しても保存されない（収集だけ。本番peekで再読込して確認）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-r6-2-nonwood', 'test');
    project.structuralInfo.mainStructure = 'S造'; // 建物全体既定値（屋根はまだ未保存のためoverrideに頼れない。上記コメント参照）
    project.addPlane(0, '1階', 'p1');
    const g1 = project.graphMap.get('p1');
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
    await saveFloor('p1', serializeGraph(g1));
    const roofPlane = syncRoofPlane(project);
    project.activePlaneId = null;
    // floorSwapManager.peekはスタブしない（本番同型）。
    await reflectStructuralToOtherFloors(project);
    const rePeeked = await floorSwapManager.peek(roofPlane, project.structGraph);
    assert.equal(rePeeked.beams.length, 0,
      `非在来は反映しても屋根へ保存されない（収集だけ。本番peekで再読込した屋根の梁本数=${rePeeked.beams.length}のはず）`);
  });
});

test('【不変条件・ステップ7】structuralOrchestration.js: reflectStructuralAfterFinishExit は昇順ループの直後にreflectRoofPlaneを呼ぶ（自階より上の末尾に屋根）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const src = stripComments(fs.readFileSync(path.join(here, 'structuralOrchestration.js'), 'utf8'));
  const fnMatch = /export async function reflectStructuralAfterFinishExit\([^)]*\) \{([\s\S]*?)\r?\n\}/.exec(src);
  assert.ok(fnMatch, 'reflectStructuralAfterFinishExit関数本体が見つからない');
  const body = fnMatch[1];
  // ステップB-3でctx（解決コンテキスト。省略可・既定undefined）が2番目の引数として加わった。
  assert.ok(/for \(let i = idx \+ 1; i < planes\.length; i\+\+\) \{[\s\S]*?\}[\s\S]*?await reflectRoofPlane\(project, ctx\);/.test(body),
    'reflectRoofPlane(project, ctx) の呼び出しが昇順ループ（自階より上）の後に無い');
  // 昇順ループと同じ if (idx !== -1) ガードの内側にあること（idx===-1では屋根にも触れない）——
  // 単純な正順序チェックだけでは「ガード外へ出す」変異を検出できない（実測・再発防止）。
  assert.ok(/if \(idx !== -1\) \{[\s\S]*?await reflectRoofPlane\(project, ctx\);[\s\S]*?\n {2}\}/.test(body),
    'reflectRoofPlane(project, ctx) が if (idx !== -1) ガードの内側に無い');
});

test('【失敗系・ステップ7】reflectStructuralAfterFinishExit: 存在しないplaneId（idx===-1）は屋根専用平面があってもreflectRoofPlaneを呼ばない（floorSwapManager.peekに到達しない）', async () => {
  const project = new Project('proj-step7-idx-neg1', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const roofPlane = syncRoofPlane(project);
  assert.ok(roofPlane?.isRoofPlane, '前提: 屋根専用平面が生成されている');

  // floorSwapManager.peekを未モックのまま（呼ばれれば実IndexedDBに到達してReferenceErrorになる）
  // ——doesNotRejectが通ればreflectRoofPlaneが呼ばれていない証拠になる。
  await assert.doesNotReject(
    reflectStructuralAfterFinishExit('does-not-exist', true, project),
    'idx===-1は屋根専用平面があってもfloorSwapManager.peekへ到達しない（reflectRoofPlaneを呼ばない）');
});

// ---- R-3（2026-09-19是正・reflectStructuralToOtherFloorsと同じ理由の機械的な横展開）----
// reflectStructuralAfterFinishExitの採番の適用ループ（goingToStructure=falseのときだけ確定）も
// project.planesのみを対象にしていたため、同じ理由で屋根の梁がmemberNo=nullのまま保存される
// 不整合があった。withFakeIndexedDBで実際にsaveFloorまで通して確認する。
// 【QA第2巡Major-3是正】以前はfloorSwapManager.peekをgraphMapへの素通しにスタブしており、
// roofGraph（graphMap登録の生グラフ。recomputeは本番同型peekの一時graphに対して行われ保存される
// ため実際は更新されない）を直接参照していた——saveFloor削除の変異で赤化しない。real peekに
// 置き換え、確認は再peekしたインスタンスに対して行う。CLもproject.structGraphへ移す。
test('【R-3】reflectStructuralAfterFinishExit: goingToStructure=falseのとき、屋根の梁（role:primary）にも採番が適用されmemberNoが保存される（本番peekで再読込して確認）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-r3-finishexit-roof', 'test');
    project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE; // 屋根は未保存のまま最初にpeekされるため
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
    const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
    const room = g1.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
    generateRoomWallsFromOutline(g1, room);

    const roofPlane = syncRoofPlane(project);
    const roofGraph = project.graphMap.get(roofPlane.id);
    roofGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
    project.activePlaneId = 'p1'; // g1（唯一の実体階＝自階より上は屋根だけ）から退出する想定

    // 実IDB往復のfloorSwapManager.peekが空の一時graphを返さないよう、g1は事前に保存する
    // （屋根の反映がpeekRoofBelowGraph経由で最上階=g1を無条件にpeekするため。本番では仕上げ
    // モード退出フローが本関数を呼ぶ前にg1を保存済みという前提を模す）。
    await saveFloor('p1', serializeGraph(g1));

    await reflectStructuralAfterFinishExit('p1', false, project);
    const rePeeked = await floorSwapManager.peek(roofPlane, project.structGraph);
    const roofBeams = rePeeked.beams.filter(b => b.role === 'primary');
    assert.ok(roofBeams.length > 0, '前提: 屋根に大梁(role:primary、壁線方式の軒桁)が生成されている');
    assert.ok(roofBeams.every(b => b.memberNo != null),
      '屋根の梁にもmemberNoが書き戻される（再peekでも非null＝saveFloor済み）');
  });
});

// reflectStructuralToOtherFloors を直接呼ぶ挙動テスト（アクティブ階以外を実際に peek+recompute する）は
// 本ファイル冒頭のコメント・reflectStructuralAfterFinishExit節のコメントと同じ理由（fake-indexeddb等の
// IDBモックが本リポジトリのdevDependenciesに無く、非アクティブ階でchanged=trueになると
// saveFloor→実indexedDBに到達しReferenceErrorになる）で断念し、上のソース走査（順序の固定）に留める。
// 実データでの挙動確認は golden probe（moku1.stq。既存floorsを事前収束させてchanged=falseにしてから
// reflectStructuralToOtherFloorsを呼び、saveFloorに到達しない状態で検証する）で行う——報告参照。

// ---- 実機再々QA指摘2: resyncTouchedMemberGroups（undo/redo時の派生値再導出。:172,175付近）を
// 梁でも固定する——柱だけでは派生値の書き込みが自明（本ステップ既存テスト参照）に埋もれて検出できない
// ため、105×120の標準材グループがundo後もmemberNumberIndexで1グループのままであることを直接見る。----
test('recomputeStructuralComposition【実機再々QA指摘2】: 1階=105（既存状態）で柱寸を変更→undoすると、memberNumberIndexで105×120の梁が再び1グループに戻る（resyncTouchedMemberGroupsの派生値再導出）', async () => {
  const project = new Project('proj-c2-qa5-undo-beam', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（各階柱寸法の編集対象。既に105＝ドキュメント読込み直後を模す）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g1.setWoodColumnWidthMm(105);
  project.activePlaneId = 'p2';

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: true, discipline: Discipline.STRUCT });

  const beamStdA = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y0, false, x0, x1, { role: 'primary' });
  const beamStdB = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y1, false, x0, x1, { role: 'primary' });
  const beamNonStd = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x330', y2, false, x0, x1, { role: 'primary' });
  for (const b of [beamStdA, beamStdB, beamNonStd]) b.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    // 反映パス相当（1階=105が既に効いた状態を収集で確立する。既存QA3テストと同じ手法）。
    runInAction(() => {
      collectFloorGroups(g1, project);
      g2.setBeamColumnWidthMm(105);
      collectFloorGroups(g2, project);
    });
    const groupKeyStd = memberGroupKey(beamStdA, 'beamMap', rulesFor(TRADITIONAL_WOOD_STRUCTURE), 'WOOD-105x120');
    const groupBefore = project.memberNumberIndex.get(groupKeyStd);
    assert.ok(groupBefore, '前提: 1階=105の時点で105×120グループが索引に存在する');
    assert.equal(totalCountOf(groupBefore), 2, '前提: 105×120グループは2本（標準材として1グループ）');
    const floorRanksBefore = [...groupBefore.floorRanks].sort();

    const composition = { graphForCategory: () => g1 };
    // 柱寸法変更（105→120。標準材が変わり105×120は非標準＝個別採番へ移る）。
    await recomputeStructuralComposition(composition, g2, project, {
      mutate: () => { g1.setWoodColumnWidthMm(120); },
    });
    const groupDuring = project.memberNumberIndex.get(groupKeyStd);
    assert.ok(!groupDuring || totalCountOf(groupDuring) < 2, '前提: 変更直後は標準材が120基準になり105×120グループが縮小/消滅する');

    undoManager.undo();

    const groupAfterUndo = project.memberNumberIndex.get(groupKeyStd);
    assert.ok(groupAfterUndo, 'undo後に105×120グループの索引エントリが存在しない（resyncTouchedMemberGroupsが派生値を再導出できていない可能性）');
    assert.equal(totalCountOf(groupAfterUndo), 2, 'undo後は105×120グループが2本へ戻る（分裂したまま復元されない不具合の回帰防止）');
    assert.deepEqual([...groupAfterUndo.floorRanks].sort(), floorRanksBefore, 'undo後にfloorRanksも変更前と一致する（floorRanks自体の復元の回帰防止。totalCountOfだけでなくfloorRanksも見る）');
    assert.equal(beamStdA.memberNo, beamStdB.memberNo, 'undo後も105×120の2本は実体レベルでも同一タグ');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 実機再々QA指摘3: 下階編集経路（belowGraph自身のbeamColumnWidthMm書き込み。:107付近）を
// 3階建てで固定する——2階建てのテストではbelowGraph=1階（最下階）でbelowBelowGraph=nullのため
// この書き込みが自明値（自階フォールバック）にしかならず、消しても検出できない。3階建てで
// subject=3階・below=2階・belowBelow=1階にし、1階=105のとき2階自身の梁（105×120）が
// 1グループのままであることを見る。----
test('recomputeStructuralComposition【実機再々QA指摘3】: 3階建て（below=2階自身の梁がbelowBelow=1階の柱寸を参照）で105×120が1グループのまま', async () => {
  const project = new Project('proj-c2-qa5-3f', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // belowGraph（この階自身の梁が対象）
  const { graph: g3 } = project.addPlane(6000, '3階', 'p3'); // subjectGraph
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g3.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g1.setWoodColumnWidthMm(105); // 1階＝belowBelowGraph（既に105。ドキュメント読込み直後を模す）
  project.activePlaneId = 'p3';

  const x0 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const y1 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: true, discipline: Discipline.STRUCT });
  const y2 = project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 6000, { labeled: true, discipline: Discipline.STRUCT });

  // 2階自身の梁（belowGraphの梁。1階＝belowBelowGraphの柱寸105を参照して初めて「標準材」になる）。
  const beamStdA = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y0, false, x0, x1, { role: 'primary' });
  const beamStdB = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x120', y1, false, x0, x1, { role: 'primary' });
  const beamNonStd = g2.addBeam(StructuralMaterialType.WOOD, 'WOOD-105x330', y2, false, x0, x1, { role: 'primary' });
  for (const b of [beamStdA, beamStdB, beamNonStd]) b.setDimensionStatus('locked');

  const peekMap = { p1: g1, p2: g2, p3: g3 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    // composition対象＝subject=3階、below=2階（各階柱寸法欄が編集する対象は3階の「1つ下」＝2階だが、
    // ここでは2階の柱寸自体は変更しない——2階「自身の梁」が1階の柱寸を参照する経路だけを見る）。
    const composition = { graphForCategory: () => g2 };
    await recomputeStructuralComposition(composition, g3, project, {});

    assert.equal(g2.beamColumnWidthMm, 105, '前提: 2階自身の派生値（belowBelow=1階の柱寸）が105になっている');
    assert.equal(beamStdA.memberNo, beamStdB.memberNo,
      '2階自身の105×120梁2本が同一タグのまま（下階編集経路のbelowGraph自身への書き込みが効いている）');
    assert.notEqual(beamStdA.memberNo, beamNonStd.memberNo, '105×330（個別採番対象）は引き続き別タグ');
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- columnSetSignature（下階柱集合の変更検知。ユーザー裁定2026-09-16「分割後に正しい距離を
// 持つことが最適解」の実装で使う純関数）----
// AXIS（axisX/axisY。偏心を含まない）を読む（B-1・個別柱の偏心。.claude/structural-model.md参照）。

test('columnSetSignature: 順序・浮動小数の丸め誤差(0.1mm未満)に依存せず同一シグネチャになる', () => {
  const a = [{ axisX: 0, axisY: 0, role: 'standard' }, { axisX: 1820.02, axisY: 0, role: 'standard' }];
  const b = [{ axisX: 1820.04, axisY: 0, role: 'standard' }, { axisX: 0, axisY: 0, role: 'standard' }]; // 順序違い・0.1mm未満の誤差
  assert.equal(columnSetSignature(a), columnSetSignature(b));
});

test('columnSetSignature【失敗系】: 柱の位置・役割・本数のいずれかが変わると別シグネチャになる', () => {
  const base = [{ axisX: 0, axisY: 0, role: 'standard' }];
  assert.notEqual(columnSetSignature(base), columnSetSignature([{ axisX: 100, axisY: 0, role: 'standard' }]), '位置が変わると別シグネチャ');
  assert.notEqual(columnSetSignature(base), columnSetSignature([{ axisX: 0, axisY: 0, role: 'foundation' }]), '役割が変わると別シグネチャ');
  assert.notEqual(columnSetSignature(base), columnSetSignature([]), '柱が増減すると別シグネチャ');
  assert.equal(columnSetSignature([]), columnSetSignature([]), '空集合同士は同一シグネチャ');
});

test('columnSetSignature【B-1】: ACTUAL（x/y。偏心を含む）が異なっても AXIS（axisX/axisY）が同じなら同一シグネチャ（個別柱の偏心だけの変化は再計算トリガーにしない）', () => {
  const a = [{ axisX: 0, axisY: 0, x: 0, y: 0, role: 'standard' }];
  const b = [{ axisX: 0, axisY: 0, x: 7.5, y: -7.5, role: 'standard' }]; // 偏心が付いてもAXISは不変
  assert.equal(columnSetSignature(a), columnSetSignature(b));
});

test('columnSetSignature（Minor-7）: 建具の袖柱が増えるとシグネチャが変わる（AXISが開口位置から導出されるため署名は衝突しない）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, 0, false, x1, 0, x2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  const project = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  autoFillWallBeamAxes(graph, selfWallSegments(graph));
  autoFillWoodColumns(graph, project, null); // 開口なし＝袖柱0本
  const before = columnSetSignature(graph.columns);

  graph.addOpening(wall.axisCL, 1, false, x1, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  autoFillWoodColumns(graph, project, null); // 開口追加＝袖柱2本
  const after = columnSetSignature(graph.columns);

  assert.notEqual(before, after, '袖柱の増加でAXIS座標の集合が変わるためシグネチャも変わる（既存柱と重なる位置には生成されないため衝突しない）');
});

// ---- ユーザー裁定2026-09-16「分割後に正しい距離を持つことが最適解」: 突入時に下階へ3b柱が
// 新規に立つと、自階の壁線上の通し梁（3c）がその位置で分割され直し、各区間が単一スパンの表引き成に
// なる（分割前＝関数先頭の自階再計算はまだ3b柱の無い下階を見ており、古い1本のまま確定してしまう
// 実機不具合の再現。QA F4テストと同じ壁・アンカー配置だが、col3bをあらかじめ置かない点が異なる）----
test('recomputeStructuralComposition【ユーザー裁定2026-09-16】: 突入時に新規追加された下階の3b柱の位置で、自階の壁線上の通し梁が分割され直る', async () => {
  const project = new Project('proj-3b-resplit', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');    // 下階（3b柱が新規に立つ対象階）
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 主題階（壁線上の通し梁が下階柱で分割される）
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  // 1階: 3640×1820の実壁の部屋（4隅が3a交点）＋走行方向アンカー用の通り芯 x=1820（壁は無い）。
  // wallRunSegments は自階(2階)＋下階(1階)の壁区間を合成するため、2階自身に壁が無くても
  // 1階の y=0, x:[0,3640] の壁が「壁線」として拾われる（QA F4テストと同じ配置）。
  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  // （QA F4と異なり）1階に3b柱をあらかじめ置かない——この呼び出しの中で新規に立つケースを見る。

  // 2階: 自階柱(1820,0)——1階の3b柱にとっての「1つ上の実体階の柱」役（aboveColumnsForBelow）。
  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, y0, {});

  const peekMap = { p1: g1, p2: g2 };
  const originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 };
    await recomputeStructuralComposition(composition, g2, project, {});

    const col3b = g1.columns.find(c => Math.abs(c.x - 1820) < 1 && Math.abs(c.y - 0) < 1);
    assert.ok(col3b, '前提: 1階に3b柱が新規に立った');
    assert.ok(composition.graphForCategory('columnMap').columnMap.has(col3b.id), '新規3b柱がcomposition経由でも見える');

    const splitBeams = g2.beams.filter(b => b.role === 'primary' && !b.isVertical && Math.abs(b.axisValue - 0) < 1);
    assert.equal(splitBeams.length, 2, '3b柱の位置で2本に分割される（古い下階柱のまま1本の3640スパンで確定しない）');
    // run端は壁の取り合い控え（WALL_JUNCTION_TOL_MM。実機コメント「x=0の縦壁に突き当たる横壁は
    // x=57.5から始まる」）ぶん内側へ寄るため、各区間はちょうど1820mmにはならない（実測1760mm）——
    // ここでは「3640一体の1本のまま（旧不具合）ではなく、下階柱で単一スパンの短い2本に割れている」
    // ことと、そのスパンが表の最小区分（1820以下・中間荷重なし=120）に収まることだけを見る。
    for (const b of splitBeams) {
      const span = Math.abs(b.coord2 - b.coord1);
      assert.ok(span > 0 && span < 1820, `分割後の各区間は表の最小区分（1820以下）に収まる短いスパンになる（実測${span}）`);
      assert.equal(b.sectionDefId, 'WOOD-120x120', '単一スパン(1820以下)・中間荷重なしの表引き成（120）になる');
    }
  } finally {
    floorSwapManager.peek = originalPeek;
  }
});

// ---- 上のテストと対をなす不変条件: 下階の柱集合が変わらない（1回目の突入で3a・3b柱とも
// 出そろい、2回目は冪等）ケースでは、自階の再計算をもう一度やり直さない（flushEditablePeekが
// 余分に呼ばれない）。「同一入力2回目ならundoを積まない」テストと同じ「1回目で収束・2回目は
// 冪等」の手法——3a（壁交点）の柱本数を事前に手計算で言い当てる必要がなく、実装の内部詳細に
// 依存しない。----
test('recomputeStructuralComposition: 下階の柱集合が変わらない（2回目・冪等）場合は自階を再計算し直さない（flushEditablePeekが呼ばれない）', async () => {
  const project = new Project('proj-3b-nochange', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
  g1.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  g2.structureOverride = TRADITIONAL_WOOD_STRUCTURE;

  const gx0 = g1.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gx1 = g1.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const gy0 = g1.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const gy1 = g1.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const room = g1.addRoom(new Set([`${gx0.id}:${gy0.id}:${gx1.id}:${gy1.id}`]), 'A');
  generateRoomWallsFromOutline(g1, room);
  g1.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });

  const xm = g2.addCenterLine(CenterLineType.VERTICAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = g2.addCenterLine(CenterLineType.HORIZONTAL, 0,  { labeled: true, discipline: Discipline.STRUCT });
  g2.addColumn(StructuralMaterialType.WOOD, 'WOOD-120x120', xm, y0, {});

  const originalFlush = floorSwapManager.flushEditablePeek;
  const originalPeek = floorSwapManager.peek;
  const peekMap = { p1: g1, p2: g2 };
  floorSwapManager.peek = async (plane) => peekMap[plane.id] ?? null;
  try {
    const composition = { graphForCategory: () => g1 };
    // 1回目: 3a（壁交点）・3b（上階柱直下）の柱が新規に立つ（このテストの対象外。上のテストが担当）。
    await recomputeStructuralComposition(composition, g2, project, {});
    const columnsAfterFirst = g1.columns.length;
    assert.ok(columnsAfterFirst > 0, '前提: 1回目で下階に柱が生成されている');

    const calls = [];
    floorSwapManager.flushEditablePeek = () => { calls.push('flush'); return Promise.resolve(); };
    // 2回目: 下階柱集合は変わらない（冪等）はず。
    await recomputeStructuralComposition(composition, g2, project, {});

    assert.equal(g1.columns.length, columnsAfterFirst, '前提: 2回目は下階の柱本数が変わらない（冪等）');
    assert.equal(calls.length, 0, '下階柱集合が変化していないため、自階の再計算をやり直すflushEditablePeekは呼ばれない');
  } finally {
    floorSwapManager.flushEditablePeek = originalFlush;
    floorSwapManager.peek = originalPeek;
  }
});

// ==== B-4（構造再計算の高速化・2026-09-21）: runStructuralModeSetupがコンテキストを生成して使う ====
// buildB1Fixture/saveB1InitialFloors/dumpB1AllFloors（【統合・B-1】節）を再利用する——在来木造・
// 複数階＋屋根専用平面のフィクスチャで、B-4が対象にする全経路（reflectRoofPlane・
// recomputeInactiveStructural・applyMemberNumbersToFloor・applyMemberNumbersToRoof・
// recomputeStructuralComposition内のbelow/lowest peek）を1回の突入で踏む。

// dumpB1AllFloorsは柱・梁の位置のみ（【統合・B-1】の収束確認用）。

// ==== 全フィールド意味ダンプ（コーディネーター差し戻し・2026-09-21。Minor 1是正で追記）====
// buildCLResolver・normalizeStructEntity・allFieldsDumpForGraph・dumpB1AllFloorsAllFields は
// structuralOrchestrationFixtures.js（両テストファイルの共有モジュール）から import する
// （旧dumpB1AllFloorsFull＝柱・梁の位置/sectionDefId/memberNoのみ、では検出力が不足するため
// decode(serializeGraph(g))の全フィールド比較版へ差し替えた経緯・フィールド選定理由は同ファイルの
// コメント参照）。

// ---- 検出力の確認（コーディネーター差し戻し 1）: dumpB1AllFloorsAllFields が
//      柱・梁のnumberGroupId・除外集合の差を実際に拾うことを直接確かめる（1回きり）。
//      保存済みグラフの柱1本を直接書き換えてから再保存・再ダンプし、変更前後で不一致になることを
//      確認する——旧dumpB1AllFloorsFull（位置/sectionDefId/memberNoのみ）ならこの種の差は拾えない。
test('【全フィールド化・検出力確認】dumpB1AllFloorsAllFields: 柱のnumberGroupIdの変更・除外集合への追加を不一致として検出する', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    // アクティブ=1階にする（対象は非アクティブ階の2階）——dumpB1AllFloorsAllFieldsはアクティブ階だけ
    // project.activeGraph（生きたメモリ上のインスタンス）を直接読むため、対象をアクティブ階にすると
    // floorSwapManager.peek経由で保存した変更が反映されない（活アクティブ階以外＝常にpeekで読む階を
    // 対象にする）。
    project.activePlaneId = project.planes.find(p => p.name === '1階').id;
    try {
      await runStructuralModeSetup(project.activeGraph, project, { ctx: null });
      const before = await dumpB1AllFloorsAllFields(project);

      // (a) 2階の柱1本のnumberGroupIdを書き換えてから再ダンプ→不一致になることを確認する。
      const plane2 = project.planes.find(p => p.name === '2階');
      const g2 = await floorSwapManager.peek(plane2, project.structGraph);
      const victim = g2.columns[0];
      assert.ok(victim, '前提: 2階に柱が1本以上ある');
      runInAction(() => victim.setNumberGroupId('DETECT-TEST-GROUP'));
      await saveFloor(plane2.id, serializeGraph(g2));
      const afterNumberGroupChange = await dumpB1AllFloorsAllFields(project);
      assert.notDeepEqual(afterNumberGroupChange, before,
        'numberGroupIdの変更が全フィールドダンプの不一致として検出される');

      // (b) (a)を元に戻し、代わりに除外集合へ1件追加してから再ダンプ→不一致になることを確認する。
      runInAction(() => victim.setNumberGroupId(null));
      runInAction(() => g2.excludedColumnSlots.add('DETECT-TEST-KEY'));
      await saveFloor(plane2.id, serializeGraph(g2));
      const afterExclusionAdd = await dumpB1AllFloorsAllFields(project);
      assert.notDeepEqual(afterExclusionAdd, before,
        '除外集合（excludedColumnSlots）への追加が全フィールドダンプの不一致として検出される');
      assert.notDeepEqual(afterExclusionAdd, afterNumberGroupChange,
        '前提: (a)と(b)は別の差分である（(a)を元に戻し(b)だけを入れたダンプが(a)のダンプと一致しない）');
    } finally {
      await figureBindingManager.deactivate();
    }
  });
});

// StructuralResolveContext.prototype.dispose をスパイする。createStructuralResolveContextは
// 関数エクスポート（ESMのimportバインディングは書換不可）のため差し替えられないが、全インスタンスが
// 共有する prototype は通常のオブジェクトなので書換えられる——runStructuralModeSetupが内部で生成する
// owned なインスタンス（テストからは参照を持てない）についても dispose 呼び出しをここで観測できる
// （「最も素直な観測手段」として本ファイルで採用。プロダクトコードは一切変更しない）。
function spyOnContextDispose() {
  const probe = createStructuralResolveContext();
  const proto = Object.getPrototypeOf(probe);
  const original = proto.dispose;
  // probe自身を破棄する——スパイ（proto.dispose差し替え）を設置する前に呼ぶことで、この呼び出しは
  // callsに数えられない（前回QA指摘Nit4: probeが未破棄のまま残っていた）。
  probe.dispose();
  const calls = [];
  proto.dispose = function (...args) {
    calls.push(this);
    return original.apply(this, args);
  };
  return { calls, restore: () => { proto.dispose = original; } };
}

// 【全フィールド化・2026-09-21】A/B等価の検出力を上げるため、柱・梁・memberNoのみのdumpB1AllFloorsFullから
// 全フィールド版（dumpB1AllFloorsAllFields）へ切り替える（コーディネーター差し戻し 1）。
async function runB1(label, ctxOption) {
  return withFakeIndexedDB(async () => {
    const { project, roofPlane } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activePlane = label === '屋根' ? roofPlane : project.planes.find(p => p.name === label);
    project.activePlaneId = activePlane.id;
    try {
      await runStructuralModeSetup(project.activeGraph, project, ctxOption === undefined ? {} : { ctx: ctxOption });
      return await dumpB1AllFloorsAllFields(project);
    } finally {
      await figureBindingManager.deactivate();
    }
  });
}

// ---- 1. A/B等価: ctx省略（生成）とctx:null（従来経路）で全階の全フィールドが完全一致する ----
for (const label of ['1階', '2階', '3階', '屋根']) {
  test(`【B-4・A/B等価】runStructuralModeSetup: アクティブ=${label}でctx省略とctx:nullが同じ結果になる（柱・梁・footings/slabs・除外集合・columnAxisOffsets・梁芯CLを含む全フィールド一致）`, async () => {
    const traditional = await runB1(label, null);
    const owned = await runB1(label, undefined);
    assert.deepEqual(owned, traditional,
      `アクティブ=${label}: ctx省略（コンテキスト生成）とctx:null（従来経路）で全フィールドのダンプが一致する`);
  });
}

// ---- 2. peek削減: ctx省略はctx:nullより実peek回数が少ない（同じ階を1回の突入で何度も復元しない） ----
// 屋根・上階方向のpeek（reflectRoofPlane内のpeekVia・applyMemberNumbersToRoof）もコンテキスト経由に
// なることを、buildB1Fixture（屋根あり）を使うことでpeek回数の実測値に反映させる。
test('【B-4・peek削減】runStructuralModeSetup: ctx省略（生成）はctx:null（従来経路）よりfloorSwapManager.peek実回数が少ない', async () => {
  async function countPeeks(ctxOption) {
    return withFakeIndexedDB(async () => {
      const { project } = buildB1Fixture();
      await saveB1InitialFloors(project);
      const activePlane = project.planes.find(p => p.name === '3階');
      project.activePlaneId = activePlane.id;
      let count = 0;
      const originalPeek = floorSwapManager.peek.bind(floorSwapManager);
      floorSwapManager.peek = async (...args) => { count++; return originalPeek(...args); };
      try {
        await runStructuralModeSetup(project.activeGraph, project, ctxOption === undefined ? {} : { ctx: ctxOption });
      } finally {
        floorSwapManager.peek = originalPeek;
        await figureBindingManager.deactivate();
      }
      return count;
    });
  }
  const traditionalCount = await countPeeks(null);
  const ownedCount = await countPeeks(undefined);
  // 実測値（本番順・fake IndexedDB実peek経由・アクティブ=3階。【R-4】と同じフィクスチャ・同じ
  // アクティブ階でctx:null固定にした実測値=97と同じ前提）。
  assert.equal(traditionalCount, 97, `ctx:null（従来経路）のpeek実回数（実測値）。実際:${traditionalCount}`);
  assert.equal(ownedCount, 7, `ctx省略（コンテキスト生成）のpeek実回数（実測値。屋根・上階方向のpeekも含め削減される）。実際:${ownedCount}`);
  assert.ok(ownedCount < traditionalCount, 'ctx省略の方が実peek回数が少ない（同じ階を1回の突入で何度も復元しない）');
});

// ---- 3. 失敗系・例外時も破棄: 例外が伝播し、ownedなコンテキストはdisposeされ、渡されたctxはdisposeされない ----
test('【B-4・失敗系】runStructuralModeSetup: 例外が呼び出し元へ伝播し、ownedなコンテキストはdisposeされ、渡されたctxはdisposeされない', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activePlane = project.planes.find(p => p.name === '3階');
    project.activePlaneId = activePlane.id;

    const spy = spyOnContextDispose();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async () => { throw new Error('注入した失敗（peek）'); };
    try {
      // (1) ctx省略（owned）: 例外が伝播し、finally経由でownedなコンテキストが1回だけdisposeされる。
      await assert.rejects(
        runStructuralModeSetup(project.activeGraph, project, {}),
        /注入した失敗/,
        '例外が呼び出し元へ伝播する',
      );
      assert.equal(spy.calls.length, 1, '例外時もownedなコンテキストがdisposeされる（finallyで1回）');

      // (2) 明示的にctxを渡した場合: 同じ失敗が起きても、渡したctxはdisposeされない（所有者は呼び出し側）。
      spy.calls.length = 0;
      const passedCtx = createStructuralResolveContext();
      await assert.rejects(
        runStructuralModeSetup(project.activeGraph, project, { ctx: passedCtx }),
        /注入した失敗/,
      );
      assert.equal(spy.calls.length, 0, '渡されたctxは例外時もdisposeされない（所有者は呼び出し側のまま）');
      passedCtx.dispose();
    } finally {
      floorSwapManager.peek = originalPeek;
      spy.restore();
      await figureBindingManager.deactivate();
    }
  });
});

// ---- 4. 失敗系・他者の書込み: 突入の最中に別経路のsaveFloorで保持済みの非アクティブ階が内容ごと
//         書き換わっても、古い保持を返さず読み直し、最終結果は「同じ干渉をctx:null（従来経路）で
//         入れた場合」と一致する ----
// 【コーディネーター差し戻し 2・2026-09-21】旧実装は干渉側が3階を「同一内容のまま」再保存していたため、
// 最終ダンプの一致では新旧（古い保持の内容 vs 読み直した後の内容）を判別できず、検出点が
// ctx.stats.invalidated のカウンタだけだった。干渉側で内容を変える（3階の柱を1本、excludedColumnSlots
// に記録される形で削除する——removeColumnは除外集合へ記録するため次回以降の自動補完で復活しない
// 「再計算で復活しない変更」）。ベースラインも「干渉なし」ではなく「同じ干渉をctx:null（従来経路）で
// 入れた場合」に変える——ctx:nullは保持を持たないため常に最新を読み、干渉のタイミング（reflectの
// どの時点で発生するか）に依存せず収束後の結果が一意に決まる、という前提のもとでの対照群にする。
function makeInterferingPeek(project, originalPeek) {
  const plane2 = project.planes.find(p => p.name === '2階');
  const plane3 = project.planes.find(p => p.name === '3階');
  let interfered = false;
  return async (plane, structGraph) => {
    if (plane.id === plane2.id && !interfered) {
      interfered = true;
      // 別経路（このctxを介さない）による3階の書換え——柱を1本削除する（同一内容の再保存ではなく
      // 内容そのものを変える。removeColumnがexcludedColumnSlotsへ記録するため、直後の自動補完で
      // 復活しない）。
      const other = await originalPeek(plane3, project.structGraph);
      const victim = other.columns[0];
      if (victim) runInAction(() => other.removeColumn(victim.id));
      await saveFloor(plane3.id, serializeGraph(other));
    }
    return originalPeek(plane, structGraph);
  };
}

async function runB1WithInterference(ctxOption) {
  return withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activePlane = project.planes.find(p => p.name === '1階');
    project.activePlaneId = activePlane.id;
    const originalPeek = floorSwapManager.peek.bind(floorSwapManager);
    floorSwapManager.peek = makeInterferingPeek(project, originalPeek);
    const ctx = ctxOption === null ? null : createStructuralResolveContext();
    try {
      await runStructuralModeSetup(project.activeGraph, project, { ctx });
      const dump = await dumpB1AllFloorsAllFields(project);
      return { dump, invalidated: ctx ? ctx.stats.invalidated : null };
    } finally {
      floorSwapManager.peek = originalPeek;
      if (ctx) ctx.dispose();
      await figureBindingManager.deactivate();
    }
  });
}

test('【B-4・失敗系】runStructuralModeSetup: 突入の最中に他経路のsaveFloorで保持済みの非アクティブ階が内容ごと書き換わっても、古い保持を返さず読み直し、最終結果は同じ干渉をctx:null（従来経路）で入れた場合と一致する', async () => {
  const traditional = await runB1WithInterference(null);
  const owned = await runB1WithInterference(undefined);
  // 実測値（本フィクスチャ・この干渉手順での固定値）。世代比較を外す変異（graphForが常にヒット
  // する）だとinvalidatedが2→1に減る——>=1のような緩い下限だと「1」も通ってしまい変異を
  // 検出できないため、厳密に一致させる。
  assert.equal(owned.invalidated, 2,
    `2階のpeek中に3階が外部で書き換えられ、3階の保持が無効化される（invalidated実測値。実際:${owned.invalidated}）`);
  assert.deepEqual(owned.dump, traditional.dump,
    '内容を変える干渉があっても、最終結果は同じ干渉をctx:null（従来経路）で入れた場合と一致する（全フィールド）');
});

// ---- 4b. アクティブ階の保持が破棄されることを守る（コーディネーター差し戻し 3・2026-09-21）----
// アクティブ=2階で突入すると、3階の再計算（recomputeInactiveStructural→recomputeStructuralForGraph→
// peekBelowGraph等）が「1つ下の実体階」として2階をctx.graphFor経由でpeekする——peekBelowGraph/
// buildStructuralWallGateはplaneが「たまたまアクティブかどうか」を見ずにpeekVia(ctx,...)を呼ぶため、
// ctxはアクティブ階（2階）の「別インスタンス（IDBからのコピー）」も保持しうる。runStructuralModeSetupの
// 外側ループが2パス目へ進む前に自階（targetGraph＝生きたactiveGraph）を`saveVia(ctx, ...)`で保存する
// ——このsaveAndNoteは「保持インスタンス（3階処理が保持した2階の古いコピー）」と「bytesの元になった
// graph（targetGraph）」が別インスタンスであることを検知し、保持を破棄する（invalidatedが増える）。
// 破棄されないと、次パス（2パス目）で3階側が読む2階の内容が「保存前の古い（3b柱がまだ無い）コピー」の
// ままになり、収束後の最終結果がctx:null（従来経路）とずれる可能性がある——本テストは(1)invalidatedが
// 増えること、(2)それでも最終結果はctx:nullと全フィールド一致することの両方を守る。
test('【B-5・アクティブ保持破棄】runStructuralModeSetup: アクティブ=2階への突入中に3階の下階参照が2階のIDBコピーを保持しても、自階保存後に保持が破棄され、最終結果はctx:null（従来経路）と全フィールド一致する', async () => {
  const baselineDump = await runB1('2階', null);

  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activePlane = project.planes.find(p => p.name === '2階');
    project.activePlaneId = activePlane.id;
    const ctx = createStructuralResolveContext();
    try {
      await runStructuralModeSetup(project.activeGraph, project, { ctx });
      // 実測値（本フィクスチャ・アクティブ=2階での固定値。3階の下階参照が2階を保持したのち、
      // 自階保存で別インスタンス保存として無効化される）。
      assert.equal(ctx.stats.invalidated, 1,
        `3階の下階参照が2階のIDBコピーを保持したのち、自階（2階）保存で無効化される（invalidated実測値。実際:${ctx.stats.invalidated}）`);
      const finalDump = await dumpB1AllFloorsAllFields(project);
      assert.deepEqual(finalDump, baselineDump,
        'アクティブ階の保持が破棄されても、最終結果はctx:null（従来経路）と全フィールド一致する');
    } finally {
      ctx.dispose();
      await figureBindingManager.deactivate();
    }
  });
});

// ---- 4c. 失敗系（柱1本の削除で干渉）: structuralOrchestration.interference.test.js へ移設
// （差し戻し対応・2026-09-21）。onFloorsPutフックに依存する干渉系テストは、本ファイル内の他の
// 多数のtest()が先にopenDB()を成功させると_dbPromiseキャッシュ越しに干渉が一度も発火しない
// 空振りになる（storage/db.js openDB()参照。node --testはファイル単位でプロセスが分離されるため、
// 専用ファイルへ切り出すことで確実に発火する新品のfakeDbを使える）。移設先を参照。

// ---- 4d. 収束・ctx省略（既定経路）（コーディネーター差し戻し・Minor 3・2026-09-21）----
// 上の【統合・収束】は【B-5是正】でctx:null固定にしたため（peek回数の参考値を保つため。上記
// コメント参照）、本番の既定経路（ctx省略＝自前生成）での収束は未検証のまま残っていた。
// buildB1Fixture・saveB1InitialFloors（【統合・B-1】節）を使い、アクティブ=1階でctxを省略して
// 外部から1回だけ呼び、続けてもう1回呼んでも全フィールドダンプが変わらない（＝1回目で収束済み）
// ことを確認する。
test('【B-5・収束】reflectStructuralToOtherFloors: ctx省略（既定経路）でも外部から1回呼ぶだけで収束する（続けてもう1回呼んでもダンプが変わらない）', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    project.activePlaneId = project.planes.find(p => p.name === '1階').id;

    await reflectStructuralToOtherFloors(project); // ctx省略・外部からの呼び出しは1回だけ
    const dumpAfterOnce = await dumpB1AllFloorsAllFields(project);
    // 前提: 非アクティブ階（2階・3階・屋根）は空ダンプであってはならない（save→本番peek往復で
    // 壁・CLが失われていないことの構造的な担保。1階はアクティブのためreflectStructuralToOtherFloors
    // 単体では構造部材を計算しない——assertB1NonEmptyは全実体階を対象にするためここでは使えない）。
    for (const floorName of ['2階', '3階']) {
      assert.ok(dumpAfterOnce[floorName].columns.length > 0 && dumpAfterOnce[floorName].beams.length > 0,
        `${floorName}は空ダンプであってはならない（実際: columns=${dumpAfterOnce[floorName].columns.length} beams=${dumpAfterOnce[floorName].beams.length}）`);
    }
    assert.ok(dumpAfterOnce[''].fuseCLs.length > 0 || dumpAfterOnce[''].beams.length > 0,
      '屋根は壁線方式の軒桁を1本以上持つ（空ダンプであってはならない）');

    await reflectStructuralToOtherFloors(project); // もう1回呼んでも（ctx省略・別コンテキストを生成）
    const dumpAfterTwice = await dumpB1AllFloorsAllFields(project);
    assert.deepEqual(dumpAfterTwice, dumpAfterOnce,
      'ctx省略（既定経路）でも、外部からもう1回呼んでも全フィールドダンプが変わらない（1回目で既に収束している）');
  });
});

// ---- 4e. 非在来（S造）のctx経路での再計算回数（コーディネーター差し戻し・Minor 4・2026-09-21）----
// 既存の【統合】非在来1パス固定テストは【B-5是正】でctx:null固定にした（floorSwapManager.peekの
// 実回数を手動導出して固定する既存の検証手段が、ctx経由だとキャッシュヒットで発火しなくなり
// 意味を変えるため）。ctx経路では「反映対象の各非アクティブ階が1パスだけ再計算される」こと
// （sawWallRunsが立たないため内部パスを2回目へ進めない）を、物理peek回数（floorSwapManager.peek。
// ctxのキャッシュヒット時は発火しない）ではなく、graphFor呼び出し回数そのもの
// （ctx.stats.hit+ctx.stats.peek。キャッシュヒットでも必ず加算される——
// structuralResolveContext.js graphFor参照）で数える——これは「反映対象の各階が何回peekを
// “試みた”か」を、物理I/Oの有無に関わらず正確に捉える（recomputeStructuralForGraph自体は
// named export の関数でありESM live bindingのため本ファイル側から呼び出し元の参照を
// 差し替えられず、直接ラップできない。fake IDBの書込み回数は「変化があった時だけ」しか
// 増えないため、変化なしの繰り返しパスを検出できない——graphFor呼び出し回数だけがパス数を
// 過不足なく反映する）。
// ctxは省略（自前生成）ではなく明示的に生成して渡す——.statsを読むため（借り物として渡すだけで、
// 挙動はctx省略時と同一であることは【B-5・A/B等価】群で別途確認済み）。
test('【B-5・統合】reflectStructuralToOtherFloors: 非在来（S造）はctx経路でも各非アクティブ階のgraphFor呼び出し回数が1回のまま変わらない（sawWallRunsが立たないため内部パスを繰り返さない）', async () => {
  await withFakeIndexedDB(async () => {
    const project = new Project('proj-nonwood-onepass-b5', 'test');
    const { graph: g1 } = project.addPlane(0, '1階', 'p1');
    const { graph: g2 } = project.addPlane(3000, '2階', 'p2');
    project.activePlaneId = null;
    g1.structureOverride = 'S造';
    g2.structureOverride = 'S造';
    // 柱グリッドを構成する通り芯（毎回changed=trueになるよう、まだ柱が無い状態から始める）。
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.VERTICAL,   3640, { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
    project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 1820, { labeled: true, discipline: Discipline.STRUCT });
    await saveFloor('p1', serializeGraph(g1));
    await saveFloor('p2', serializeGraph(g2));

    const ctx = createStructuralResolveContext();
    try {
      await reflectStructuralToOtherFloors(project, ctx);
      // 実測値（本フィクスチャでの固定値）。収集フェーズ・採番適用フェーズそれぞれ各階1回に加え、
      // recomputeStructuralForGraph内部（buildStructuralWallGate・resolveLowestGraph等）が
      // 「下の実体階」「1つ上の実体階」を求めるために階をまたいでもう1回graphForを呼ぶ分
      // （非在来でも基礎伏図の解決に使われる）を含めた合計——sawWallRunsが立たない非在来は
      // 収集の内部パスが2回目へ進まないため、この値を超えない（内部パスが2回目へ進む変異が
      // 起きれば、この合計値がさらに増える）。
      assert.equal(ctx.stats.hit + ctx.stats.peek, 5,
        `非在来はgraphFor呼び出し合計がこの上限で頭打ちになる（実際:${ctx.stats.hit + ctx.stats.peek}）`);
    } finally {
      ctx.dispose();
    }
  });
});

// ---- 5. 渡されたctxはdisposeしない（正常終了時）／ctx:nullはコンテキストを生成しない ----
test('【B-4】runStructuralModeSetup: 渡されたctxは正常終了時もdisposeされない（所有者は呼び出し側のまま）', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activePlane = project.planes.find(p => p.name === '3階');
    project.activePlaneId = activePlane.id;
    const spy = spyOnContextDispose();
    const ctx = createStructuralResolveContext();
    try {
      await runStructuralModeSetup(project.activeGraph, project, { ctx });
      assert.equal(spy.calls.length, 0, '渡されたctxは正常終了時もdisposeされない');
    } finally {
      spy.restore();
      ctx.dispose();
      await figureBindingManager.deactivate();
    }
  });
});

test('【B-4】runStructuralModeSetup: ctx:null を明示するとコンテキストを生成しない（従来経路。disposeも呼ばれない）', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activePlane = project.planes.find(p => p.name === '3階');
    project.activePlaneId = activePlane.id;
    const spy = spyOnContextDispose();
    try {
      await runStructuralModeSetup(project.activeGraph, project, { ctx: null });
      assert.equal(spy.calls.length, 0, 'ctx:null明示時はコンテキストを生成しない（生成していればfinallyでdisposeされ検出されるはず）');
    } finally {
      spy.restore();
      await figureBindingManager.deactivate();
    }
  });
});

// ==== B-5（構造再計算の高速化・2026-09-21）: 反映3経路（reflectStructuralToOtherFloors・
// reflectStructuralAfterFinishExit・reflectStructuralAfterFloorAdd）が自分でコンテキストを生成する ====
// buildB1Fixture/saveB1InitialFloors/dumpB1AllFloorsAllFields/spyOnContextDispose（【B-4】節）を再利用する。
// A/B等価の比較はdumpB1AllFloorsAllFields（全フィールド）を使う（コーディネーター差し戻し 1）。

async function runReflectB1(activeLabel, ctxOption) {
  return withFakeIndexedDB(async () => {
    const { project, roofPlane } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activePlane = activeLabel === '屋根' ? roofPlane : project.planes.find(p => p.name === activeLabel);
    project.activePlaneId = activePlane.id;
    await reflectStructuralToOtherFloors(project, ctxOption);
    return await dumpB1AllFloorsAllFields(project);
  });
}

async function runFloorAddB1(activeLabel, ctxOption) {
  return withFakeIndexedDB(async () => {
    const { project, roofPlane } = buildB1Fixture();
    await saveB1InitialFloors(project);
    // 「階追加直後相当の状態」＝追加直後の表示階（新設階）がアクティブなまま反映を呼ぶ。
    const activePlane = activeLabel === '屋根' ? roofPlane : project.planes.find(p => p.name === activeLabel);
    project.activePlaneId = activePlane.id;
    await reflectStructuralAfterFloorAdd(project, ctxOption);
    return await dumpB1AllFloorsAllFields(project);
  });
}

async function runFinishExitB1(currentLabel, goingToStructure, ctxOption) {
  return withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    // finishBoundary.js の実配線と同じく、脱出元の階（graph.plane）がアクティブのまま呼ぶ。
    const currentPlane = project.planes.find(p => p.name === currentLabel);
    project.activePlaneId = currentPlane.id;
    await reflectStructuralAfterFinishExit(currentPlane.id, goingToStructure, project, ctxOption);
    return await dumpB1AllFloorsAllFields(project);
  });
}

// ---- 1. A/B等価: ctx省略（生成）とctx:null（従来経路）で全階の全フィールドが完全一致する ----
for (const label of ['1階', '2階', '3階', '屋根']) {
  test(`【B-5・A/B等価】reflectStructuralToOtherFloors: アクティブ=${label}でctx省略とctx:nullが同じ結果になる（柱・梁・footings/slabs・除外集合・columnAxisOffsets・梁芯CLを含む全フィールド一致）`, async () => {
    const traditional = await runReflectB1(label, null);
    const owned = await runReflectB1(label, undefined);
    assert.deepEqual(owned, traditional,
      `アクティブ=${label}: ctx省略（コンテキスト生成）とctx:null（従来経路）で全フィールドのダンプが一致する`);
  });
}

for (const label of ['1階', '2階', '3階', '屋根']) {
  test(`【B-5・A/B等価】reflectStructuralAfterFloorAdd: アクティブ=${label}でctx省略とctx:nullが同じ結果になる（柱・梁・footings/slabs・除外集合・columnAxisOffsets・梁芯CLを含む全フィールド一致）`, async () => {
    const traditional = await runFloorAddB1(label, null);
    const owned = await runFloorAddB1(label, undefined);
    assert.deepEqual(owned, traditional,
      `アクティブ=${label}: ctx省略（コンテキスト生成）とctx:null（従来経路）で全フィールドのダンプが一致する`);
  });
}

for (const currentLabel of ['1階', '2階']) {
  for (const goingToStructure of [false, true]) {
    test(`【B-5・A/B等価】reflectStructuralAfterFinishExit: currentPlane=${currentLabel}・goingToStructure=${goingToStructure}でctx省略とctx:nullが同じ結果になる（柱・梁・footings/slabs・除外集合・columnAxisOffsets・梁芯CLを含む全フィールド一致）`, async () => {
      const traditional = await runFinishExitB1(currentLabel, goingToStructure, null);
      const owned = await runFinishExitB1(currentLabel, goingToStructure, undefined);
      assert.deepEqual(owned, traditional,
        `currentPlane=${currentLabel}・goingToStructure=${goingToStructure}: ctx省略とctx:nullで全フィールドのダンプが一致する`);
    });
  }
}

// ---- 2. peek削減: ctx省略はctx:nullより実peek回数が少ない ----
test('【B-5・peek削減】reflectStructuralToOtherFloors: ctx省略（生成）はctx:null（従来経路）よりfloorSwapManager.peek実回数が少ない', async () => {
  async function countPeeks(ctxOption) {
    return withFakeIndexedDB(async () => {
      const { project } = buildB1Fixture();
      await saveB1InitialFloors(project);
      project.activePlaneId = project.planes.find(p => p.name === '3階').id;
      let count = 0;
      const originalPeek = floorSwapManager.peek.bind(floorSwapManager);
      floorSwapManager.peek = async (...args) => { count++; return originalPeek(...args); };
      try {
        await reflectStructuralToOtherFloors(project, ctxOption);
      } finally {
        floorSwapManager.peek = originalPeek;
      }
      return count;
    });
  }
  const traditionalCount = await countPeeks(null);
  const ownedCount = await countPeeks(undefined);
  assert.equal(traditionalCount, 43, `ctx:null（従来経路）のpeek実回数（実測値）。実際:${traditionalCount}`);
  assert.equal(ownedCount, 4, `ctx省略（コンテキスト生成）のpeek実回数（実測値）。実際:${ownedCount}`);
  assert.ok(ownedCount < traditionalCount, 'ctx省略の方が実peek回数が少ない');
});

test('【B-5・peek削減】reflectStructuralAfterFloorAdd: ctx省略（生成）はctx:null（従来経路）よりfloorSwapManager.peek実回数が少ない', async () => {
  async function countPeeks(ctxOption) {
    return withFakeIndexedDB(async () => {
      const { project } = buildB1Fixture();
      await saveB1InitialFloors(project);
      project.activePlaneId = project.planes.find(p => p.name === '3階').id;
      let count = 0;
      const originalPeek = floorSwapManager.peek.bind(floorSwapManager);
      floorSwapManager.peek = async (...args) => { count++; return originalPeek(...args); };
      try {
        await reflectStructuralAfterFloorAdd(project, ctxOption);
      } finally {
        floorSwapManager.peek = originalPeek;
      }
      return count;
    });
  }
  const traditionalCount = await countPeeks(null);
  const ownedCount = await countPeeks(undefined);
  assert.equal(traditionalCount, 48, `ctx:null（従来経路）のpeek実回数（実測値）。実際:${traditionalCount}`);
  assert.equal(ownedCount, 4, `ctx省略（コンテキスト生成）のpeek実回数（実測値）。実際:${ownedCount}`);
  assert.ok(ownedCount < traditionalCount, 'ctx省略の方が実peek回数が少ない');
});

test('【B-5・peek削減】reflectStructuralAfterFinishExit: ctx省略（生成）はctx:null（従来経路）よりfloorSwapManager.peek実回数が少ない', async () => {
  async function countPeeks(ctxOption) {
    return withFakeIndexedDB(async () => {
      const { project } = buildB1Fixture();
      await saveB1InitialFloors(project);
      const currentPlane = project.planes.find(p => p.name === '1階');
      project.activePlaneId = currentPlane.id;
      let count = 0;
      const originalPeek = floorSwapManager.peek.bind(floorSwapManager);
      floorSwapManager.peek = async (...args) => { count++; return originalPeek(...args); };
      try {
        await reflectStructuralAfterFinishExit(currentPlane.id, false, project, ctxOption);
      } finally {
        floorSwapManager.peek = originalPeek;
      }
      return count;
    });
  }
  const traditionalCount = await countPeeks(null);
  const ownedCount = await countPeeks(undefined);
  assert.equal(traditionalCount, 58, `ctx:null（従来経路）のpeek実回数（実測値）。実際:${traditionalCount}`);
  assert.equal(ownedCount, 4, `ctx省略（コンテキスト生成）のpeek実回数（実測値）。実際:${ownedCount}`);
  assert.ok(ownedCount < traditionalCount, 'ctx省略の方が実peek回数が少ない');
});

// ---- 3. 失敗系・例外時も破棄: 例外が伝播し、ownedなコンテキストはdisposeされ、渡されたctxはdisposeされない ----
test('【B-5・失敗系】reflectStructuralToOtherFloors: 例外が呼び出し元へ伝播し、ownedなコンテキストはdisposeされ、渡されたctxはdisposeされない', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    project.activePlaneId = project.planes.find(p => p.name === '3階').id;

    const spy = spyOnContextDispose();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async () => { throw new Error('注入した失敗（peek）'); };
    try {
      await assert.rejects(
        reflectStructuralToOtherFloors(project, undefined),
        /注入した失敗/,
        '例外が呼び出し元へ伝播する',
      );
      assert.equal(spy.calls.length, 1, '例外時もownedなコンテキストがdisposeされる（finallyで1回）');

      spy.calls.length = 0;
      const passedCtx = createStructuralResolveContext();
      await assert.rejects(
        reflectStructuralToOtherFloors(project, passedCtx),
        /注入した失敗/,
      );
      assert.equal(spy.calls.length, 0, '渡されたctxは例外時もdisposeされない（所有者は呼び出し側のまま）');
      passedCtx.dispose();
    } finally {
      floorSwapManager.peek = originalPeek;
      spy.restore();
    }
  });
});

test('【B-5・失敗系】reflectStructuralAfterFloorAdd: 例外が呼び出し元へ伝播し、ownedなコンテキストはdisposeされ、渡されたctxはdisposeされない', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    project.activePlaneId = project.planes.find(p => p.name === '3階').id;

    const spy = spyOnContextDispose();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async () => { throw new Error('注入した失敗（peek）'); };
    try {
      await assert.rejects(
        reflectStructuralAfterFloorAdd(project, undefined),
        /注入した失敗/,
        '例外が呼び出し元へ伝播する',
      );
      assert.equal(spy.calls.length, 1, '例外時もownedなコンテキストがdisposeされる（finallyで1回）');

      spy.calls.length = 0;
      const passedCtx = createStructuralResolveContext();
      await assert.rejects(
        reflectStructuralAfterFloorAdd(project, passedCtx),
        /注入した失敗/,
      );
      assert.equal(spy.calls.length, 0, '渡されたctxは例外時もdisposeされない（所有者は呼び出し側のまま）');
      passedCtx.dispose();
    } finally {
      floorSwapManager.peek = originalPeek;
      spy.restore();
    }
  });
});

test('【B-5・失敗系】reflectStructuralAfterFinishExit: 例外が呼び出し元へ伝播し、ownedなコンテキストはdisposeされ、渡されたctxはdisposeされない', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const currentPlane = project.planes.find(p => p.name === '1階');
    project.activePlaneId = currentPlane.id;

    const spy = spyOnContextDispose();
    const originalPeek = floorSwapManager.peek;
    floorSwapManager.peek = async () => { throw new Error('注入した失敗（peek）'); };
    try {
      await assert.rejects(
        reflectStructuralAfterFinishExit(currentPlane.id, false, project, undefined),
        /注入した失敗/,
        '例外が呼び出し元へ伝播する',
      );
      assert.equal(spy.calls.length, 1, '例外時もownedなコンテキストがdisposeされる（finallyで1回）');

      spy.calls.length = 0;
      const passedCtx = createStructuralResolveContext();
      await assert.rejects(
        reflectStructuralAfterFinishExit(currentPlane.id, false, project, passedCtx),
        /注入した失敗/,
      );
      assert.equal(spy.calls.length, 0, '渡されたctxは例外時もdisposeされない（所有者は呼び出し側のまま）');
      passedCtx.dispose();
    } finally {
      floorSwapManager.peek = originalPeek;
      spy.restore();
    }
  });
});

// ---- 4. 二重生成しない: 1回の反映につきコンテキスト生成（＝dispose呼び出し）は1個だけ ----
test('【B-5・二重生成】reflectStructuralToOtherFloors: ctx省略時、1回の呼び出しで生成・破棄されるコンテキストは1個だけ', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    project.activePlaneId = project.planes.find(p => p.name === '3階').id;
    const spy = spyOnContextDispose();
    try {
      await reflectStructuralToOtherFloors(project, undefined);
      assert.equal(spy.calls.length, 1, '1回の呼び出しでdisposeされるコンテキストは1個だけ（二重生成していない）');
    } finally {
      spy.restore();
    }
  });
});

test('【B-5・二重生成】reflectStructuralAfterFloorAdd: ctx省略時、1回の呼び出しで生成・破棄されるコンテキストは1個だけ（内側のreflectStructuralToOtherFloorsが自前生成していない）', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    project.activePlaneId = project.planes.find(p => p.name === '3階').id;
    const spy = spyOnContextDispose();
    try {
      await reflectStructuralAfterFloorAdd(project, undefined);
      assert.equal(spy.calls.length, 1, '1回の呼び出しでdisposeされるコンテキストは1個だけ（recomputeActiveStructural・reflectStructuralToOtherFloorsが同じctxを共有する）');
    } finally {
      spy.restore();
    }
  });
});

test('【B-5・二重生成】reflectStructuralAfterFinishExit: ctx省略時、1回の呼び出しで生成・破棄されるコンテキストは1個だけ', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const currentPlane = project.planes.find(p => p.name === '1階');
    project.activePlaneId = currentPlane.id;
    const spy = spyOnContextDispose();
    try {
      await reflectStructuralAfterFinishExit(currentPlane.id, false, project, undefined);
      assert.equal(spy.calls.length, 1, '1回の呼び出しでdisposeされるコンテキストは1個だけ（内部のrecomputeInactiveStructural・reflectRoofPlane・applyMemberNumbers*が同じctxを共有する）');
    } finally {
      spy.restore();
    }
  });
});

test('【B-5・二重生成】runStructuralModeSetup: ctx省略時、1回の突入で生成・破棄されるコンテキストは1個だけ（内側のreflectStructuralToOtherFloorsが自前生成していない）', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const activePlane = project.planes.find(p => p.name === '3階');
    project.activePlaneId = activePlane.id;
    const spy = spyOnContextDispose();
    try {
      await runStructuralModeSetup(project.activeGraph, project, {});
      assert.equal(spy.calls.length, 1, '1回の突入でdisposeされるコンテキストは1個だけ（二重生成していない）');
    } finally {
      spy.restore();
      await figureBindingManager.deactivate();
    }
  });
});

// ---- 5. 渡されたctxはdisposeしない（正常終了時）／ctx:nullはコンテキストを生成しない ----
test('【B-5】reflectStructuralAfterFloorAdd・reflectStructuralAfterFinishExit: 渡されたctxは正常終了時もdisposeされず、ctx:null明示時は生成しない', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    const p3 = project.planes.find(p => p.name === '3階');
    const p1 = project.planes.find(p => p.name === '1階');

    project.activePlaneId = p3.id;
    const spy1 = spyOnContextDispose();
    const ctx1 = createStructuralResolveContext();
    try {
      await reflectStructuralAfterFloorAdd(project, ctx1);
      assert.equal(spy1.calls.length, 0, 'reflectStructuralAfterFloorAdd: 渡されたctxは正常終了時もdisposeされない');
    } finally {
      spy1.restore();
      ctx1.dispose();
    }

    project.activePlaneId = p1.id;
    const spy2 = spyOnContextDispose();
    try {
      await reflectStructuralAfterFloorAdd(project, null);
      assert.equal(spy2.calls.length, 0, 'reflectStructuralAfterFloorAdd: ctx:null明示時はコンテキストを生成しない');
    } finally {
      spy2.restore();
    }

    project.activePlaneId = p1.id;
    const spy3 = spyOnContextDispose();
    const ctx3 = createStructuralResolveContext();
    try {
      await reflectStructuralAfterFinishExit(p1.id, false, project, ctx3);
      assert.equal(spy3.calls.length, 0, 'reflectStructuralAfterFinishExit: 渡されたctxは正常終了時もdisposeされない');
    } finally {
      spy3.restore();
      ctx3.dispose();
    }

    project.activePlaneId = p1.id;
    const spy4 = spyOnContextDispose();
    try {
      await reflectStructuralAfterFinishExit(p1.id, false, project, null);
      assert.equal(spy4.calls.length, 0, 'reflectStructuralAfterFinishExit: ctx:null明示時はコンテキストを生成しない');
    } finally {
      spy4.restore();
    }
  });
});

// ==== B-6（構造再計算の高速化・2026-09-21）: recomputeStructuralForGraphがoptions.wallSourceCache/
// footprintCacheの既定をctx優先へ変える（cacheの寿命が「1回のrecompute呼び出し」から「1回の
// 反映処理」へ広がる）。単体レベルの3通りの場合分け・cache共有の直接観測・dispose時フォールバックは
// woodAutoFill.test.jsの【統合・ステップB-6】節を参照——ここでは反映処理レベルの前提固定・干渉系を扱う。
// 既存のA/Bテスト（【B-4・A/B等価】【B-5・A/B等価】。上記）はB-6適用後もそのまま全て緑のまま
// （recomputeStructuralForGraphの呼び出し元はどこもwallSourceCache/footprintCacheを明示しないため、
// ctxがあるときは自動的にctxのcacheを使う経路へ切り替わるが、解自体は変わらない）——individual A/B
// equivalence の追加テストは不要と判断（本ファイル全体のtest実行結果で確認済み。報告参照）。

// ---- 前提の固定（不変条件）: 反映処理をまたいでも各階の壁区間・分割格子・cellToRoomの対応は不変 ----
// C/Aのキャッシュ（wallSourceCache/footprintCache）の寿命を「1回のrecompute呼び出し」から「1回の
// 反映処理」へ広げてよい根拠——複数回のrecomputeStructuralForGraph呼び出し・applyNumbers/
// conformToLedgerを跨いでも、壁（selfWallSegments。cache無しで毎回全走査）・分割格子
// （gridIndexOf。isDividerCLが真のCLのvalue/extent）・cellToRoom（buildCellToRoom。Room.cells/kind/
// featureから決まる）が一切変わらないことを、実際の反映パイプライン（突入→他階反映→仕上げ退出後の
// 反映、を1つのフィクスチャで連続して回す）で固定する。崩れる変更（例: 将来どこかが分割CLを足す）が
// 入ったら赤くなる。
// 壁区間側は前提を崩す変異での赤化を証明できていない（壁を書く変異は収束を壊してテスト自体が回らない）。
// 壁区間cacheの陳腐化はinterference.test.jsの【B-6・失敗系】（壁追加の干渉）が守る。
function wallSegmentsSnapshot(g) {
  return selfWallSegments(g)
    .map(s => `${s.isVertical}:${Math.round(s.coord)}:${Math.round(s.lo)}..${Math.round(s.hi)}:${Math.round(s.halfDepth)}`)
    .sort();
}
function gridIndexSnapshot(g) {
  const { verticals, horizontals } = gridIndexOf(g);
  const line = (cl) => `${Math.round(cl.value)}:${cl.extentLo == null ? 'null' : Math.round(cl.extentLo)}..${cl.extentHi == null ? 'null' : Math.round(cl.extentHi)}`;
  return { verticals: verticals.map(line).sort(), horizontals: horizontals.map(line).sort() };
}
function cellToRoomSnapshot(g) {
  return [...buildCellToRoom(g)].map(([key, room]) => `${key}=${room.kind}:${room.feature ?? 'null'}`).sort();
}
async function wallGridSnapshotForAllRealFloors(project) {
  const out = {};
  for (const p of project.planes) {
    const g = p.id === project.activePlaneId ? project.activeGraph : await floorSwapManager.peek(p, project.structGraph);
    out[p.name] = { walls: wallSegmentsSnapshot(g), grid: gridIndexSnapshot(g), cellToRoom: cellToRoomSnapshot(g) };
  }
  return out;
}

test('【不変条件・B-6】在来木造・3階建て＋屋根のフィクスチャで反映処理（突入→他階反映→仕上げ退出後の反映）を連続して回しても、各階の壁区間（selfWallSegments）・分割格子（gridIndexOf）・cellToRoom（buildCellToRoom）の対応が変わらない（構造再計算は壁・部屋・分割CLを書かない前提の固定）', async () => {
  await withFakeIndexedDB(async () => {
    const { project } = buildB1Fixture();
    await saveB1InitialFloors(project);
    project.activePlaneId = project.planes.find(p => p.name === '1階').id;
    try {
      const before = await wallGridSnapshotForAllRealFloors(project);
      for (const name of ['1階', '2階', '3階']) {
        assert.ok(before[name].walls.length > 0, `前提: ${name}に壁がある`);
        assert.ok(before[name].cellToRoom.length > 0, `前提: ${name}に部屋セルがある`);
      }

      await runStructuralModeSetup(project.activeGraph, project, {});
      await reflectStructuralToOtherFloors(project);
      await reflectStructuralAfterFinishExit(project.activePlaneId, false, project);

      const after = await wallGridSnapshotForAllRealFloors(project);
      assert.deepEqual(after, before,
        '反映処理（突入・他階反映・仕上げ退出後の反映）をまたいでも壁区間・分割格子・cellToRoomの対応は不変のまま');
    } finally {
      await figureBindingManager.deactivate();
    }
  });
});

// ---- 失敗系（壁を1枚追加する干渉）: structuralOrchestration.interference.test.js へ移設（差し戻し対応・
// 2026-09-21）。onFloorsPutフックに依存する干渉系テストは、本ファイル内の他の多数のtest()が先に
// openDB()を成功させると_dbPromiseキャッシュ越しに干渉が一度も発火しない空振りになる
// （storage/db.js openDB()参照。node --testはファイル単位でプロセスが分離されるため、専用ファイルへ
// 切り出すことで確実に発火する新品のfakeDbを使える）。移設先を参照。
