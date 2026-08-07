// wallBeamAxes.test.js / graphSnapshot.test.js と同じ方針: ダックタイピングでは
// coord1/coord2/effectiveValue 等の実挙動を再現できないため、実 core.js（Plane/PlanGraph）を使う。
// project は openingNumberIndex（実MobXの observable.map()）だけを持つ軽量フィクスチャで足りる
// （openingEdit.js が project から読むのは openingNumberIndex 経由の採番情報のみ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observable, runInAction, configure, autorun } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import { undoManager } from '../undoManager.js';
import { FITTING_CATALOG, defaultMaterialGlassFor } from './openingCatalog.js';
import { openingTagOf, renumberOpenings } from './openingNumbering.js';
import {
  placeOpeningWithDefaults, removeOpeningWithUndo, withOpeningUndo, pushOpeningUndo, snapshotOpening,
  materialGlassAfterFixtureChange, validateOpeningEdit,
} from './openingEdit.js';

function makePlaneGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// 長さ length(mm) の水平壁を1本持つグラフを作る（既定は外壁）。
function makeWallGraph(length = 3000, { isExteriorWall = true } = {}) {
  const graph = makePlaneGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,      { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,      { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   length, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall });
  return { graph, wall, axisCL, clStart, clEnd };
}

function makeProject() {
  return { openingNumberIndex: observable.map() };
}

// ---- Finding 1 回帰: 編集確定の前進方向でもタグが即座に反映される ----
test('withOpeningUndo で width を変更すると、undo/redoする前（確定直後）から openingTagOf が非nullになる', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 1690, OpeningCategory.WINDOW, 'doubleSliding',
    { fixtureType: 'AW', height: 1170, sillHeight: 800 });

  assert.equal(openingTagOf(opening, project), null, '収集前はまだ未確定');

  withOpeningUndo(graph, project, opening, () => {
    runInAction(() => { opening.width = 2000; });
  });

  assert.equal(openingTagOf(opening, project), 'AW-1', '確定直後（undo/redoしていない時点）でタグが反映されるはず');
});

// ---- undo/redoでタグが往復する ----
test('pushOpeningUndoが返すエントリのundo/redo双方でタグが確定する（nullに戻らない）', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 1690, OpeningCategory.WINDOW, 'doubleSliding',
    { fixtureType: 'AW', height: 1170, sillHeight: 800 });

  const before = snapshotOpening(opening);
  runInAction(() => { opening.width = 500; });
  const cmd = pushOpeningUndo(graph, project, opening, before);
  assert.ok(cmd, '差分があるので積まれるはず');

  const tagAfterEdit = openingTagOf(opening, project);
  assert.ok(tagAfterEdit, '編集直後にタグが確定している');

  cmd.undo();
  assert.ok(openingTagOf(opening, project), 'undo後もタグが確定している');

  cmd.redo();
  const tagAfterRedo = openingTagOf(opening, project);
  assert.ok(tagAfterRedo, 'redo後もタグが確定している');
  assert.equal(tagAfterRedo, tagAfterEdit, 'redoで編集直後と同じタグに戻る');
});

// ---- 失敗系: 壁長不足で幅が収まらない ----
test('【失敗系】壁長1000mmに既定の引き違い窓(幅1690mm)は収まらず、opening:null・errorは非空文字列', () => {
  const { graph, wall } = makeWallGraph(1000);
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 500, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(opening, null);
  assert.equal(typeof error, 'string');
  assert.ok(error.length > 0);
});

// ---- 失敗系: 壁外の長押し位置は壁中央へフォールバックする ----
test('【失敗系】壁範囲外の長押し位置 → 壁中央へフォールバックして配置される（error null）', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 9000, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(error, null);
  assert.ok(opening);
  const wallLo = Math.min(wall.coord1, wall.coord2), wallHi = Math.max(wall.coord1, wall.coord2);
  assert.equal(opening.centerCoord, Math.round((wallLo + wallHi) / 2));
});

// ---- 失敗系: 配置可能な建具カタログが無い壁 ----
test('【失敗系】配置可能な建具カタログが無い場合はopening:null・errorを返す', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: false });
  const project = makeProject();
  // FITTING_CATALOG を一時的に空にして「配置できる建具が無い」状態を再現する（openingCatalog.js の
  // カタログは通常どのwallKindでも1件以上あるため、この分岐は実運用では到達しない防御コード——
  // 直接テストするにはカタログを一時的に空にする以外に手段が無い）。
  const saved = FITTING_CATALOG.splice(0, FITTING_CATALOG.length);
  try {
    const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 0 }, OpeningCategory.FITTING);
    assert.equal(opening, null);
    assert.equal(typeof error, 'string');
    assert.ok(error.length > 0);
  } finally {
    FITTING_CATALOG.splice(0, 0, ...saved);
  }
});

// ---- Finding 9 回帰: CL偏芯（pendingDelta）中でも長押し位置に配置される ----
test('refCL.pendingDelta!=0（CL偏芯ドラッグ中）でも長押し位置(along)にそのまま配置される', () => {
  const { graph, wall, clStart } = makeWallGraph(3000);
  const project = makeProject();
  clStart.pendingDelta = 200; // ドラッグ中の未確定変位（refCLはwall.clStartと同一参照。壁全体も追従して200ずれる）

  // along=1500 は壁の実効範囲 [200,3000]（clStartのpendingDeltaを反映した coord1〜coord2）の
  // 内側に幅1690mmの既定窓（半幅845mm）が余裕をもって収まる位置——フォールバック（壁中央）が
  // 発火しないことを保証した上で「長押し位置に配置されたか」だけを検証する。
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(error, null);
  assert.ok(opening);
  assert.equal(opening.centerCoord, 1500, '長押し位置(along=1500)にそのまま配置されるはず（refCL.valueに引きずられない）');
});

// ---- placeOpeningWithDefaults: 新規配置時に記号既定の材料・ガラスが設定される ----
test('placeOpeningWithDefaults: 新規配置時にfixtureType既定の材料・ガラスが設定される', () => {
  const { graph, wall } = makeWallGraph(3000); // 既定は外壁 → 窓の既定記号はAW
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(error, null);
  assert.equal(opening.fixtureType, 'AW');
  assert.equal(opening.materialGlass, defaultMaterialGlassFor('AW'));
});

// ---- 材料・ガラスの記号変更時の差し替え規則 ----
test('materialGlassAfterFixtureChange: 現在値が旧記号の初期値のままなら新記号の初期値へ差し替える', () => {
  const oldSymbol = 'AW', newSymbol = 'JW';
  const current = defaultMaterialGlassFor(oldSymbol); // 「アルミ」＝未編集
  assert.equal(materialGlassAfterFixtureChange(current, oldSymbol, newSymbol), defaultMaterialGlassFor(newSymbol));
});

test('materialGlassAfterFixtureChange: ユーザーが編集済みの値は記号変更後も維持する', () => {
  const oldSymbol = 'AW', newSymbol = 'JW';
  const edited = 'アルミ（ブロンズ色）'; // 初期値「アルミ」と異なる＝編集済み
  assert.equal(materialGlassAfterFixtureChange(edited, oldSymbol, newSymbol), edited);
});

// ---- Finding 2 回帰: materialGlass未入力(null)は記号変更で新記号の初期値が入る ----
test('materialGlassAfterFixtureChange: 現在値がnull（未入力）なら新記号の初期値が入る', () => {
  const oldSymbol = 'AW', newSymbol = 'JW';
  assert.equal(materialGlassAfterFixtureChange(null, oldSymbol, newSymbol), defaultMaterialGlassFor(newSymbol));
});

// ---- Finding 1 回帰: onEditDim の幅編集ガードが依拠する validateOpeningEdit の検証 ----
// OpeningEditor.jsx の onEditDim は dim.target==='width' のとき validateOpeningEdit で
// 事前検証し、NGなら opening.width を代入せず（commitEditを呼ばず）に return する。
// このファイルの層（React未経由の純ロジック）でテストできるのは検証関数そのものの正しさまで——
// 「代入しない」はJSの早期returnで機械的に保証される制御フローのため、ここでは検証関数の
// 戻り値と、代入されていないこと（=呼び出し前後でwidthが不変）を確認する。
test('【Finding 1 回帰】validateOpeningEdit: 壁長2000mmに幅5000mmはNGを返す（onEditDimの幅編集ガード）', () => {
  const { graph, wall } = makeWallGraph(2000);
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});

  const err = validateOpeningEdit(opening, graph, { width: 5000, refOffset: opening.refOffset });
  assert.ok(err, '壁長2000mmを超える幅5000mmはNGのはず');
  assert.equal(opening.width, 800, 'validateOpeningEditは検証のみで代入しない（呼び出し側=onEditDimがガードしてwidthを据え置く前提）');
});

// ---- removeOpeningWithUndo: undoでfixtureType/sillHeight/heightが保持される ----
test('removeOpeningWithUndo: undoで削除前のfixtureType/sillHeight/heightが復元される', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 1690, OpeningCategory.WINDOW, 'doubleSliding',
    { fixtureType: 'JW', sillHeight: 700, height: 1200 });
  const id = opening.id;

  removeOpeningWithUndo(graph, project, opening);
  assert.equal(graph.shapeMap.has(id), false, '削除直後は存在しない');

  undoManager.undo();
  const restored = graph.shapeMap.get(id);
  assert.ok(restored, 'undoで復元されるはず');
  assert.equal(restored.fixtureType, 'JW');
  assert.equal(restored.sillHeight, 700);
  assert.equal(restored.height, 1200);
});

// ---- Finding A 回帰（memberGroups.test.js:218-269 の写し）: renumberOpenings 等が
// runInAction の外で project.openingNumberIndex（observable.map）を変異すると、observer監視下
// （OpeningPanelが能動的に観測している状態）でMobX強制モード違反の警告が出る。openingEdit.js の
// 公開APIはすべてrunInActionで包んで呼ぶ（本ファイル内のpushOpeningUndo/placeOpeningWithDefaults/
// removeOpeningWithUndo参照）。
test('openingEdit: observer監視下でもrunInAction越しならMobX強制モード違反を出さない', () => {
  configure({ enforceActions: 'observed' });
  // placeOpeningWithDefaults で2件目を既存開口と重ならない位置に置けるよう、壁を長めにとる。
  const { graph, wall } = makeWallGraph(8000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 1690, OpeningCategory.WINDOW, 'doubleSliding',
    { fixtureType: 'AW', height: 1170, sillHeight: 800 });

  // OpeningPanel（observer）が project.openingNumberIndex の各グループを能動的に観測し続ける状態を模す。
  const dispose = autorun(() => {
    for (const [, group] of project.openingNumberIndex) {
      void group.symbol; void group.tag; void group.no; void [...group.counts.values()];
    }
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    // 修正前の openingEdit.js（runInActionなしで renumberOpenings を直呼び）と同じ形で呼ぶと
    // 警告が出ることを確認する（修正の必要性を裏付ける）。
    renumberOpenings(graph, project);
    assert.ok(
      warnings.some(w => w.includes('[MobX]')),
      'runInActionに包まないとobserver監視下でMobX強制モード違反の警告が出るはず',
    );
    warnings.length = 0;

    // 実際の公開API（すべてrunInActionで包んでいる）を一通り呼ぶ。
    withOpeningUndo(graph, project, opening, () => { runInAction(() => { opening.width = 2000; }); });
    // 既存開口（centerCoord=1000近辺）と重ならない位置（x=6000）に2件目を配置する。
    const { opening: placed, error: placeErr } = placeOpeningWithDefaults(graph, project, wall, { x: 6000, y: 0 }, OpeningCategory.WINDOW);
    assert.equal(placeErr, null);
    removeOpeningWithUndo(graph, project, placed);
  } finally {
    console.warn = originalWarn;
    dispose();
  }

  const mobxWarnings = warnings.filter(w => w.includes('[MobX]'));
  assert.deepEqual(mobxWarnings, [], 'runInActionで包めばobserver監視下でも強制モード違反が出ないはず');
});

// ---- Finding B 回帰: OpeningEditor.jsx の textField は保存値もtrimするため、前後空白だけが
// 違う入力は同一バリアントになる（枝番が付かない）。コンポーネント描画のテスト環境が
// このリポジトリに無いため、textField と同一の変換（trim→空ならnull）をここで再現し、
// その変換を経た2件が同一signature・同一タグ（枝番なし）に収束することを確認する。
function textFieldTransform(raw) {
  const t = raw.trim();
  return t === '' ? null : t;
}

test('【Finding B 回帰】textFieldのtrim変換を経れば前後空白だけが違う入力は同一バリアントになる（枝番なし）', () => {
  const { graph, wall } = makeWallGraph(8000);
  const project = makeProject();
  const openingA = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 1690, OpeningCategory.WINDOW, 'doubleSliding',
    { fixtureType: 'AW', height: 1170, sillHeight: 800, materialGlass: textFieldTransform('AEP') });
  const openingB = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 6000, 1690, OpeningCategory.WINDOW, 'doubleSliding',
    { fixtureType: 'AW', height: 1170, sillHeight: 800, materialGlass: textFieldTransform('  AEP  ') });

  assert.equal(openingA.materialGlass, 'AEP');
  assert.equal(openingB.materialGlass, 'AEP', 'trim変換により前後空白は除去されるはず');

  renumberOpenings(graph, project);
  assert.equal(openingTagOf(openingA, project), 'AW-1', '枝番なしの単一バリアントになるはず');
  assert.equal(openingTagOf(openingB, project), 'AW-1');
});
