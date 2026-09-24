// wallBeamAxes.test.js / graphSnapshot.test.js と同じ方針: ダックタイピングでは
// coord1/coord2/effectiveValue 等の実挙動を再現できないため、実 core.js（Plane/PlanGraph）を使う。
// project は openingNumberIndex（実MobXの observable.map()）だけを持つ軽量フィクスチャで足りる
// （openingEdit.js が project から読むのは openingNumberIndex 経由の採番情報のみ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observable, runInAction, configure, autorun } from 'mobx';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import { undoManager } from '../undoManager.js';
import { FITTING_CATALOG, WINDOW_CATALOG, findCatalogEntry, defaultMaterialGlassFor, getFixtureSymbols, OpeningMechanism } from './openingCatalog.js';
import { ERR_OPENING_OUT_OF_WALL, ERR_OPENING_OVERLAP } from '../error.js';
import { openingTagOf, renumberOpenings } from './openingNumbering.js';
import { openingTagAnchor } from './openingTagPlacement.js';
import {
  placeOpeningWithDefaults, removeOpeningWithUndo, withOpeningUndo, pushOpeningUndo, snapshotOpening,
  materialGlassAfterFixtureChange, validateOpeningEdit, noteAfterSubTypeChange, openDirForMechanism,
  defaultSwingSideFor, swingSideAfterSubTypeChange, flippedHingeSides, flippedSwingSide,
  fixtureTypeAfterSubTypeChange, fixtureSymbolOptions, resolveRefOffsetEdit, setOpeningGeometryListener,
  beginOpeningFieldUndo, endOpeningFieldUndo,
} from './openingEdit.js';
import { closedAngleFor, leafOpenAngle, angleVectors } from './openingPlanSymbolGeometry.js';

function makePlaneGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// 長さ length(mm) の水平壁を1本持つグラフを作る（既定は外壁）。
function makeWallGraph(length = 3000, { isExteriorWall = true, axisOffset = 75 } = {}) {
  const graph = makePlaneGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,      { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,      { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   length, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, axisOffset, false, clStart, 0, clEnd, 0, { isExteriorWall });
  return { graph, wall, axisCL, clStart, clEnd };
}

// 長さ length(mm) の垂直壁を1本持つグラフを作る（既定は内壁）。
function makeVerticalWallGraph(length = 3000, { isExteriorWall = false, axisOffset = 75 } = {}) {
  const graph = makePlaneGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.VERTICAL,   0,      { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,      { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.HORIZONTAL, length, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, axisOffset, true, clStart, 0, clEnd, 0, { isExteriorWall });
  return { graph, wall, axisCL, clStart, clEnd };
}

function makeProject() {
  return { openingNumberIndex: observable.map() };
}

// 開き戸(SWING)の記号丸アンカー（openingTagAnchor）の perp成分から、扉が実際に開いている側
// （±1）を独立に読み取る。placeOpeningWithDefaults が保存した swingSide の算出式
// （openingGeometry.js swingSideTowardPerp）とは別経路（openingTagPlacement.js swingGeometry）の
// 計算のため、配置時の swingSide 決定が「意図した側に扉が実際に開くか」を裏付けるクロスチェックになる。
function doorOpenSidePerp(opening, wall, graph) {
  const anchor = openingTagAnchor(opening, wall, graph, { radiusMm: 100, gapMm: 20 });
  const perp = wall.isVertical ? anchor.x : anchor.y;
  return Math.sign(perp - wall.axisValue);
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

// ---- QA指摘3: handleHeight が EDITABLE から脱落していないことの回帰テスト（undo/redo往復） ----
test('withOpeningUndo で handleHeight を変更すると undo/redo で値が正しく往復する（EDITABLE脱落検知ガード）', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: false });
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  assert.equal(opening.handleHeight, null, '既定は未設定(null)');

  const before = snapshotOpening(opening);
  runInAction(() => { opening.handleHeight = 900; });
  const cmd = pushOpeningUndo(graph, project, opening, before);
  assert.ok(cmd, '差分があるので積まれるはず（handleHeightがEDITABLEに含まれていないとbefore===afterでnullになる）');
  assert.equal(opening.handleHeight, 900);

  cmd.undo();
  assert.equal(opening.handleHeight, null, 'undoで未設定に戻る');

  cmd.redo();
  assert.equal(opening.handleHeight, 900, 'redoで再び900に戻る');
});

// ---- 壁長不足: 既定間口を壁長へクランプして配置する（エラーにしない） ----
test('壁長1000mmに既定の引き違い窓(幅1690mm)は壁長1000mmへクランプされて配置される（error null）', () => {
  const { graph, wall } = makeWallGraph(1000);
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 500, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(error, null);
  assert.ok(opening);
  assert.equal(opening.width, 1000, '既定幅1690mmは壁長1000mmへクランプされるはず');
});

// ---- QA回帰（Finding 1）: 奇数スパンの壁でも中心座標の丸めズレでエラーにならない ----
// 壁長1365mm（奇数）だと中央フォールバックの refOffset = Math.round(682.5) = 683 で中心が
// 0.5mmずれる。幅を先に壁長だけでクランプする実装ではこのズレにより coord2>hi でNGになった
// （修正前の実バグ）。中心確定後に maxOpeningWidthAt で幅を決めることで解消することを確認する。
test('【QA回帰】壁長1365mm（奇数スパン）でも既定の引き違い窓(幅1690mm)がクランプされて配置される（error null）', () => {
  const { graph, wall } = makeWallGraph(1365);
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 700, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(error, null);
  assert.ok(opening);
  assert.equal(opening.width, 1364, '中心683・半幅682で1364にクランプされるはず');
  assert.ok(opening.coord1 >= 0 && opening.coord2 <= 1365, '恒久ガード: 配置結果は必ず壁範囲[0,1365]に収まる');
});

// ---- QA回帰（Finding 2）: スパン0の縮退壁は幅0クランプ後に別途弾く（配置成功への後退を防ぐ） ----
test('【QA回帰】スパン0（縮退）の壁はopening:null・error===ERR_OPENING_OUT_OF_WALLを返す', () => {
  const { graph, wall } = makeWallGraph(0);
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 0, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(opening, null);
  assert.equal(error, ERR_OPENING_OUT_OF_WALL);
});

// ---- QA回帰（Finding 3の恒久ガード）: 壁全体が既存開口で埋まっている場合はERR_OPENING_OVERLAP ----
test('【QA回帰】壁全体が既存開口で埋まっている場合、opening:null・error===ERR_OPENING_OVERLAPを返す', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  // 壁3000mm全体(coord1=0,coord2=3000)を占有する既存開口を1件置く。
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1500, 3000, OpeningCategory.WINDOW, 'doubleSliding', {});
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(opening, null);
  assert.equal(error, ERR_OPENING_OVERLAP);
});

// ---- QA最終ラウンド Finding A: 壁中央でちょうど接する2開口に埋まった壁はOUT_OF_WALLでなくOVERLAP ----
// 幅0クランプ後のcoord1===coord2===1500は、隣接2開口(0..1500, 1500..3000)いずれとも厳密比較の
// 重なり判定(coord1<o.coord2 && coord2>o.coord1)を素通りしてしまう（境界がちょうど接する点のため）。
// 実態は「開口で埋まっている」ので、幅0ガードは壁上の既存開口の有無でエラーメッセージを選ぶ。
test('【失敗系】placeOpeningWithDefaults: 壁中央で接する2開口で埋まっている壁はERR_OPENING_OVERLAPを返す', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 750,  1500, OpeningCategory.WINDOW, 'doubleSliding', {}); // coord1=0,coord2=1500
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 2250, 1500, OpeningCategory.WINDOW, 'doubleSliding', {}); // coord1=1500,coord2=3000
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(opening, null);
  assert.equal(error, ERR_OPENING_OVERLAP, '幅0クランプ後coord1===coord2===1500は厳密比較の重なり判定を素通りするが、実態は開口で埋まっているのでOVERLAPのはず');
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
  // 注意（ステップ10c）: FITTING_CATALOG/WINDOW_CATALOG の直接変更は openingSubTypeList/getFittingOptions
  // （非メモ化）にのみ反映され、findCatalogEntry（overlay 世代キーでメモ化）には追従しない。この窓の中で
  // findCatalogEntry の戻り値に依存するアサーションを書かないこと。
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

// ---- swingSideの既定値: 壁が面する側(faceDir)へ開く（内壁・水平） ----
// QA指摘（材側許容の追加に伴う仕様の言い換え）: 壁ラジアルのヒット域には材側へのわずかな許容
// （WALL_LINE_INWARD_PX）があるため、押下点(worldPos)の直交成分の符号ではなく、ヒットした壁
// 自身が面する向き（faceDir）で開き方向が決まらなければならない——押下点の符号に依存すると、
// 材側許容域を押したときに逆に開いてしまう（前回QA指摘の再発）。壁A(faceDir=+1)・壁B(faceDir=-1)
// それぞれで、部屋側/材側どちらを押しても各壁のfaceDirどおりに開くことを確認する。
test('placeOpeningWithDefaults: 内壁（水平）は壁が面する側(faceDir)へ扉が開く（押下点の直交成分に依存しない）', () => {
  const { graph: graphA, wall: wallA } = makeWallGraph(3000, { isExteriorWall: false, axisOffset: 75 }); // faceDir=+1
  const projectA = makeProject();
  const roomSideA = placeOpeningWithDefaults(graphA, projectA, wallA, { x: 500, y: 500 }, OpeningCategory.FITTING);
  assert.equal(roomSideA.error, null);
  assert.equal(roomSideA.opening.subType, 'singleSwing', '内壁のFITTING既定はSWING機構(singleSwing)のはず');
  assert.equal(doorOpenSidePerp(roomSideA.opening, wallA, graphA), 1, '部屋側(y=500)を押してもfaceDir(+1)へ開くはず');

  const { graph: graphA2, wall: wallA2 } = makeWallGraph(3000, { isExteriorWall: false, axisOffset: 75 });
  const projectA2 = makeProject();
  const materialSideA = placeOpeningWithDefaults(graphA2, projectA2, wallA2, { x: 2000, y: 74 }, OpeningCategory.FITTING);
  assert.equal(materialSideA.error, null);
  assert.equal(doorOpenSidePerp(materialSideA.opening, wallA2, graphA2), 1, '材側許容域(y=74<axisValue=75)を押してもfaceDir(+1)へ開くはず（touchDirには依存しない）');

  const { graph: graphB, wall: wallB } = makeWallGraph(3000, { isExteriorWall: false, axisOffset: -75 }); // faceDir=-1
  const projectB = makeProject();
  const roomSideB = placeOpeningWithDefaults(graphB, projectB, wallB, { x: 500, y: -500 }, OpeningCategory.FITTING);
  assert.equal(roomSideB.error, null);
  assert.equal(doorOpenSidePerp(roomSideB.opening, wallB, graphB), -1, '壁Bは部屋側を押してもfaceDir(-1)へ開くはず');
});

// ---- swingSideの既定値: 壁が面する側(faceDir)へ開く（内壁・垂直） ----
test('placeOpeningWithDefaults: 内壁（垂直）は壁が面する側(faceDir)へ扉が開く（押下点の直交成分に依存しない）', () => {
  const { graph: graphA, wall: wallA } = makeVerticalWallGraph(3000, { axisOffset: 75 }); // faceDir=+1
  const projectA = makeProject();
  const roomSideA = placeOpeningWithDefaults(graphA, projectA, wallA, { x: 500, y: 500 }, OpeningCategory.FITTING);
  assert.equal(roomSideA.error, null);
  assert.equal(doorOpenSidePerp(roomSideA.opening, wallA, graphA), 1, '部屋側(x=500)を押してもfaceDir(+1)へ開くはず');

  const { graph: graphA2, wall: wallA2 } = makeVerticalWallGraph(3000, { axisOffset: 75 });
  const projectA2 = makeProject();
  const materialSideA = placeOpeningWithDefaults(graphA2, projectA2, wallA2, { x: 74, y: 2000 }, OpeningCategory.FITTING);
  assert.equal(materialSideA.error, null);
  assert.equal(doorOpenSidePerp(materialSideA.opening, wallA2, graphA2), 1, '材側許容域(x=74<axisValue=75)を押してもfaceDir(+1)へ開くはず（touchDirには依存しない）');

  const { graph: graphB, wall: wallB } = makeVerticalWallGraph(3000, { axisOffset: -75 }); // faceDir=-1
  const projectB = makeProject();
  const roomSideB = placeOpeningWithDefaults(graphB, projectB, wallB, { x: -500, y: 2000 }, OpeningCategory.FITTING);
  assert.equal(roomSideB.error, null);
  assert.equal(doorOpenSidePerp(roomSideB.opening, wallB, graphB), -1, '壁Bは部屋側を押してもfaceDir(-1)へ開くはず');
});

// ---- swingSideの既定値: 外壁は触れた側によらず常に外開き ----
// QA指摘（前タスク未対応分）: 従来は「2つのswingSideが等しい」ことしか見ておらず「室外側である」ことを
// 検証していなかった。doorOpenSidePerp（openingTagAnchorを使った独立経路）で実際に開く側を確認する。
test('placeOpeningWithDefaults: 外壁は触れた側(worldPos)によらず常に室外側へ開く', () => {
  const { graph: graphA, wall: wallA } = makeWallGraph(3000, { isExteriorWall: true }); // axisValue=75
  const projectA = makeProject();
  const touchedInside  = placeOpeningWithDefaults(graphA, projectA, wallA, { x: 500, y: -500 }, OpeningCategory.FITTING);

  const { graph: graphB, wall: wallB } = makeWallGraph(3000, { isExteriorWall: true });
  const projectB = makeProject();
  const touchedOutside = placeOpeningWithDefaults(graphB, projectB, wallB, { x: 500, y: 500 }, OpeningCategory.FITTING);

  assert.equal(touchedInside.error, null);
  assert.equal(touchedOutside.error, null);
  assert.equal(touchedInside.opening.subType, 'sliding', '外壁のFITTING既定は引き戸(sliding、非SWING)のはず');

  // 既定(sliding)はSWINGでなくswingSideが記号丸の実位置(openingTagAnchor)に反映されないため、
  // SWING機構(door)へ変えてから doorOpenSidePerp で測る（種別変更後も配置時のswingSideは保持される仕様）。
  runInAction(() => { touchedInside.opening.subType = 'door'; touchedOutside.opening.subType = 'door'; });

  const exteriorDir = 1; // Wall.faceDir: axisValue(75) - axisCL.effectiveValue(0) = +75 → +1（室外側）
  assert.equal(doorOpenSidePerp(touchedInside.opening, wallA, graphA), exteriorDir, '室内側(y=-500)を触れても室外側へ開くはず');
  assert.equal(doorOpenSidePerp(touchedOutside.opening, wallB, graphB), exteriorDir, '室外側(y=500)を触れても室外側へ開くはず');
});

// ---- swingSideの既定値: 外壁境界は「境界の反対側の壁」を見て判定する（回帰） ----
// .claude/opening-model.md「1つの境界にWallは2枚」参照: 建物外周は室内向き壁(isExteriorWall:false)と
// 外向きの外壁(isExteriorWall:true)の2枚で構成される。壁ラジアルのヒット域限定により実運用では
// 室内向き壁がホストになる主要経路——host単体のisExteriorWallだけを見ると常にfalseになり
// 「外壁の開き戸は外開き」が効かないバグの回帰テスト。
function makeExteriorBoundaryGraph(length = 3000) {
  const graph = makePlaneGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,      { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,      { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   length, { labeled: false, discipline: Discipline.ARCH });
  const innerWall = graph.addWall(axisCL, 75,  false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  const outerWall = graph.addWall(axisCL, -75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  return { graph, innerWall, outerWall };
}

test('【回帰】placeOpeningWithDefaults: 室内向き壁(isExteriorWall:false)をホストにしても、外壁境界なら室外側へ開く', () => {
  const { graph, innerWall } = makeExteriorBoundaryGraph();
  const project = makeProject();
  // innerWall自身の部屋側(y>75)を長押ししたと仮定。
  const { opening, error } = placeOpeningWithDefaults(graph, project, innerWall, { x: 1500, y: 200 }, OpeningCategory.FITTING);
  assert.equal(error, null);
  assert.equal(opening.subType, 'singleSwing', '内壁のFITTING既定はSWING機構(singleSwing)のはず');

  const exteriorDir = -1; // outerWall: axisValue(-75) - axisCL.effectiveValue(0) = -75 → -1（室外側）
  assert.equal(
    doorOpenSidePerp(opening, innerWall, graph), exteriorDir,
    '室内向き壁をホストにしても、境界の反対側の外壁(outerWall)の面が向く側（室外側）へ開くはず',
  );
});

test('placeOpeningWithDefaults: 外壁本体(isExteriorWall:true)をホストにしても室外側へ開く（従来どおり）', () => {
  const { graph, outerWall } = makeExteriorBoundaryGraph();
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, outerWall, { x: 1500, y: -200 }, OpeningCategory.FITTING);
  assert.equal(error, null);
  runInAction(() => { opening.subType = 'door'; }); // 外壁既定(sliding)はSWINGでないため測定用にSWINGへ変える

  const exteriorDir = -1;
  assert.equal(doorOpenSidePerp(opening, outerWall, graph), exteriorDir, '外壁本体をホストにしても室外側へ開くはず');
});

test('placeOpeningWithDefaults: 内壁同士の境界（両方isExteriorWall:false）はホスト壁が面する側へ開く', () => {
  const graph = makePlaneGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const wallA = graph.addWall(axisCL, 75,  false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  graph.addWall(axisCL, -75, false, clStart, 0, clEnd, 0, { isExteriorWall: false }); // 隣室側の壁（障害物のみ）
  const project = makeProject();

  const { opening, error } = placeOpeningWithDefaults(graph, project, wallA, { x: 1500, y: 200 }, OpeningCategory.FITTING);
  assert.equal(error, null);
  assert.equal(doorOpenSidePerp(opening, wallA, graph), 1, 'wallAの面が向く側(+1)へ開くはず（外壁境界ではないので触れた側どおり）');
});

// ---- swingSideの既定値: 長押し位置がちょうど壁面(axisValue)上（失敗経路）----
test('【失敗系】placeOpeningWithDefaults: 長押し位置がちょうどaxisValue上(sign=0)でもswingSideは±1のいずれか（0/NaNにならない）', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: false }); // axisValue=75
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 75 }, OpeningCategory.FITTING);
  assert.equal(error, null);
  assert.ok(opening.swingSide === 1 || opening.swingSide === -1, `swingSideは±1のはず（実際: ${opening.swingSide}）`);
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

// ---- placeOpeningWithDefaults: subType指定で三方枠を配置できる ----
test('placeOpeningWithDefaults: subType="threeSidedFrame"を指定すると三方枠(WF・木製・備考なし)が配置される', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: false }); // 内壁
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 75 }, OpeningCategory.FITTING, 'threeSidedFrame');
  assert.equal(error, null);
  assert.equal(opening.subType, 'threeSidedFrame');
  assert.equal(opening.fixtureType, 'WF');
  assert.equal(opening.materialGlass, defaultMaterialGlassFor('WF'));
  assert.equal(opening.note, null, 'FRAME_ONLYはSWINGではないためレバーハンドルは入らない');
  assert.equal(opening.frameFaceWidth, 20, '見付の初期値20を配置時に明示保存する');
  assert.equal(opening.frameProjection, 12, '出幅の初期値12を配置時に明示保存する');
});

test('placeOpeningWithDefaults: 三方枠以外（既定の片開き戸）では見付・出幅はnullのまま', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: false });
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 75 }, OpeningCategory.FITTING);
  assert.equal(error, null);
  assert.equal(opening.subType, 'singleSwing');
  assert.equal(opening.frameFaceWidth, null);
  assert.equal(opening.frameProjection, null);
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

// ---- 種別（機構）変更時の建具記号の差し替え規則 ----
test('fixtureTypeAfterSubTypeChange: WD→三方枠 は WF へ差し替わる', () => {
  assert.equal(fixtureTypeAfterSubTypeChange('WD', 'fitting', 'interior', OpeningMechanism.FRAME_ONLY), 'WF');
});

test('fixtureTypeAfterSubTypeChange: WF→片開き戸(SWING) は WD へ差し替わる', () => {
  assert.equal(fixtureTypeAfterSubTypeChange('WF', 'fitting', 'interior', OpeningMechanism.SWING), 'WD');
});

test('fixtureTypeAfterSubTypeChange: AD→三方枠 は wallKind不問で WF へ差し替わる', () => {
  assert.equal(fixtureTypeAfterSubTypeChange('AD', 'fitting', 'exterior', OpeningMechanism.FRAME_ONLY), 'WF');
});

test('fixtureTypeAfterSubTypeChange: 片開き戸(SWING)→引き戸(SLIDE_SINGLE) は記号を維持する（どちらもスコープ無し）', () => {
  assert.equal(fixtureTypeAfterSubTypeChange('WD', 'fitting', 'interior', OpeningMechanism.SLIDE_SINGLE), 'WD');
});

// ---- ステップ12e: ライブラリに無い（未知）記号は種別変更でも黙って差し替えない ----
test('fixtureTypeAfterSubTypeChange: ライブラリに無い記号（未知。QX）は種別変更でも保持する', () => {
  assert.equal(fixtureTypeAfterSubTypeChange('QX', 'fitting', 'interior', OpeningMechanism.FRAME_ONLY), 'QX');
});

test('fixtureTypeAfterSubTypeChange: 未知記号のまま三方枠から通常種別へ戻しても保持する', () => {
  assert.equal(fixtureTypeAfterSubTypeChange('QX', 'fitting', 'interior', OpeningMechanism.SWING), 'QX');
});

// ---- ステップ12e: 記号selectの選択肢一覧（fixtureSymbolOptions）----
test('fixtureSymbolOptions: 現在の記号が絞り込みに含まれていれば追加なしでgetFixtureSymbolsの結果をそのまま返す', () => {
  const opts = fixtureSymbolOptions('fitting', undefined, 'WD');
  assert.deepEqual(opts, getFixtureSymbols('fitting', undefined));
});

test('fixtureSymbolOptions: 現在の記号がライブラリに無い（未知。QX）なら先頭に「（不明）」付きで1件追加する', () => {
  const scoped = getFixtureSymbols('fitting', undefined);
  const opts = fixtureSymbolOptions('fitting', undefined, 'QX');
  assert.equal(opts.length, scoped.length + 1);
  assert.deepEqual(opts[0], { key: 'QX', label: '（不明）QX', unknown: true });
  assert.deepEqual(opts.slice(1), scoped);
});

test('fixtureSymbolOptions: 現在の記号がライブラリにはあるが別スコープ（三方枠専用WFを通常機構で）なら先頭にoutOfScopeで1件追加する', () => {
  const scoped = getFixtureSymbols('fitting', OpeningMechanism.SWING);
  const opts = fixtureSymbolOptions('fitting', OpeningMechanism.SWING, 'WF');
  assert.equal(opts.length, scoped.length + 1);
  assert.deepEqual(opts[0], { key: 'WF', label: 'WF（木製三方枠）', outOfScope: true });
  assert.deepEqual(opts.slice(1), scoped);
});

test('fixtureSymbolOptions: 現在の記号が未設定(null)なら追加なしでgetFixtureSymbolsの結果をそのまま返す', () => {
  const opts = fixtureSymbolOptions('window', undefined, null);
  assert.deepEqual(opts, getFixtureSymbols('window', undefined));
});

// ---- placeOpeningWithDefaults: 建具(fitting)×SWING機構で備考欄に「レバーハンドル」が自動設定される ----
test('placeOpeningWithDefaults: 建具×SWING機構で配置すると備考「レバーハンドル」が入る', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: false }); // 内壁 → 片開き戸(SWING)が既定
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 75 }, OpeningCategory.FITTING);
  assert.equal(error, null);
  assert.equal(opening.note, 'レバーハンドル');
});

test('placeOpeningWithDefaults: 窓を配置しても備考欄は自動設定されない（null）', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 0 }, OpeningCategory.WINDOW);
  assert.equal(error, null);
  assert.equal(opening.note, null);
});

// ---- 備考欄の種別（機構）変更時の差し替え規則 ----
test('noteAfterSubTypeChange: 建具(fitting)で現在値が未編集(null)でSWINGへ変わるとレバーハンドルが入る', () => {
  assert.equal(
    noteAfterSubTypeChange(null, OpeningCategory.FITTING, OpeningMechanism.SLIDE_SINGLE, OpeningMechanism.SWING),
    'レバーハンドル',
  );
});

test('noteAfterSubTypeChange: 建具(fitting)で現在値が旧機構の初期値のままならSWING→引戸で外れてnullへ戻る', () => {
  const current = 'レバーハンドル'; // SWINGの初期値＝未編集
  assert.equal(
    noteAfterSubTypeChange(current, OpeningCategory.FITTING, OpeningMechanism.SWING, OpeningMechanism.SLIDE_SINGLE),
    null,
  );
});

test('noteAfterSubTypeChange: 建具(fitting)でユーザーが編集済みの値は機構変更後も維持する', () => {
  const edited = 'サムターン付きレバーハンドル'; // 初期値と異なる＝編集済み
  assert.equal(
    noteAfterSubTypeChange(edited, OpeningCategory.FITTING, OpeningMechanism.SWING, OpeningMechanism.SLIDE_SINGLE),
    edited,
  );
});

// ---- QA指摘1: 窓カテゴリはSWING機構（開き窓等）でも常にnull——FIX→開き窓で誤ってレバーハンドルが入らない ----
test('noteAfterSubTypeChange: 窓(window)はFIX→SWING(開き窓)に変わっても備考はnullのまま（fittingと違い金物の既定値を持たない）', () => {
  assert.equal(
    noteAfterSubTypeChange(null, OpeningCategory.WINDOW, OpeningMechanism.FIXED, OpeningMechanism.SWING),
    null,
  );
});

// ---- QA指摘2: 窓で編集済みの備考は種別変更後も維持される ----
test('noteAfterSubTypeChange: 窓(window)で編集済みの備考は種別変更後も維持される', () => {
  const edited = '網戸付き';
  assert.equal(
    noteAfterSubTypeChange(edited, OpeningCategory.WINDOW, OpeningMechanism.FIXED, OpeningMechanism.SWING),
    edited,
  );
});

// ---- Finding 1 回帰: validateOpeningEdit の検証（resolveRefOffsetEdit の範囲が引けないときのフォールバックが依拠） ----
// onEditDim の幅編集はもはや validateOpeningEdit を使わない（NGで弾く代わりに maxOpeningWidthAt で
// クランプする仕様に変更済み——openingGeometry.test.js 参照）。位置（refOffset）の編集も 2026-09-14 から
// 可動範囲へのクランプ（resolveRefOffsetEdit）が主経路になったが、範囲が引けないケースの弾きに
// validateOpeningEdit を今も使うため、検証関数そのものの正しさはここで確認する。
test('【Finding 1 回帰】validateOpeningEdit: 壁長2000mmに幅5000mmはNGを返す', () => {
  const { graph, wall } = makeWallGraph(2000);
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});

  const err = validateOpeningEdit(opening, graph, { width: 5000, refOffset: opening.refOffset });
  assert.ok(err, '壁長2000mmを超える幅5000mmはNGのはず');
  assert.equal(opening.width, 800, 'validateOpeningEditは検証のみで代入しない（呼び出し側が結果に応じて代入する前提）');
});

// ---- resolveRefOffsetEdit: 位置欄は可動範囲の端へクランプ＋メッセージ（ユーザー裁定 2026-09-14） ----
test('resolveRefOffsetEdit: 範囲内はそのまま・メッセージなし', () => {
  const { graph, wall } = makeWallGraph(3000);
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  assert.deepEqual(resolveRefOffsetEdit(opening, graph, 1500), { value: 1500, message: null });
});

test('resolveRefOffsetEdit: 範囲外は端へクランプし、範囲を含むメッセージを返す（弾かない）', () => {
  const { graph, wall } = makeWallGraph(3000);
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 2700, 400, OpeningCategory.FITTING, 'singleSwing', {}); // 2500..2900
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  // 範囲 400..2100（hi側は隣接開口の coord1=2500 − 半幅400）
  const r = resolveRefOffsetEdit(opening, graph, 9999);
  assert.equal(r.value, 2100);
  assert.match(r.message, /400〜2100/);
  assert.equal(resolveRefOffsetEdit(opening, graph, 0).value, 400);
  assert.equal(opening.refOffset, 1000, 'resolveRefOffsetEdit は判定のみで代入しない');
});

test('【失敗系】resolveRefOffsetEdit: 隣接開口に覆われて範囲が引けない（不正データ）は value:null＋重なりエラーで弾く', () => {
  const { graph, wall } = makeWallGraph(3000);
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1500, 3000, OpeningCategory.FITTING, 'singleSwing', {}); // 壁全面
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  assert.deepEqual(resolveRefOffsetEdit(opening, graph, 1000), { value: null, message: ERR_OPENING_OVERLAP });
});

test('【失敗系】resolveRefOffsetEdit: NaN/Infinity は value:null（前値へ戻す）で refOffset に流さない', () => {
  const { graph, wall } = makeWallGraph(3000);
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  assert.deepEqual(resolveRefOffsetEdit(opening, graph, NaN), { value: null, message: null });
  assert.deepEqual(resolveRefOffsetEdit(opening, graph, Infinity), { value: null, message: null });
});

test('【失敗系】resolveRefOffsetEdit: ホスト壁が引けない開口は制約なし（そのまま通す）', () => {
  const { graph, wall } = makeWallGraph(3000);
  const otherAxis = graph.addCenterLine(CenterLineType.HORIZONTAL, 5000, { labeled: false, discipline: Discipline.ARCH });
  const opening = graph.addOpening(otherAxis, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  assert.deepEqual(resolveRefOffsetEdit(opening, graph, 12345), { value: 12345, message: null });
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

// ================================================================
// swingSide既定値の機構による反転（.claude/opening-model.md、窓・扉バリエーション追加 §5）
// ================================================================

// ---- openDirForMechanism: 内開き系機構(SWING_IN/DREH_KIPP)は開き方向を反転する ----
test('openDirForMechanism: SWING_IN / DREH_KIPP は openDir を反転する', () => {
  assert.equal(openDirForMechanism(1, OpeningMechanism.SWING_IN), -1);
  assert.equal(openDirForMechanism(-1, OpeningMechanism.SWING_IN), 1);
  assert.equal(openDirForMechanism(1, OpeningMechanism.DREH_KIPP), -1);
});

test('openDirForMechanism: それ以外の機構（SWING等）は openDir をそのまま返す', () => {
  assert.equal(openDirForMechanism(1, OpeningMechanism.SWING), 1);
  assert.equal(openDirForMechanism(-1, OpeningMechanism.FIXED), -1);
});

// ================================================================
// defaultSwingSideFor / swingSideAfterSubTypeChange（QA2巡目B・C）
// swingSide既定値の唯一の定義箇所。placeOpeningWithDefaults・OpeningEditor.jsx onSubTypeChange の
// 両方がこれを呼ぶ（二重定義しない）。
// ================================================================

// ---- 【QA指定テスト4】外壁: SWINGは室外側(faceDir)、SWING_IN/DREH_KIPPは室内側(faceDirの逆) ----
test('defaultSwingSideFor: 外壁はSWINGが室外側、SWING_IN/DREH_KIPPは室内側（faceDirの逆）へ開く', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: true, axisOffset: 75 }); // faceDir=+1
  const centerCoord = 1500;
  assert.equal(defaultSwingSideFor(wall, graph, centerCoord, -1, OpeningMechanism.SWING), 1, 'SWINGは室外側(faceDir=+1)へ開くはず');
  assert.equal(defaultSwingSideFor(wall, graph, centerCoord, -1, OpeningMechanism.SWING_IN), -1, 'SWING_INは室内側(faceDirの逆)へ開くはず');
  assert.equal(defaultSwingSideFor(wall, graph, centerCoord, -1, OpeningMechanism.DREH_KIPP), -1, 'DREH_KIPPは室内側(faceDirの逆)へ開くはず');
});

// ---- 【QA指定テスト5・失敗系】屋内境界（exteriorSideDirがnullを返す）はfaceDirへフォールバック ----
// exteriorSideDirは「反対側の壁が無い、または反対側も非外壁」でnullを返す（openingGeometry.test.js
// 参照）。ここでは対向壁の無い孤立した内壁でその条件を再現する。
test('【失敗系】defaultSwingSideFor: 屋内境界（exteriorSideDirがnull）はhost.faceDirへフォールバックする', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: false, axisOffset: 75 }); // faceDir=+1, 対向壁なし
  const centerCoord = 1500;
  assert.equal(defaultSwingSideFor(wall, graph, centerCoord, -1, OpeningMechanism.SWING), wall.faceDir);

  const { graph: graphB, wall: wallB } = makeWallGraph(3000, { isExteriorWall: false, axisOffset: -75 }); // faceDir=-1
  assert.equal(defaultSwingSideFor(wallB, graphB, centerCoord, -1, OpeningMechanism.SWING), wallB.faceDir);
  assert.notEqual(wall.faceDir, wallB.faceDir, 'faceDirが壁ごとに違う（=本当にfaceDir依存のフォールバックであることの裏付け）');
});

// ---- 【QA指定テスト6】種別変更: 未編集なら新既定へ差し替え・手動反転済みなら維持 ----
test('swingSideAfterSubTypeChange: 現在値が旧機構の既定のまま（未編集）なら新機構の既定へ差し替える', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: true, axisOffset: 75 });
  const centerCoord = 1500, hingeSide = -1;
  const oldDefault = defaultSwingSideFor(wall, graph, centerCoord, hingeSide, OpeningMechanism.SWING);
  const newDefault = defaultSwingSideFor(wall, graph, centerCoord, hingeSide, OpeningMechanism.SWING_IN);
  const result = swingSideAfterSubTypeChange(oldDefault, wall, graph, centerCoord, hingeSide, OpeningMechanism.SWING, OpeningMechanism.SWING_IN);
  assert.equal(result, newDefault, '未編集なら新機構の既定(室内側)へ差し替わるはず');
  assert.notEqual(result, oldDefault, '新旧既定は実際に異なるはず（テストの前提確認）');
});

test('swingSideAfterSubTypeChange: 手動で「開く方向反転」した値（旧既定と異なる）は種別変更後も維持する', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: true, axisOffset: 75 });
  const centerCoord = 1500, hingeSide = -1;
  const oldDefault = defaultSwingSideFor(wall, graph, centerCoord, hingeSide, OpeningMechanism.SWING);
  const manuallyFlipped = -oldDefault; // ユーザーが「開く方向反転」ボタンで反転した状態を模す
  const result = swingSideAfterSubTypeChange(manuallyFlipped, wall, graph, centerCoord, hingeSide, OpeningMechanism.SWING, OpeningMechanism.SWING_IN);
  assert.equal(result, manuallyFlipped, '手動編集済みの値は種別変更後も維持されるはず（新既定に上書きされない）');
});

// ---- placeOpeningWithDefaults: 配置entryの機構がSWING_IN/DREH_KIPPなら室内側(faceDirの逆)へ開く ----
// placeOpeningWithDefaults は常に catalog[0]（各カテゴリ・壁種別の先頭エントリ）を配置するため、
// 実際の初期配置でSWING_IN/DREH_KIPPが選ばれる経路は無い（配置後にonSubTypeChangeで選び直す）。
// ここではFITTING_CATALOGを一時的に空にしてカタログ欠如を再現する既存テスト（本ファイル上部）と
// 同じ手法で、WINDOW_CATALOG先頭を一時的にSWING_IN機構へ差し替えて既定値計算そのものを検証する。
// hingeSideは常に-1（placeOpeningWithDefaultsの固定既定）で水平壁のため、
// swingSideTowardPerp(false, -1, openDir) = openDir と一致する（openingGeometry.js）。
// 通常機構（openDir=faceDir=+1）との対比で、SWING_INのみ符号が反転することを確認する。
test('placeOpeningWithDefaults: 配置entryの機構がSWING_INなら外壁でも室内側(faceDirの逆)へ開く', () => {
  const inswingEntry = findCatalogEntry(OpeningCategory.WINDOW, 'inswing');
  assert.ok(inswingEntry, 'inswingエントリが存在する前提');

  // 対照: 通常機構(先頭=doubleSliding, faceDir=+1)を同条件の壁に配置した場合のswingSide。
  const { graph: graphCtrl, wall: wallCtrl } = makeWallGraph(3000, { isExteriorWall: true, axisOffset: 75 });
  const control = placeOpeningWithDefaults(graphCtrl, makeProject(), wallCtrl, { x: 1500, y: -500 }, OpeningCategory.WINDOW);
  assert.equal(control.error, null);
  assert.equal(control.opening.swingSide, 1, '通常機構はfaceDir(+1)どおりswingSide=1のはず');

  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: true, axisOffset: 75 }); // faceDir=+1（外壁は常に室外=faceDir側へ開く既定）
  const project = makeProject();
  // 注意（ステップ10c）: 直接変更は findCatalogEntry（メモ化）には追従しない（上の FITTING_CATALOG.splice の注記参照）。
  const saved = WINDOW_CATALOG.splice(0, WINDOW_CATALOG.length);
  try {
    WINDOW_CATALOG.push(inswingEntry, ...saved.filter(e => e.key !== 'inswing'));
    const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: -500 }, OpeningCategory.WINDOW);
    assert.equal(error, null);
    assert.equal(opening.subType, 'inswing');
    assert.equal(opening.hingeSide, -1);
    assert.equal(opening.swingSide, -1, 'SWING_INは外壁でもfaceDir(+1)の逆=室内側(swingSide=-1)へ開くはず');
  } finally {
    WINDOW_CATALOG.splice(0, WINDOW_CATALOG.length, ...saved);
  }
});

// ---- 種別変更（differing mechanismへの差し替え）が新機構でも壊れないことの回帰 ----
test('【回帰】新機構(SWING_DOUBLE)へsubTypeを変更してもfindCatalogEntry/validateOpeningEdit/renumberOpeningsが例外を出さない', () => {
  const { graph, wall } = makeWallGraph(3000, { isExteriorWall: true });
  const project = makeProject();
  const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: -500 }, OpeningCategory.FITTING);
  assert.equal(error, null);

  assert.doesNotThrow(() => {
    runInAction(() => { opening.subType = 'doubleSwing'; opening.width = 1600; });
  });
  const entry = findCatalogEntry(opening.category, opening.subType);
  assert.equal(entry?.mechanism, OpeningMechanism.SWING_DOUBLE);

  assert.equal(validateOpeningEdit(opening, graph, { width: opening.width, refOffset: opening.refOffset }), null);
  assert.doesNotThrow(() => runInAction(() => renumberOpenings(graph, project)));
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

// ================================================================
// 「吊元反転」ボタン（flippedHingeSides）——吊元だけを移し、開く面は維持する
// ================================================================

// 平面記号が実際に開く直交方向（perp。isVertical壁ならx、水平壁ならy）の符号。
// openings/openingPlanSymbol.js swingLeafPrimitives と同じ経路（closedAngleFor → leafOpenAngle → angleVectors）
// で求める——「hingeSide/swingSideの積」ではなく描画結果の向きで検証する。
function openPerpSign(isVertical, hingeSide, swingSide) {
  const closed = closedAngleFor(isVertical, hingeSide);
  const { dir } = angleVectors(leafOpenAngle(closed, swingSide));
  const perp = isVertical ? dir.x : dir.y;
  return Math.sign(Math.round(perp));
}

test('flippedHingeSides: 吊元は反対の枠端へ移り、扉が開く面（perp方向）は変わらない（全4通り×縦横壁）', () => {
  for (const isVertical of [false, true]) {
    for (const hingeSide of [-1, 1]) {
      for (const swingSide of [-1, 1]) {
        const before = { hingeSide, swingSide };
        const after = flippedHingeSides(before);
        assert.equal(after.hingeSide, -hingeSide, '吊元は反対の枠端へ移るはず');
        assert.equal(
          openPerpSign(isVertical, after.hingeSide, after.swingSide),
          openPerpSign(isVertical, before.hingeSide, before.swingSide),
          `開く面（壁のどちらの面へ開くか）は維持されるはず (isVertical=${isVertical}, hingeSide=${hingeSide}, swingSide=${swingSide})`,
        );
      }
    }
  }
});

test('回帰: hingeSideだけを反転すると開く面が裏返る（修正前の不具合。flippedHingeSidesが防ぐ差分）', () => {
  const before = { hingeSide: -1, swingSide: 1 };
  const naive = { hingeSide: 1, swingSide: 1 }; // 修正前のボタン処理
  assert.notEqual(
    openPerpSign(false, naive.hingeSide, naive.swingSide),
    openPerpSign(false, before.hingeSide, before.swingSide),
    '前提: hingeSideのみの反転は開く面を裏返す（これが不具合）',
  );
  assert.notEqual(flippedHingeSides(before).swingSide, naive.swingSide, 'flippedHingeSidesはswingSideも反転して面を保つはず');
});

// ================================================================
// geometryListener（setOpeningGeometryListener）: 建具の確定・undo/redo直後に自階の構造を
// 再計算する依存注入フック（openingStructuralSync.js）の呼び出し回数を検証する。
// ここでは構造モジュールを一切importせず、スパイ関数だけを注入する（openingEdit.jsは
// 構造モジュールのrecompute判定・起動を行わない——呼ばれるかどうかだけがこのファイルの関心）。
// ================================================================

test('setOpeningGeometryListener: placeOpeningWithDefaults→undo→redoで各1回、計3回呼ばれる', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const calls = [];
  setOpeningGeometryListener((g, p) => calls.push([g, p]));
  try {
    const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 0 }, OpeningCategory.WINDOW);
    assert.equal(error, null);
    assert.equal(calls.length, 1, '配置確定直後に1回');

    undoManager.undo();
    assert.equal(calls.length, 2, 'undoで1回追加');

    undoManager.redo();
    assert.equal(calls.length, 3, 'redoで1回追加');
    assert.ok(calls.every(([g, p]) => g === graph && p === project), '常に(graph, project)で呼ばれる');
    void opening;
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('setOpeningGeometryListener: removeOpeningWithUndo→undo→redoで各1回、計3回呼ばれる', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  let calls = 0;
  setOpeningGeometryListener(() => { calls++; });
  try {
    removeOpeningWithUndo(graph, project, opening);
    assert.equal(calls, 1, '削除確定直後に1回');

    undoManager.undo();
    assert.equal(calls, 2, 'undo（復元）で1回追加');

    undoManager.redo();
    assert.equal(calls, 3, 'redo（再削除）で1回追加');
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('setOpeningGeometryListener: widthの変更（withOpeningUndo）は確定・undo・redoで各1回、計3回呼ばれる', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  let calls = 0;
  setOpeningGeometryListener(() => { calls++; });
  try {
    withOpeningUndo(graph, project, opening, () => { runInAction(() => { opening.width = 1200; }); });
    assert.equal(calls, 1, '幅変更の確定直後に1回');

    undoManager.undo();
    assert.equal(calls, 2);

    undoManager.redo();
    assert.equal(calls, 3);
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('【失敗系】setOpeningGeometryListener: noteだけの変更は構造に無関係のため確定・undo・redoとも0回', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  let calls = 0;
  setOpeningGeometryListener(() => { calls++; });
  try {
    withOpeningUndo(graph, project, opening, () => { runInAction(() => { opening.note = '網戸付き'; }); });
    assert.equal(calls, 0, 'note変更の確定直後は呼ばれない');

    undoManager.undo();
    assert.equal(calls, 0, 'undoでも呼ばれない（openingGeometryChangedの判定は積むとき1回で確定・以後固定）');

    undoManager.redo();
    assert.equal(calls, 0, 'redoでも呼ばれない');
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('【失敗系】setOpeningGeometryListener: listener未設定（null）でも例外を投げずに動作する', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  setOpeningGeometryListener(null);
  assert.doesNotThrow(() => {
    const { opening } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 0 }, OpeningCategory.WINDOW);
    withOpeningUndo(graph, project, opening, () => { runInAction(() => { opening.width = 900; }); });
    removeOpeningWithUndo(graph, project, opening);
    undoManager.undo();
  });
});

test('setOpeningGeometryListener: refOffsetの移動（pushOpeningUndo経路）は確定・undo・redoで各1回、計3回呼ばれる', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  let calls = 0;
  setOpeningGeometryListener(() => { calls++; });
  try {
    const before = snapshotOpening(opening);
    runInAction(() => { opening.refOffset = 1500; });
    const cmd = pushOpeningUndo(graph, project, opening, before);
    assert.ok(cmd, '差分があるので積まれるはず');
    assert.equal(calls, 1, 'refOffset移動の確定直後に1回');

    undoManager.undo();
    assert.equal(calls, 2);

    undoManager.redo();
    assert.equal(calls, 3);
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('【失敗系】setOpeningGeometryListener: placeOpeningWithDefaultsが検証エラー（既存開口との重なり）を返したらlistenerは0回', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  // 壁3000mm全体を占有する既存開口（placeOpeningWithDefaultsのERR_OPENING_OVERLAP回帰テストと同じ配置）。
  graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1500, 3000, OpeningCategory.WINDOW, 'doubleSliding', {});
  let calls = 0;
  setOpeningGeometryListener(() => { calls++; });
  try {
    const { opening, error } = placeOpeningWithDefaults(graph, project, wall, { x: 1500, y: 0 }, OpeningCategory.WINDOW);
    assert.equal(opening, null);
    assert.equal(error, ERR_OPENING_OVERLAP);
    assert.equal(calls, 0, '配置に失敗（opening:null）した場合はlistenerを呼ばないはず');
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('【失敗系】setOpeningGeometryListener: pushOpeningUndoが差分なし（before===after）を検知した場合はlistenerを呼ばない', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  let calls = 0;
  setOpeningGeometryListener(() => { calls++; });
  try {
    const before = snapshotOpening(opening);
    // 何も変更しないまま積む（JSON比較で差分なし＝pushOpeningUndoがnullを返す早期returnパス）。
    const cmd = pushOpeningUndo(graph, project, opening, before);
    assert.equal(cmd, null, '差分が無いので積まれないはず');
    assert.equal(calls, 0, '差分なしのためlistenerは呼ばれないはず');
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('setOpeningGeometryListener: beginOpeningFieldUndo/endOpeningFieldUndoはrefOffset変更で1回、height変更のみでは0回', () => {
  const { graph, wall } = makeWallGraph(3000);
  const project = makeProject();
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});
  let calls = 0;
  setOpeningGeometryListener(() => { calls++; });
  try {
    beginOpeningFieldUndo(graph, project, opening);
    runInAction(() => { opening.refOffset = 1300; });
    endOpeningFieldUndo(graph, project, opening);
    assert.equal(calls, 1, 'refOffset変更（構造に影響しうる）は1回呼ばれるはず');

    beginOpeningFieldUndo(graph, project, opening);
    runInAction(() => { opening.height = 1800; });
    endOpeningFieldUndo(graph, project, opening);
    assert.equal(calls, 1, 'height変更のみ（構造に無関係）は増えないはず');
  } finally {
    setOpeningGeometryListener(null);
  }
});

test('flippedSwingSide: 開く面だけを裏返し、吊元（hingeSide）には触れない', () => {
  const opening = { hingeSide: -1, swingSide: 1 };
  assert.equal(flippedSwingSide(opening), -1);
  assert.equal(opening.hingeSide, -1, '吊元は呼び出しで変化しないはず');
  assert.equal(
    openPerpSign(false, opening.hingeSide, flippedSwingSide(opening)),
    -openPerpSign(false, opening.hingeSide, opening.swingSide),
    '開く面は裏返るはず',
  );
});
