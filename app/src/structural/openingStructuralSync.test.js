// openingStructuralSync.js の単体テスト＋統合テスト（openings/openingEdit.js との配線）。
// 単体テストはダックタイピングの軽量graph/projectで足りる範囲（openingGeometryChanged・
// createOpeningStructuralSyncのコアレス/whenIdle/エラー経路）に限定し、実際の柱生成を伴う配線の
// 検証は末尾の統合テストで実core.js（Plane/PlanGraph/Project）を使う
// （structuralOrchestration.test.js makeSinglePlaneProjectと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import { undoManager } from '../undoManager.js';
import { TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from './structureRules.js';
import { placeOpeningWithDefaults, removeOpeningWithUndo, setOpeningGeometryListener, openingGeometryChanged } from '../openings/openingEdit.js';
import { createOpeningStructuralSync, openingStructuralSync } from './openingStructuralSync.js';

// ================================================================
// openingGeometryChanged
// ================================================================

function snap(overrides = {}) {
  return { refCLId: 'cl-1', refOffset: 1000, width: 800, note: null, height: 2000, subType: 'singleSwing', ...overrides };
}

test('openingGeometryChanged: refCLId・refOffset・widthのいずれかが違えばtrue', () => {
  assert.equal(openingGeometryChanged(snap(), snap({ refCLId: 'cl-2' })), true);
  assert.equal(openingGeometryChanged(snap(), snap({ refOffset: 1200 })), true);
  assert.equal(openingGeometryChanged(snap(), snap({ width: 900 })), true);
});

test('openingGeometryChanged: note/height/subTypeだけが違ってもfalse（構造に無関係な変更）', () => {
  assert.equal(openingGeometryChanged(snap(), snap({ note: '網戸付き' })), false);
  assert.equal(openingGeometryChanged(snap(), snap({ height: 1800 })), false);
  assert.equal(openingGeometryChanged(snap(), snap({ subType: 'doubleSwing' })), false);
});

test('openingGeometryChanged: 完全同一ならfalse', () => {
  assert.equal(openingGeometryChanged(snap(), snap()), false);
});

// ================================================================
// createOpeningStructuralSync（軽量ダックタイピングgraph/project。recomputeは差し替える）
// ================================================================

function makeFakeGraph(structureOverride = TRADITIONAL_WOOD_STRUCTURE) {
  return { structureOverride };
}
function makeFakeProject(graph) {
  return { activeGraph: graph, structuralInfo: { mainStructure: TRADITIONAL_WOOD_STRUCTURE } };
}

test('request: 在来木造・アクティブ階ならrecomputeを1回呼ぶ', async () => {
  const graph = makeFakeGraph();
  const project = makeFakeProject(graph);
  let calls = 0;
  const sync = createOpeningStructuralSync({ recompute: async () => { calls++; } });
  sync.request(graph, project);
  await sync.whenIdle();
  assert.equal(calls, 1);
});

test('【失敗系】request: 非在来（主構造ルールがwallIntersectionsでない）はrecomputeを呼ばない', async () => {
  const graph = makeFakeGraph(UNSPECIFIED_STRUCTURE);
  const project = makeFakeProject(graph);
  let calls = 0;
  const sync = createOpeningStructuralSync({ recompute: async () => { calls++; } });
  sync.request(graph, project);
  await sync.whenIdle();
  assert.equal(calls, 0);
});

test('【失敗系】request: 非アクティブ階（graph!==project.activeGraph）はrecomputeを呼ばない', async () => {
  const graph = makeFakeGraph();
  const otherGraph = makeFakeGraph();
  const project = makeFakeProject(otherGraph); // activeGraphは別インスタンス
  let calls = 0;
  const sync = createOpeningStructuralSync({ recompute: async () => { calls++; } });
  sync.request(graph, project);
  await sync.whenIdle();
  assert.equal(calls, 0);
});

test('request: 実行中に来た複数要求は1件にコアレスされる（3要求→合計2回、whenIdleは全完了後にresolve）', async () => {
  const graph = makeFakeGraph();
  const project = makeFakeProject(graph);
  let calls = 0;
  let resolveFirst;
  const first = new Promise(r => { resolveFirst = r; });
  const recompute = async () => {
    calls++;
    if (calls === 1) await first; // 1回目だけ長引かせ、その間に追加要求を積ませる
  };
  const sync = createOpeningStructuralSync({ recompute });

  sync.request(graph, project); // 1回目（実行開始）
  sync.request(graph, project); // 実行中→コアレス
  sync.request(graph, project); // 実行中→コアレス（上書き）
  sync.request(graph, project); // 実行中→コアレス（上書き）

  let idleResolved = false;
  const idle = sync.whenIdle().then(() => { idleResolved = true; });
  assert.equal(idleResolved, false, 'まだ実行中はresolveしないはず');

  resolveFirst();
  await idle;
  assert.equal(idleResolved, true);
  assert.equal(calls, 2, '3件のコアレス要求は合計1回の再実行にまとまり、実行中の1回と合わせて2回のはず');
});

test('【失敗系】request: recomputeがthrowしてもonErrorを1回呼び、busyが解けて次のrequestは通る', async () => {
  const graph = makeFakeGraph();
  const project = makeFakeProject(graph);
  let calls = 0;
  const errors = [];
  const sync = createOpeningStructuralSync({
    recompute: async () => { calls++; throw new Error('boom'); },
    onError: (err) => errors.push(err),
  });

  sync.request(graph, project);
  await sync.whenIdle();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'boom');

  sync.request(graph, project);
  await sync.whenIdle();
  assert.equal(calls, 2, 'エラー後もbusyが解けて次のrequestが実行されるはず');
  assert.equal(errors.length, 2);
});

test('whenIdle: 実行中でなければ即座にresolveする', async () => {
  const sync = createOpeningStructuralSync({ recompute: async () => {} });
  let resolved = false;
  await sync.whenIdle().then(() => { resolved = true; });
  assert.equal(resolved, true);
});

// ================================================================
// 統合テスト: openings/openingEdit.js → openingStructuralSync の配線（実core.js/Project）。
// 建具の確定・undo直後に自階の構造が再計算され、袖柱が自動で立つ／消えることを確認する。
// 「重なった自動柱の消滅」（既存の自動柱が建具に覆われて撤去されるケース）は、woodAutoFill.js の
// 3a（壁交点）自体は開口の有無を見ないため合成フィクスチャでは再現できず、実データ
// （app/scripts/probe/openingJambInsertProbe.mjs・tategu-test3.stq）側で確認する
// （.claude/structural-model.md「建具の袖柱」参照）。
// ================================================================

function makeTraditionalWoodFixture() {
  const project = new Project('proj-opening-sync', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;

  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: true, discipline: Discipline.STRUCT });
  const x2 = graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: true, discipline: Discipline.STRUCT });

  // 横壁 y=2000（x1..x2）に下地帯を持つ内壁を1本（woodAutoFill.test.js addBackingWallと同じ規約）。
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, 0, false, x1, 0, x2, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5, isExteriorWall: false });
  return { project, graph, wall };
}

test('統合: placeOpeningWithDefaultsで建具を確定すると自階の構造が自動再計算され、袖柱2本が立つ', async () => {
  setOpeningGeometryListener((g, p) => openingStructuralSync.request(g, p));
  try {
    const { project, graph, wall } = makeTraditionalWoodFixture();
    assert.equal(graph.columns.filter(c => c.woodJambRef).length, 0, '前提: 配置前は袖柱0本');

    const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 2000, y: 2000 }, OpeningCategory.WINDOW);
    assert.equal(error, null);
    assert.ok(opening);

    // 建具側は手動でrecomputeを呼んでいない——ここでのwhenIdleは、確定直後に
    // geometryListener経由で自動起動されたrequestの完了を待つだけ。
    await openingStructuralSync.whenIdle();

    const jambs = graph.columns.filter(c => c.woodJambRef?.openingId === opening.id);
    assert.equal(jambs.length, 2, '建具の両袖に自動で袖柱が2本立つはず（手動でautoFillWoodColumns等を呼んでいない）');
    assert.deepEqual(jambs.map(c => c.woodJambRef.side).sort(), [-1, 1]);
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('統合: undo後に自動再計算され、袖柱が撤去されて配置前の状態に戻る', async () => {
  setOpeningGeometryListener((g, p) => openingStructuralSync.request(g, p));
  try {
    const { project, graph, wall } = makeTraditionalWoodFixture();

    const { opening } = placeOpeningWithDefaults(graph, project, wall, { x: 2000, y: 2000 }, OpeningCategory.WINDOW);
    await openingStructuralSync.whenIdle();
    assert.equal(graph.columns.filter(c => c.woodJambRef?.openingId === opening.id).length, 2, '前提: 袖柱2本が立っている');
    // 袖柱以外（壁の自由端に立つF-1柱。開口の有無とは無関係に生成される）はundoで変わらないはずの
    // ベースライン——建具を置く前は自動再計算が一度も走っていないため0本のまま（.length===0）だった
    // ことと比較するのではなく、この時点のベースラインと比較する。
    const nonJambBaseline = graph.columns.filter(c => !c.woodJambRef).map(c => c.id).sort();

    undoManager.undo();
    await openingStructuralSync.whenIdle();

    assert.equal(graph.columns.filter(c => c.woodJambRef).length, 0, 'undo後は自動再計算され袖柱0本に戻るはず');
    assert.deepEqual(graph.columns.map(c => c.id).sort(), nonJambBaseline, '袖柱以外の柱集合は変わらないはず');

    undoManager.redo();
    await openingStructuralSync.whenIdle();
    assert.equal(graph.columns.filter(c => c.woodJambRef).length, 2, 'redoで再び袖柱2本が立つはず');
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('統合: removeOpeningWithUndoで建具を削除すると自動再計算され袖柱が撤去される', async () => {
  setOpeningGeometryListener((g, p) => openingStructuralSync.request(g, p));
  try {
    const { project, graph, wall } = makeTraditionalWoodFixture();
    const { opening } = placeOpeningWithDefaults(graph, project, wall, { x: 2000, y: 2000 }, OpeningCategory.WINDOW);
    await openingStructuralSync.whenIdle();
    assert.equal(graph.columns.filter(c => c.woodJambRef).length, 2, '前提: 袖柱2本が立っている');

    removeOpeningWithUndo(graph, project, opening);
    await openingStructuralSync.whenIdle();
    assert.equal(graph.columns.filter(c => c.woodJambRef).length, 0, '削除直後の自動再計算で袖柱が撤去されるはず');
  } finally {
    setOpeningGeometryListener(null);
  }
});

// ---- 検出力の裏付け（team-lessonsの「diff 0の主張は検出力を示す」規律）----
// QA指摘: 旧版はplaceOpeningWithDefaults直後（await whenIdleなし）に0本を確認していたため、
// 仮にlistenerが呼ばれていたとしても再計算はまだ非同期の途中で完了していない——つまり
// 「listenerが呼ばれなかったから0本」なのか「呼ばれたが待っていないので0本」なのか区別できず、
// 検出力が無かった（listener呼び出しを外しても常に緑のまま）。
// 配線あり／配線なしの同一操作を同じだけ（whenIdle完了まで）待って対照させることで、
// 「配線が無ければ何度待っても袖柱は立たない」ことを実際に検出できる形にする。
test('【検出力】geometryListener未設定なら、配線ありと同じだけ待っても自動再計算は起きない（対照）', async () => {
  // 対照1（配線あり）: 同じ操作をwhenIdleまで待てば袖柱が立つ。
  setOpeningGeometryListener((g, p) => openingStructuralSync.request(g, p));
  const wired = makeTraditionalWoodFixture();
  try {
    placeOpeningWithDefaults(wired.graph, wired.project, wired.wall, { x: 2000, y: 2000 }, OpeningCategory.WINDOW);
    await openingStructuralSync.whenIdle();
    assert.equal(wired.graph.columns.filter(c => c.woodJambRef).length, 2, '前提（対照）: 配線ありなら待てば袖柱が立つ');
  } finally {
    setOpeningGeometryListener(null);
  }

  // 対照2（配線なし）: 同じ操作・同じだけ（whenIdle完了まで）待っても袖柱は立たない。
  const unwired = makeTraditionalWoodFixture();
  assert.doesNotThrow(() => {
    placeOpeningWithDefaults(unwired.graph, unwired.project, unwired.wall, { x: 2000, y: 2000 }, OpeningCategory.WINDOW);
  });
  await openingStructuralSync.whenIdle();
  assert.equal(unwired.graph.columns.filter(c => c.woodJambRef).length, 0, 'listener未配線なら同じだけ待っても袖柱は立たないはず（自動発火していない証拠）');
});

// ================================================================
// 統合: request実行中に次の建具編集が来ても、最終状態は最後の建具位置で再計算した結果に一致する
// （コアレスの正しさを実recomputeで裏付ける。単体テストのfakeレコンピュートとは別に、実際に
// autoFillWoodColumnsが動く経路で「取りこぼし・古い位置での確定」が無いことを確認する）。
// ================================================================

test('統合: 1回目のrequestが実行中（recompute未完了）に位置を動かして2回目のrequestを送っても、最終的に最後の位置の袖柱に落ち着く', async () => {
  setOpeningGeometryListener((g, p) => openingStructuralSync.request(g, p));
  try {
    const { project, graph, wall } = makeTraditionalWoodFixture();
    // 配置確定でgeometryListenerが同期的に呼ばれ、openingStructuralSync.request→runLoopが
    // 開始する（busy=trueが同期的に立つ。recomputeActiveStructuralは最初のawaitまで実際の
    // graph変異を行わないため、以下の同期コードは「1回目のrecomputeがまだ何も変えていない」
    // タイミングで実行される＝request実行中の割り込みを人為的なawait/setTimeoutなしで再現できる）。
    const { opening } = placeOpeningWithDefaults(graph, project, wall, { x: 1200, y: 2000 }, OpeningCategory.WINDOW);

    // 1回目のrecomputeが完了する前に位置を動かし、2回目のrequestを送る（コアレスされる）。
    // refOffset=2200は壁の両端(F-1自由端柱。x=0,4000)から十分離れており、袖柱2本とも
    // 端の柱と重ならない位置（既存の「袖柱・1」フィクスチャと同じ考え方）。
    runInAction(() => { opening.refOffset = 2200; });
    openingStructuralSync.request(graph, project);

    await openingStructuralSync.whenIdle();

    const jambs = graph.columns.filter(c => c.woodJambRef?.openingId === opening.id);
    assert.equal(jambs.length, 2, '最終的に2本の袖柱に落ち着くはず');
    // 期待値はwoodAutoFill.test.js「建具の袖柱・1」と同じ式（clearance5mm+柱寸半分60mm＝65mm）で
    // 最後の位置（refOffset=2200）から導出する——1回目の位置（refOffset=1200）由来の値ではない
    // ことがこの一致で裏付けられる（コアレスされた再計算が古い位置を引きずっていない証拠）。
    const centerCoord = opening.refCL.effectiveValue + opening.refOffset; // 最後の位置（2200）
    const half = opening.width / 2;
    const jambClearanceOffset = 65; // clearance(5) + 柱寸(120)半分(60)
    const expected = [centerCoord - half - jambClearanceOffset, centerCoord + half + jambClearanceOffset].sort((a, b) => a - b);
    const actual = jambs.map(c => c.x).sort((a, b) => a - b);
    assert.deepEqual(actual, expected, `袖柱位置は最後の位置(2200)から導出した${expected}のはず（実際: ${actual}）`);
  } finally {
    setOpeningGeometryListener(null);
  }
});

// ================================================================
// 不変条件: App.jsxのactive graphを丸ごと読む・差し替える処理は、switchFloor・exit・
// collectFloorBytes・exportDocumentより前に openingStructuralSync.whenIdle() を待っている
// （.claude/undo-redo.md「落とし穴」参照。実行中の再計算がgraphを保存・差し替えしている最中に
// これらが走ると、途中状態がスナップショット・新階コピー元・保存文書に焼き込まれる）。
// ソース文字列検査の作法は wallRefresh.test.js の「App.jsx: runStructuralExitBoundary…」と同じ
// （波括弧の対応数で関数本体を抽出し、行コメントを落としてから判定する）。
// ================================================================

function extractFunctionBody(src, functionStartNeedle) {
  const startIdx = src.indexOf(functionStartNeedle);
  assert.ok(startIdx >= 0, `${functionStartNeedle} が見つからない`);
  const parenCloseIdx = src.indexOf(') {', startIdx);
  const braceStart = src.indexOf('{', parenCloseIdx);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(braceStart, i + 1);
  return body.split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
}

function assertWhenIdleBefore(body, targetNeedle, label) {
  const idleIdx = body.indexOf('openingStructuralSync.whenIdle()');
  assert.ok(idleIdx >= 0, `${label} の本体に openingStructuralSync.whenIdle() 呼び出しが無い`);
  const targetIdx = body.indexOf(targetNeedle);
  assert.ok(targetIdx >= 0, `${label} の本体に ${targetNeedle} が見つからない`);
  assert.ok(idleIdx < targetIdx, `${label} では openingStructuralSync.whenIdle() が ${targetNeedle} より前に無ければならない`);
}

test('【不変条件】App.jsx: switchHistoryContext は switchFloor( より前に openingStructuralSync.whenIdle() を待つ', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  const body = extractFunctionBody(appSrc, 'async function switchHistoryContext');
  assertWhenIdleBefore(body, 'switchFloor(', 'switchHistoryContext');
});

test('【不変条件】App.jsx: handleModeChange は modeBoundaries[appMode]?.exit?.( より前に openingStructuralSync.whenIdle() を待つ', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleModeChange');
  assertWhenIdleBefore(body, '?.exit?.(', 'handleModeChange');
});

test('【不変条件】App.jsx: handleFloorSwitch は modeBoundaries[appMode]?.exit?.( より前に openingStructuralSync.whenIdle() を待つ', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  const body = extractFunctionBody(appSrc, 'async function handleFloorSwitch');
  assertWhenIdleBefore(body, '?.exit?.(', 'handleFloorSwitch');
});

test('【不変条件】App.jsx: switchFloorKeepingMode は boundary?.exit?.( より前に openingStructuralSync.whenIdle() を待つ', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  const body = extractFunctionBody(appSrc, 'async function switchFloorKeepingMode');
  assertWhenIdleBefore(body, '?.exit?.(', 'switchFloorKeepingMode');
});

test('【不変条件】App.jsx: withFloorAddUndo は collectFloorBytes() より前に openingStructuralSync.whenIdle() を待つ', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  const body = extractFunctionBody(appSrc, 'async function withFloorAddUndo');
  assertWhenIdleBefore(body, 'collectFloorBytes()', 'withFloorAddUndo');
});

test('【不変条件】App.jsx: handleSaveConfirm は exportDocument() より前に openingStructuralSync.whenIdle() を待つ', () => {
  const appSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  const body = extractFunctionBody(appSrc, 'function handleSaveConfirm');
  assertWhenIdleBefore(body, 'exportDocument()', 'handleSaveConfirm');
});
