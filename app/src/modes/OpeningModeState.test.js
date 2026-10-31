// modes/OpeningModeState.js の init()（ステップ10e・建具種別=openingSubTypeの未解決検出。
// 裁定Q-A: 検出は建具モード突入時）の単体テスト。StructuralModeState.test.js（ステップ8g・
// 断面=sectionの未解決検出）と同型のProject/addPlaneフィクスチャを使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningModeState } from './OpeningModeState.js';
import { Project, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import {
  applyDocumentCodeNormalization, takeUnresolvedCodes, addDocumentAliases, clearDocumentAliases,
} from '../catalog/codeNormalization.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { replaceRowsByScenario, defaultResolveDecision } from '../catalog/resolveQueue.js';
import { ERR_DETAIL_FIT_FAILED } from '../error.js';
import { jambFigure, materialBoundFigure, uniqueSymbolKey, installFrameSymbol } from '../openings/openingDetailTestFixtures.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';

// 長さ3000mmの水平壁を1本graphへ追加する（openingEdit.test.jsのmakeWallGraphと同型）。
function addWallTo(graph, length = 3000) {
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,      { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,      { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   length, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  return { wall, axisCL, clStart, clEnd };
}

// 壁1本を持つ1階グラフを作る（project.planes/activePlaneIdの走査経路=_missingOpeningUsageを
// 検証するためProjectを実際に生成する——StructuralModeState.test.js.makeGraphと同じ方針）。
function makeGraph() {
  const project = new Project('proj-opening-mode-init', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const { wall } = addWallTo(graph);
  return { project, graph, wall };
}

test('init: 既知のsubTypeだけの開口は場面(b)unresolved-codeの行を作らない。materialErrorに相当するブロッキングエラーも無い', async () => {
  const { project, graph, wall } = makeGraph();
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.FITTING, 'singleSwing', {});

  const s = new OpeningModeState(graph, project);
  const result = await s.init();

  assert.equal(result.ok, true);
  assert.deepEqual(result.catalogResolveRows, []);
  assert.deepEqual(s.catalogResolveRows, []);
});

test('init: 未知のsubTypeを持つ開口が複数ある場合、場面(b)unresolved-codeの行が1件にまとまり、usageは開口の件数分になる（件数は生グラフ走査で出す）', async () => {
  const { project, graph, wall } = makeGraph();
  const o1 = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500,  800, OpeningCategory.FITTING, 'zzUnknown', {});
  const o2 = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 2000, 800, OpeningCategory.FITTING, 'zzUnknown', {});

  const s = new OpeningModeState(graph, project);
  const result = await s.init();

  assert.equal(result.ok, true, '未解決があってもokはtrue（既定フォールバックで図面は止まらない契約）');
  assert.equal(result.catalogResolveRows.length, 1, '同じcodeは1行にまとまる（buildResolveRowsの契約）');
  const [row] = result.catalogResolveRows;
  assert.equal(row.kind, CatalogKind.OPENING_SUB_TYPE);
  assert.equal(row.scenario, 'unresolved-code');
  assert.equal(row.targetKey, 'fitting:zzUnknown');
  assert.equal(row.usage.length, 2, '同じcodeの建具が2件あればusageに両方が入る（peekUnresolvedCodesの重複排除には頼らない）');
  const openingIds = row.usage.map(u => u.openingId).sort();
  assert.deepEqual(openingIds, [o1.id, o2.id].sort());
  assert.ok(row.usage.every(u => u.location === 'opening'));
  assert.equal(s.catalogResolveRows, result.catalogResolveRows, 'this.catalogResolveRowsにも戻り値と同じ配列が反映される');
});

test('init: 全て既知のsubTypeなら行が立たず、他kind（material）の既存行はkindsスコープで残る（変異: kindsを外すとこのテストだけ赤）', async () => {
  const { project, graph, wall } = makeGraph();
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.WINDOW, 'doubleSliding', {});

  const s = new OpeningModeState(graph, project);
  const { catalogResolveRows } = await s.init();
  assert.deepEqual(catalogResolveRows, []);

  // App.jsxのモードロード後マージ（replaceRowsByScenario）と同じ呼び出し形。
  const materialRow = { id: 'unresolved-code:material:111111111211', scenario: 'unresolved-code', kind: 'material' };
  const merged = replaceRowsByScenario([materialRow], catalogResolveRows, ['unresolved-code'], { kinds: s.catalogResolveKinds });
  assert.ok(merged.includes(materialRow), 'kinds=[openingSubType, fixtureSymbol]のときmaterial行は場面が同じでも残る');
  assert.deepEqual(s.catalogResolveKinds, [CatalogKind.OPENING_SUB_TYPE, CatalogKind.FIXTURE_SYMBOL]);
});

test('【失敗系】init: overlayにユーザーエントリを追加したsubTypeは未解決にならない（composeCatalog経由の証明）', async () => {
  const { project, graph, wall } = makeGraph();
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.FITTING, 'myDoor', {});
  try {
    setOverlay(CatalogKind.OPENING_SUB_TYPE, {
      user: [{ category: 'fitting', key: 'myDoor', label: '独自ドア', mechanism: 'swing', defaultWidth: 800, defaultHeight: 2000 }],
    });

    const s = new OpeningModeState(graph, project);
    const { catalogResolveRows } = await s.init();

    assert.deepEqual(catalogResolveRows, [], 'overlay（ユーザー追加）に載っているsubTypeは未解決にならない');
  } finally {
    clearOverlays();
  }
});

test('【失敗系】init: peekUnresolvedCodes()にreason:"category-mismatch"がある場合、table.get()の解決先が実在キーでも行に残る（変異: 無条件残しを外すと消える）', async () => {
  const { project, graph } = makeGraph(); // 自階には該当する開口が無い（他所で蓄積された未解決の合流だけを見る）
  try {
    // 文書固有のalias（1件）: fitting:oldDoor → window:doubleSliding（実在キー・カテゴリが違う）。
    addDocumentAliases(CatalogKind.OPENING_SUB_TYPE, [{ from: 'fitting:oldDoor', to: 'window:doubleSliding' }]);
    // 他階のデコード時に蓄積されたのと同じ経路（applyDocumentCodeNormalization）で
    // reason:'category-mismatch'の未解決を1件積む（codeNormalization.js normalizeOpenings参照）。
    applyDocumentCodeNormalization({ openings: [{ id: 'other-floor-opening', category: 'fitting', subType: 'oldDoor' }] });

    const s = new OpeningModeState(graph, project);
    const { catalogResolveRows } = await s.init();

    assert.equal(catalogResolveRows.length, 1, 'window:doubleSlidingは実在するが、category-mismatchは無条件で残る');
    assert.equal(catalogResolveRows[0].targetKey, 'fitting:oldDoor');
    assert.equal(catalogResolveRows[0].usage[0].location, 'opening');
    assert.equal(catalogResolveRows[0].usage[0].openingId, 'other-floor-opening');
  } finally {
    takeUnresolvedCodes(); // 蓄積をリセットし、他テストへ漏らさない
    clearDocumentAliases(); // documentAliasesByKind['openingSubType']をリセットし、他テストへ漏らさない
  }
});

test('【失敗系】init: 未知のsubTypeがあっても例外を投げない（StructuralModeState.test.jsと同じ契約。描画側はnullフォールバック）', async () => {
  const { project, graph, wall } = makeGraph();
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.FITTING, 'zzUnknown', {});

  const s = new OpeningModeState(graph, project);
  await assert.doesNotReject(() => s.init());
});

// ---- QA指摘Major-1（ステップ10e）: 他階のpeekが失敗してもinit()全体をrejectしない ----
test('【失敗系・QA指摘Major-1】init: 他階のpeekが失敗しても例外を投げず、読めた階（自階）の行だけ返す', async () => {
  const { project, graph, wall } = makeGraph();
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.FITTING, 'zzUnknown', {});
  project.addPlane(3000, '2階', 'p2'); // 他階（peekが失敗する想定。中身は使わない）

  const origPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => { throw new Error('peek失敗（テスト）'); };
  try {
    const s = new OpeningModeState(graph, project);
    let result;
    await assert.doesNotReject(async () => { result = await s.init(); });
    assert.equal(result.ok, true);
    assert.equal(result.catalogResolveRows.length, 1, '他階が全滅しても自階の未知subType行は失われない');
    assert.equal(result.catalogResolveRows[0].targetKey, 'fitting:zzUnknown');
    assert.equal(result.catalogResolveRows[0].usage.length, 1);
  } finally {
    floorSwapManager.peek = origPeek;
  }
});

// ---- QA指摘Major-2（ステップ10e）: 非アクティブ階（floorSwapManager.peek経由）の未知subTypeも
// 行になる。peekスタブは本番同型（structuralResolveContext.test.jsの先例＝new PlanGraph→
// restoreGraph(g, serializeGraph(src))の往復）。変異: _missingOpeningUsageのpeek走査ループを
// 削除する（scan(this.graph)だけにする）→このテストだけ赤になることを確認済み ----
test('【QA指摘Major-2】init: 非アクティブ階（floorSwapManager.peek）の未知subTypeも行になる', async () => {
  const project = new Project('proj-opening-mode-multi', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1'); // active。開口無し
  const { plane: plane2, graph: g2 } = project.addPlane(3000, '2階', 'p2'); // 非active
  const { wall: wall2 } = addWallTo(g2);
  const o2 = g2.addOpening(wall2.axisCL, 1, false, wall2.clStart, 500, 800, OpeningCategory.FITTING, 'zzUnknown', {});

  const store = new Map();
  store.set(plane2.id, serializeGraph(g2));

  const origPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane, structGraph) => {
    const g = new PlanGraph(plane);
    g._structGraph = structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
  try {
    const s = new OpeningModeState(g1, project);
    const { catalogResolveRows } = await s.init();

    assert.equal(catalogResolveRows.length, 1, '2階（非アクティブ）の未知subTypeも1行になる');
    assert.equal(catalogResolveRows[0].targetKey, 'fitting:zzUnknown');
    assert.equal(catalogResolveRows[0].usage.length, 1);
    assert.equal(catalogResolveRows[0].usage[0].openingId, o2.id);
  } finally {
    floorSwapManager.peek = origPeek;
  }
});

// ---- QA指摘Major-3（ステップ10e）: 生走査（missingUsage）とpeek合流（stillUnresolved）の
// 両方に同じ開口が現れても二重計上しない ----
test('【失敗系・QA指摘Major-3】init: 同じ開口がpeekUnresolvedCodesにも載る場合でも、usageは開口の実数と一致する（重複計上しない）', async () => {
  const { project, graph, wall } = makeGraph();
  const o = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.FITTING, 'oldDoor', {});
  try {
    // 文書固有のalias: fitting:oldDoor → window:doubleSliding（実在キー・カテゴリが違うため
    // codeNormalization.js normalizeOpeningsはcategory-mismatchとして据え置き＋unresolvedへ積む）。
    addDocumentAliases(CatalogKind.OPENING_SUB_TYPE, [{ from: 'fitting:oldDoor', to: 'window:doubleSliding' }]);
    // 文書読込み時に自階の開口がデコードされたのと同じ経路（applyDocumentCodeNormalization）で、
    // 今もgraph.openingsに生きている同じopeningId（o.id）をpeekUnresolvedCodesへ積む。
    applyDocumentCodeNormalization({ openings: [{ id: o.id, category: 'fitting', subType: 'oldDoor' }] });

    const s = new OpeningModeState(graph, project);
    const { catalogResolveRows } = await s.init();

    assert.equal(catalogResolveRows.length, 1);
    assert.equal(catalogResolveRows[0].targetKey, 'fitting:oldDoor');
    assert.equal(catalogResolveRows[0].usage.length, 1, '生走査（missingUsage）とpeek合流（stillUnresolved）の両方に同じ開口があっても1件にする');
    assert.equal(catalogResolveRows[0].usage[0].openingId, o.id);
  } finally {
    takeUnresolvedCodes();
    clearDocumentAliases();
  }
});

// ---- ステップ12d: 建具記号（fixtureSymbol）の未解決検出（openingSubTypeと同じ境界）----
test('init: 既知のfixtureType（AW）だけの開口は場面(b)unresolved-codeの行を作らない', async () => {
  const { project, graph, wall } = makeGraph();
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.WINDOW, 'doubleSliding', { fixtureType: 'AW' });

  const s = new OpeningModeState(graph, project);
  const { catalogResolveRows } = await s.init();
  assert.deepEqual(catalogResolveRows, []);
});

test('init: 未知のfixtureTypeを持つ開口はCatalogKind.FIXTURE_SYMBOLの場面(b)unresolved-code行になる（openingSubTypeの行と共存する）', async () => {
  const { project, graph, wall } = makeGraph();
  const o1 = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500,  800, OpeningCategory.FITTING, 'zzUnknown', { fixtureType: 'ZZ' });
  const o2 = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 2000, 800, OpeningCategory.FITTING, 'zzUnknown', { fixtureType: 'ZZ' });

  const s = new OpeningModeState(graph, project);
  const { catalogResolveRows } = await s.init();

  assert.equal(catalogResolveRows.length, 2, 'openingSubType（fitting:zzUnknown）とfixtureSymbol（ZZ）の2行が別々に立つ');
  const subTypeRow = catalogResolveRows.find(r => r.kind === CatalogKind.OPENING_SUB_TYPE);
  const fixtureRow = catalogResolveRows.find(r => r.kind === CatalogKind.FIXTURE_SYMBOL);
  assert.ok(subTypeRow && fixtureRow, '2種別とも行が見つかる');
  assert.equal(fixtureRow.targetKey, 'ZZ');
  assert.equal(fixtureRow.usage.length, 2, '同じfixtureTypeの建具が2件あればusageに両方が入る');
  const openingIds = fixtureRow.usage.map(u => u.openingId).sort();
  assert.deepEqual(openingIds, [o1.id, o2.id].sort());
});

test('init: fixtureType未設定（null）の開口はCatalogKind.FIXTURE_SYMBOLの行を作らない（カテゴリ既定へフォールバックする契約のため対象外）', async () => {
  const { project, graph, wall } = makeGraph();
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.WINDOW, 'doubleSliding', {});

  const s = new OpeningModeState(graph, project);
  const { catalogResolveRows } = await s.init();
  assert.deepEqual(catalogResolveRows.filter(r => r.kind === CatalogKind.FIXTURE_SYMBOL), []);
});

test('【失敗系】init: overlayにユーザーエントリを追加したfixtureSymbolは未解決にならない（composeCatalog経由の証明）', async () => {
  const { project, graph, wall } = makeGraph();
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.WINDOW, 'doubleSliding', { fixtureType: 'PW' });
  try {
    setOverlay(CatalogKind.FIXTURE_SYMBOL, {
      user: [{ key: 'PW', label: 'PW（樹脂サッシ・独自）', category: 'window' }],
    });

    const s = new OpeningModeState(graph, project);
    const { catalogResolveRows } = await s.init();

    assert.deepEqual(catalogResolveRows.filter(r => r.kind === CatalogKind.FIXTURE_SYMBOL), [], 'overlay（ユーザー追加）に載っているfixtureTypeは未解決にならない');
  } finally {
    clearOverlays();
  }
});

// ---- 部分詳細図 S3: 三方枠の詳細図が寸法に合わせられないときの通知（場面 detail-fit-failed）----
test('init: 三方枠の詳細図が合わせられない記号は場面 detail-fit-failed の行を1行作る（候補なし・許可操作は defer だけ）', async () => {
  const { project, graph, wall } = makeGraph();
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { jamb: materialBoundFigure('df-mode-1') });
  try {
    graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: sym });

    const s = new OpeningModeState(graph, project);
    const { catalogResolveRows } = await s.init();

    const rows = catalogResolveRows.filter(r => r.scenario === 'detail-fit-failed');
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.kind, CatalogKind.FIXTURE_SYMBOL);
    assert.equal(row.targetKey, sym);
    assert.equal(row.targetLabel, '材束縛の方立');
    assert.deepEqual(row.candidates, []);
    assert.deepEqual(row.allowedActions, ['defer']);
    assert.ok(row.message.startsWith(ERR_DETAIL_FIT_FAILED('材束縛の方立', sym, '', 'jamb')), row.message);
    assert.match(row.message, new RegExp(`^詳細図 材束縛の方立 を ${sym} の方立に合わせられません: `));
    assert.deepEqual(defaultResolveDecision(row), { action: 'defer', pick: null });
    assert.equal(s.catalogResolveRows, catalogResolveRows);
    assert.equal(catalogResolveRows.filter(r => r.scenario === 'unresolved-code').length, 0, '記号自体は実在するので未解決の行は立たない');
  } finally {
    clearOverlays();
  }
});

test('init: 同じ（図のキー・slot・壁厚・出幅・見付）の三方枠が複数あっても detail-fit-failed の行は1行。出幅を変えたものは別の行', async () => {
  const { project, graph, wall } = makeGraph();
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { jamb: materialBoundFigure('df-mode-2') });
  try {
    graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: sym });
    graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1500, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: sym });
    let s = new OpeningModeState(graph, project);
    let rows = (await s.init()).catalogResolveRows.filter(r => r.scenario === 'detail-fit-failed');
    assert.equal(rows.length, 1, '同じ組は重複しない');

    graph.addOpening(wall.axisCL, 1, false, wall.clStart, 2500, 400, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: sym, frameProjection: 30 });
    s = new OpeningModeState(graph, project);
    rows = (await s.init()).catalogResolveRows.filter(r => r.scenario === 'detail-fit-failed');
    assert.equal(rows.length, 2, '出幅が違えば別の組（幅 400 なので見付の頭打ちも別）');
    assert.equal(new Set(rows.map(r => r.id)).size, 2, '行 id は一意');
  } finally {
    clearOverlays();
  }
});

test('【失敗系】init: 詳細図が合わせられる記号・割当て無しの記号・三方枠でない建具は detail-fit-failed の行を作らない', async () => {
  const { project, graph, wall } = makeGraph();
  const ok = uniqueSymbolKey();
  installFrameSymbol(ok, { jamb: jambFigure('df-mode-ok') });
  try {
    graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: ok });
    graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1500, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: 'WF' });
    graph.addOpening(wall.axisCL, 1, false, wall.clStart, 2500, 800, OpeningCategory.FITTING, 'singleSwing', { fixtureType: ok });
    const s = new OpeningModeState(graph, project);
    const { catalogResolveRows } = await s.init();
    assert.deepEqual(catalogResolveRows.filter(r => r.scenario === 'detail-fit-failed'), []);
  } finally {
    clearOverlays();
  }
});

test('init: 非アクティブ階（peek）の三方枠も詳細図の検査対象で、階をまたいで同じ組は1行にまとまる', async () => {
  const project = new Project('proj-opening-mode-detail-multi', 'test');
  const { graph: g1 } = project.addPlane(0, '1階', 'p1');
  const { plane: plane2, graph: g2 } = project.addPlane(3000, '2階', 'p2');
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { jamb: materialBoundFigure('df-mode-multi') });
  const w1 = addWallTo(g1).wall;
  const w2 = addWallTo(g2).wall;
  g1.addOpening(w1.axisCL, 1, false, w1.clStart, 500, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: sym });
  g2.addOpening(w2.axisCL, 1, false, w2.clStart, 500, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: sym });
  const store = new Map([[plane2.id, serializeGraph(g2)]]);
  const origPeek = floorSwapManager.peek;
  floorSwapManager.peek = async (plane, structGraph) => {
    const g = new PlanGraph(plane);
    g._structGraph = structGraph;
    const bytes = store.get(plane.id);
    if (bytes) restoreGraph(g, bytes);
    return g;
  };
  try {
    const s = new OpeningModeState(g1, project);
    const rows = (await s.init()).catalogResolveRows.filter(r => r.scenario === 'detail-fit-failed');
    assert.equal(rows.length, 1, '1階と2階で同じ（記号・壁厚・出幅・見付）は1行');
    // 2階だけに出幅違いの三方枠を足すと、peek した階の分が別の行として増える
    g2.addOpening(w2.axisCL, 1, false, w2.clStart, 1800, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: sym, frameProjection: 30 });
    store.set(plane2.id, serializeGraph(g2));
    const s2 = new OpeningModeState(g1, project);
    const rows2 = (await s2.init()).catalogResolveRows.filter(r => r.scenario === 'detail-fit-failed');
    assert.equal(rows2.length, 2, '非アクティブ階の組も集計される');
  } finally {
    floorSwapManager.peek = origPeek;
    clearOverlays();
  }
});

test('init: detail-fit-failed の行は App.jsx のマージ（場面 unresolved-code・detail-fit-failed×自分の kinds）で再突入時に置き換わり、他種別の行は残る', async () => {
  const { project, graph, wall } = makeGraph();
  const sym = uniqueSymbolKey();
  installFrameSymbol(sym, { jamb: materialBoundFigure('df-mode-3') });
  try {
    graph.addOpening(wall.axisCL, 1, false, wall.clStart, 500, 800, OpeningCategory.FITTING, 'threeSidedFrame', { fixtureType: sym });
    const s = new OpeningModeState(graph, project);
    const { catalogResolveRows } = await s.init();
    const materialRow = { id: 'detail-fit-failed:material:x', scenario: 'detail-fit-failed', kind: 'material' };
    const merged1 = replaceRowsByScenario([materialRow], catalogResolveRows, ['unresolved-code', 'detail-fit-failed'], { kinds: s.catalogResolveKinds });
    const merged2 = replaceRowsByScenario(merged1, catalogResolveRows, ['unresolved-code', 'detail-fit-failed'], { kinds: s.catalogResolveKinds });
    assert.equal(merged2.filter(r => r.scenario === 'detail-fit-failed' && r.kind === CatalogKind.FIXTURE_SYMBOL).length, 1, '再突入で積み増さない');
    assert.ok(merged2.includes(materialRow), '他種別の行は残る');
  } finally {
    clearOverlays();
  }
});
