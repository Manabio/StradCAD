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
import { ERR_OPENING_OUT_OF_WALL, ERR_OPENING_OVERLAP } from '../error.js';
import { openingTagOf, renumberOpenings } from './openingNumbering.js';
import { openingTagAnchor } from './openingTagPlacement.js';
import {
  placeOpeningWithDefaults, removeOpeningWithUndo, withOpeningUndo, pushOpeningUndo, snapshotOpening,
  materialGlassAfterFixtureChange, validateOpeningEdit,
} from './openingEdit.js';

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

// ---- Finding 1 回帰: validateOpeningEdit の検証（OpeningEditor.jsx onOffsetBlur の位置編集ガードが依拠） ----
// onEditDim の幅編集はもはや validateOpeningEdit を使わない（NGで弾く代わりに maxOpeningWidthAt で
// クランプする仕様に変更済み——openingGeometry.test.js 参照）。validateOpeningEdit 自体は
// onOffsetBlur（位置=refOffset の編集）のガードとして今も使われているため、検証関数そのものの
// 正しさはここで確認する。
test('【Finding 1 回帰】validateOpeningEdit: 壁長2000mmに幅5000mmはNGを返す', () => {
  const { graph, wall } = makeWallGraph(2000);
  const opening = graph.addOpening(wall.axisCL, 1, false, wall.clStart, 1000, 800, OpeningCategory.FITTING, 'singleSwing', {});

  const err = validateOpeningEdit(opening, graph, { width: 5000, refOffset: opening.refOffset });
  assert.ok(err, '壁長2000mmを超える幅5000mmはNGのはず');
  assert.equal(opening.width, 800, 'validateOpeningEditは検証のみで代入しない（呼び出し側が結果に応じて代入する前提）');
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
